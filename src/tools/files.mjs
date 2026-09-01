import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  resolveApprovedPath,
  findRoot,
  canonicalBridgeReservedPaths,
  isProtectedPath,
  isPathInBridgeReservedPaths,
  isReservedBridgePath,
  safeChildEnvironment,
} from '../security.mjs';
import { randomId, truncateUtf8 } from '../utils.mjs';

const DEFAULT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);

function appearsBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

async function collectFiles(directory, config, root, rootReal, canonicalReserved, output, limit) {
  if (output.length >= limit) return;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (output.length >= limit) return;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root.path, absolute).split(path.sep).join('/');
    const canonicalAbsolute = path.resolve(rootReal, relative.split('/').join(path.sep));
    if (isReservedBridgePath(config, absolute)
      || isPathInBridgeReservedPaths(canonicalAbsolute, canonicalReserved)
      || isProtectedPath(root, relative)
      || isProtectedPath(root, `${relative}/placeholder`)) continue;
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      await collectFiles(absolute, config, root, rootReal, canonicalReserved, output, limit);
    } else if (entry.isFile()) output.push(relative);
  }
}

function boundedCollector(maximumBytes) {
  return {
    chunks: [],
    bytes: 0,
    truncated: false,
    push(chunk) {
      const value = Buffer.from(chunk);
      const remaining = maximumBytes - this.bytes;
      if (remaining > 0) {
        const kept = value.subarray(0, remaining);
        this.chunks.push(kept);
        this.bytes += kept.length;
      }
      if (value.length > Math.max(remaining, 0)) this.truncated = true;
    },
    text() { return Buffer.concat(this.chunks).toString('utf8'); },
  };
}

function gitEnvironment(config) {
  const inherited = safeChildEnvironment({}, config);
  const environment = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (typeof inherited[name] === 'string') environment[name] = inherited[name];
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  };
}

function runGit(config, cwd, args, maximumBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '--literal-pathspecs', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnvironment(config),
    });
    const stdout = boundedCollector(maximumBytes);
    const stderr = boundedCollector(Math.min(maximumBytes, 64 * 1024));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('git diff timed out'));
      if (code !== 0) return reject(new Error(stderr.text() || `git diff exited with ${code}`));
      resolve({ stdout: stdout.text(), truncated: stdout.truncated });
    });
  });
}

function countOccurrences(text, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let position = 0;
  while ((position = text.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

async function writeAtomic(file, content, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomId('tmp_')}`;
  await fs.writeFile(temporary, content, { mode });
  await fs.rename(temporary, file);
}

export class FileTools {
  constructor(config, redactor = (value) => String(value ?? ''), options = {}) {
    this.config = config;
    this.redactor = redactor;
    this.writeLocks = new Map();
    this.beforeCommit = options.beforeCommit;
  }

  listRoots() {
    return this.config.roots.map((root) => ({ id: root.id, readOnly: root.readOnly }));
  }

  async listFiles(input) {
    if (!this.config.permissions.read) throw new Error('File reads are disabled');
    const root = findRoot(this.config, input.rootId);
    const files = [];
    const [rootReal, canonicalReserved] = await Promise.all([
      fs.realpath(root.path),
      canonicalBridgeReservedPaths(this.config),
    ]);
    await collectFiles(
      root.path,
      this.config,
      root,
      rootReal,
      canonicalReserved,
      files,
      Math.min(Number(input.limit ?? 500), 5000),
    );
    return { rootId: root.id, files, truncated: files.length >= Number(input.limit ?? 500) };
  }

  async readFile(input) {
    if (!this.config.permissions.read) throw new Error('File reads are disabled');
    const resolved = await resolveApprovedPath(this.config, input.rootId, input.path, { mustExist: true });
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) throw new Error('Requested path is not a regular file');
    if (stat.size > this.config.limits.maxReadBytes) throw new Error(`File exceeds read limit of ${this.config.limits.maxReadBytes} bytes`);
    const buffer = await fs.readFile(resolved.absolutePath);
    if (appearsBinary(buffer)) throw new Error('Binary file reads are disabled to prevent unredacted credential disclosure');
    return {
      rootId: input.rootId,
      path: resolved.relativePath,
      bytes: buffer.length,
      encoding: 'utf8',
      content: this.redactor(buffer.toString('utf8')),
    };
  }

  async search(input) {
    if (!this.config.permissions.read) throw new Error('File reads are disabled');
    const root = findRoot(this.config, input.rootId);
    const query = String(input.query ?? '');
    if (!query) throw new Error('query is required');
    if (query.length > 1000) throw new Error('query is too long');
    const caseSensitive = Boolean(input.caseSensitive);
    const needle = caseSensitive ? query : query.toLowerCase();
    const maxResults = Math.min(Number(input.maxResults ?? this.config.limits.maxSearchResults), this.config.limits.maxSearchResults);
    const files = [];
    const [rootReal, canonicalReserved] = await Promise.all([
      fs.realpath(root.path),
      canonicalBridgeReservedPaths(this.config),
    ]);
    await collectFiles(root.path, this.config, root, rootReal, canonicalReserved, files, 20_000);
    const results = [];
    for (const relative of files) {
      if (results.length >= maxResults) break;
      if (input.pathPrefix && !relative.startsWith(input.pathPrefix)) continue;
      const file = path.join(root.path, relative);
      const stat = await fs.stat(file);
      if (stat.size > this.config.limits.maxReadBytes) continue;
      const buffer = await fs.readFile(file);
      if (appearsBinary(buffer)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
        const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
        if (haystack.includes(needle)) {
          results.push({ path: relative, line: index + 1, text: this.redactor(lines[index].slice(0, 2000)) });
        }
      }
    }
    return { rootId: root.id, query, results, truncated: results.length >= maxResults };
  }

  async applyEdits(input) {
    const previous = this.writeLocks.get(input.rootId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.applyEditsUnlocked(input));
    this.writeLocks.set(input.rootId, operation);
    try {
      return await operation;
    } finally {
      if (this.writeLocks.get(input.rootId) === operation) this.writeLocks.delete(input.rootId);
    }
  }

  async applyEditsUnlocked(input) {
    if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error('edits must be a non-empty array');
    if (input.edits.length > 100) throw new Error('At most 100 files may be edited in one transaction');
    const plans = [];
    const seen = new Set();
    for (const edit of input.edits) {
      const resolved = await resolveApprovedPath(this.config, input.rootId, edit.path, { write: true });
      if (seen.has(resolved.absolutePath)) throw new Error(`Duplicate edit path: ${edit.path}`);
      seen.add(resolved.absolutePath);
      let original = null;
      let stat = null;
      try {
        stat = await fs.stat(resolved.absolutePath);
        if (!stat.isFile()) throw new Error(`Not a regular file: ${edit.path}`);
        original = await fs.readFile(resolved.absolutePath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      let next;
      if (edit.create === true) {
        if (original !== null) throw new Error(`File already exists: ${edit.path}`);
        next = String(edit.newText ?? '');
      } else {
        if (original === null) throw new Error(`File does not exist: ${edit.path}`);
        const oldText = String(edit.oldText ?? '');
        if (!oldText) throw new Error(`oldText is required for replacement: ${edit.path}`);
        const occurrences = countOccurrences(original, oldText);
        const expected = Number(edit.expectedOccurrences ?? 1);
        if (occurrences !== expected) {
          throw new Error(`Expected ${expected} occurrence(s) in ${edit.path}, found ${occurrences}`);
        }
        next = original.split(oldText).join(String(edit.newText ?? ''));
      }
      if (Buffer.byteLength(next) > this.config.limits.maxWriteBytes) {
        throw new Error(`Result for ${edit.path} exceeds ${this.config.limits.maxWriteBytes} bytes`);
      }
      plans.push({ ...resolved, original, next, mode: stat?.mode ? stat.mode & 0o777 : 0o600 });
    }

    const committed = [];
    try {
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        await this.beforeCommit?.({ index, path: plan.relativePath });
        const currentPath = await resolveApprovedPath(this.config, input.rootId, plan.relativePath, { write: true });
        if (currentPath.absolutePath !== plan.absolutePath) throw new Error(`Edit target changed before commit: ${plan.relativePath}`);
        let current = null;
        try {
          const currentStat = await fs.stat(plan.absolutePath);
          if (!currentStat.isFile()) throw new Error(`Edit target is no longer a regular file: ${plan.relativePath}`);
          current = await fs.readFile(plan.absolutePath, 'utf8');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (current !== plan.original) throw new Error(`Edit target changed before commit: ${plan.relativePath}`);
        await writeAtomic(plan.absolutePath, plan.next, plan.mode);
        committed.push(plan);
      }
    } catch (error) {
      let rollbackConflict = false;
      for (const plan of committed.reverse()) {
        try {
          const current = await fs.readFile(plan.absolutePath, 'utf8');
          if (current !== plan.next) {
            rollbackConflict = true;
            continue;
          }
          if (plan.original === null) await fs.unlink(plan.absolutePath);
          else await writeAtomic(plan.absolutePath, plan.original, plan.mode);
        } catch {
          rollbackConflict = true;
        }
      }
      throw new Error(`${rollbackConflict ? 'Edit transaction stopped; rollback encountered an external change' : 'Edit transaction rolled back'}: ${error.message}`);
    }
    return {
      changed: plans.map((plan) => ({ path: plan.relativePath, bytes: Buffer.byteLength(plan.next), created: plan.original === null })),
    };
  }

  async gitDiff(input) {
    if (!this.config.permissions.read) throw new Error('File reads are disabled');
    const root = findRoot(this.config, input.rootId);
    const requested = input.paths ?? [];
    let paths;
    if (requested.length > 0) {
      paths = [];
      for (const candidate of requested) {
        const resolved = await resolveApprovedPath(this.config, root.id, candidate);
        paths.push(resolved.relativePath);
      }
    } else {
      const names = await runGit(this.config, root.path, [
        'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', '--',
      ], this.config.limits.maxCommandOutputBytes, this.config.limits.commandTimeoutMs);
      if (names.truncated) throw new Error('git diff changed-file list exceeds the configured output limit');
      const candidates = names.stdout.split('\0').filter(Boolean);
      if (candidates.length > 5_000) throw new Error('git diff contains too many changed files');
      paths = [];
      for (const candidate of candidates) {
        try {
          const resolved = await resolveApprovedPath(this.config, root.id, candidate);
          paths.push(resolved.relativePath);
        } catch {
          // Whole-root inspection silently omits protected or unsafe paths.
        }
      }
    }
    if (paths.length === 0) return { rootId: root.id, diff: '', truncated: false, originalBytes: 0 };
    const output = await runGit(this.config, root.path, [
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--', ...paths,
    ], this.config.limits.maxCommandOutputBytes, this.config.limits.commandTimeoutMs);
    const redacted = this.redactor(output.stdout);
    const clipped = truncateUtf8(redacted, this.config.limits.maxCommandOutputBytes);
    return {
      rootId: root.id,
      diff: clipped.text,
      truncated: output.truncated || clipped.truncated,
      originalBytes: Buffer.byteLength(output.stdout),
    };
  }
}
