#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const SKILLS_ROOT = path.join(REPOSITORY_ROOT, 'skills');
const MANIFEST_PATH = path.join(SKILLS_ROOT, 'manifest.json');
const STATE_FILE = '.relu-ai-bridge-install.json';
const LOCK_DIRECTORY = '.relu-ai-bridge-skills.lock';
const LOCK_OWNER_FILE = 'owner.json';
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

const usage = `RELU AI Bridge Skill manager

Usage:
  node scripts/skills/manage-skills.mjs verify-source
  node scripts/skills/manage-skills.mjs install [--scope user|project] [--target claude|codex|both] [--project-root PATH]
  node scripts/skills/manage-skills.mjs verify  [--scope user|project] [--target claude|codex|both] [--project-root PATH]
  node scripts/skills/manage-skills.mjs uninstall [--scope user|project] [--target claude|codex|both] [--project-root PATH]

Defaults: --scope user --target both --project-root current-directory

There is deliberately no force option. A modified or unmanaged destination is never overwritten or removed.`;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unsupported or missing fields`);
  }
}

function readRegularFile(filePath, maximumBytes) {
  let before;
  try {
    before = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`required file does not exist: ${filePath}`);
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) fail(`expected a regular file without symlinks: ${filePath}`);
  if (before.size > maximumBytes) fail(`file exceeds the allowed size: ${filePath}`);

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail(`file changed while it was opened: ${filePath}`);
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail(`file changed while it was read: ${filePath}`);
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseJsonWithoutDuplicateKeys(text, label) {
  let index = 0;
  let nodes = 0;

  const reject = (reason) => fail(`${label} is invalid JSON (${reason})`);
  const skipWhitespace = () => {
    while (index < text.length && [' ', '\t', '\r', '\n'].includes(text[index])) index += 1;
  };
  const countNode = (depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) reject('node limit exceeded');
    if (depth > MAX_JSON_DEPTH) reject('depth limit exceeded');
  };
  const parseStringToken = () => {
    if (text[index] !== '"') reject('expected string');
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x20) reject('control character in string');
      if (text[index] === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          reject('invalid string escape');
        }
      }
      if (text[index] === '\\') {
        index += 1;
        if (index >= text.length) reject('unterminated string escape');
        if (text[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) reject('invalid Unicode escape');
          index += 5;
        } else {
          if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(text[index])) reject('invalid string escape');
          index += 1;
        }
      } else {
        index += 1;
      }
    }
    reject('unterminated string');
  };
  const parseValue = (depth) => {
    countNode(depth);
    skipWhitespace();
    if (text[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === '}') { index += 1; return; }
      while (index < text.length) {
        const key = parseStringToken();
        if (keys.has(key)) reject('duplicate object key');
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') reject('expected colon');
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === '}') { index += 1; return; }
        if (text[index] !== ',') reject('expected comma or object end');
        index += 1;
        skipWhitespace();
      }
      reject('unterminated object');
    }
    if (text[index] === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') { index += 1; return; }
      while (index < text.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === ']') { index += 1; return; }
        if (text[index] !== ',') reject('expected comma or array end');
        index += 1;
        skipWhitespace();
      }
      reject('unterminated array');
    }
    if (text[index] === '"') { parseStringToken(); return; }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) { index += literal.length; return; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
    if (!number) reject('invalid value');
    index += number[0].length;
  };

  skipWhitespace();
  parseValue(1);
  skipWhitespace();
  if (index !== text.length) reject('trailing content');
  try {
    return JSON.parse(text);
  } catch {
    reject('parser rejection');
  }
}

function parseJsonFile(filePath, maximumBytes, label) {
  const content = readRegularFile(filePath, maximumBytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    fail(`${label} is not valid UTF-8 JSON: ${filePath}`);
  }
  return { content, value: parseJsonWithoutDuplicateKeys(text, label) };
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function directoryIdentity(directory) {
  const status = fs.lstatSync(directory, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) fail(`expected a real directory: ${directory}`);
  return {
    stable: [status.dev, status.ino, status.birthtimeNs, status.mode & 0o170000n].map(String).join(':'),
    observed: [status.dev, status.ino, status.birthtimeNs, status.ctimeNs, status.mtimeNs, status.mode].map(String).join(':'),
  };
}

function sameIdentity(left, right, includeObserved = true) {
  return left?.stable === right?.stable && (!includeObserved || left?.observed === right?.observed);
}

function validateRelativeFilePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) fail(`${label} is invalid`);
  if (value.includes('\\') || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    fail(`${label} must be a normalized POSIX relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part === STATE_FILE)) {
    fail(`${label} contains a forbidden path component`);
  }
  return value;
}

function validateFileRecords(records, label) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 256) fail(`${label} must be a non-empty bounded array`);
  const seen = new Set();
  return records.map((record, index) => {
    assertExactKeys(record, ['path', 'sha256', 'bytes'], `${label}[${index}]`);
    const relativePath = validateRelativeFilePath(record.path, `${label}[${index}].path`);
    const folded = relativePath.toLocaleLowerCase('en-US');
    if (seen.has(folded)) fail(`${label} contains duplicate paths`);
    seen.add(folded);
    if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
      fail(`${label}[${index}].sha256 is invalid`);
    }
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > MAX_SKILL_FILE_BYTES) {
      fail(`${label}[${index}].bytes is invalid`);
    }
    return { path: relativePath, sha256: record.sha256, bytes: record.bytes };
  });
}

function loadSourceManifest() {
  const parsed = parseJsonFile(MANIFEST_PATH, MAX_CONTROL_FILE_BYTES, 'Skill manifest');
  const manifest = parsed.value;
  assertExactKeys(manifest, ['schemaVersion', 'suite', 'suiteVersion', 'skills'], 'Skill manifest');
  if (manifest.schemaVersion !== 1) fail('Skill manifest schemaVersion is unsupported');
  if (manifest.suite !== 'relu-ai-bridge-analysis-skills') fail('Skill manifest suite is invalid');
  if (typeof manifest.suiteVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(manifest.suiteVersion)) {
    fail('Skill manifest suiteVersion is invalid');
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0 || manifest.skills.length > 32) {
    fail('Skill manifest skills must be a non-empty bounded array');
  }

  const names = new Set();
  const directories = new Set();
  const skills = manifest.skills.map((skill, index) => {
    assertExactKeys(skill, ['name', 'directory', 'files'], `Skill manifest skills[${index}]`);
    if (typeof skill.name !== 'string' || !/^[a-z0-9-]{1,63}$/u.test(skill.name)) fail('Skill name is invalid');
    if (names.has(skill.name)) fail('Skill manifest contains a duplicate skill name');
    names.add(skill.name);
    const directory = validateRelativeFilePath(skill.directory, `Skill manifest skills[${index}].directory`);
    if (directory.includes('/')) fail('Skill directory must be an immediate child of skills/');
    const foldedDirectory = directory.toLocaleLowerCase('en-US');
    if (directories.has(foldedDirectory)) fail('Skill manifest contains colliding skill directories');
    directories.add(foldedDirectory);
    if (directory !== skill.name) fail('Skill directory must match the skill name');
    const files = validateFileRecords(skill.files, `Skill manifest skills[${index}].files`);
    if (!files.some((file) => file.path === 'SKILL.md')) fail(`Skill ${skill.name} does not include SKILL.md`);
    return { name: skill.name, directory, files };
  });

  return {
    schemaVersion: manifest.schemaVersion,
    suite: manifest.suite,
    suiteVersion: manifest.suiteVersion,
    skills,
    manifestSha256: sha256(parsed.content),
  };
}

function walkRegularFiles(root, relativeDirectory = '') {
  const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split('/')) : root;
  const entries = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, 'en'));
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
    const absolutePath = path.join(root, ...relativePath.split('/'));
    const status = fs.lstatSync(absolutePath);
    if (status.isSymbolicLink()) fail(`symlinks are not allowed in a managed Skill: ${absolutePath}`);
    if (status.isDirectory()) {
      files.push(...walkRegularFiles(root, relativePath));
    } else if (status.isFile()) {
      files.push(relativePath);
    } else {
      fail(`only regular files and directories are allowed in a managed Skill: ${absolutePath}`);
    }
  }
  return files;
}

function verifyFiles(root, records, options = {}) {
  const expected = records.map((record) => record.path).sort((left, right) => left.localeCompare(right, 'en'));
  const allowedExtra = options.allowedExtra ?? [];
  const actual = walkRegularFiles(root)
    .filter((relativePath) => !allowedExtra.includes(relativePath))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    fail(`managed Skill file set does not match its manifest: ${root}`);
  }
  for (const record of records) {
    const absolutePath = path.join(root, ...record.path.split('/'));
    const content = readRegularFile(absolutePath, MAX_SKILL_FILE_BYTES);
    if (content.byteLength !== record.bytes || sha256(content) !== record.sha256) {
      fail(`managed Skill file checksum does not match: ${absolutePath}`);
    }
  }
}

function verifySource(manifest) {
  const expectedDirectories = manifest.skills.map((skill) => skill.directory).sort((left, right) => left.localeCompare(right, 'en'));
  const actualEntries = fs.readdirSync(SKILLS_ROOT).filter((entry) => entry !== 'manifest.json').sort((left, right) => left.localeCompare(right, 'en'));
  if (actualEntries.length !== expectedDirectories.length || actualEntries.some((entry, index) => entry !== expectedDirectories[index])) {
    fail('skills/ contains an unmanifested entry or is missing a manifested Skill');
  }
  for (const skill of manifest.skills) {
    const source = path.join(SKILLS_ROOT, skill.directory);
    const status = fs.lstatSync(source);
    if (status.isSymbolicLink() || !status.isDirectory()) fail(`Skill source must be a real directory: ${source}`);
    verifyFiles(source, skill.files);
  }
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const command = argv[0];
  if (!['verify-source', 'install', 'verify', 'uninstall'].includes(command)) fail(`unknown command: ${command}`);
  if (command === 'verify-source') {
    if (argv.length !== 1) fail('verify-source does not accept options');
    return { command, scope: null, target: null, projectRoot: null };
  }

  const options = { command, scope: 'user', target: 'both', projectRoot: process.cwd() };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--scope', '--target', '--project-root'].includes(key) || value === undefined) fail(`invalid option near: ${key}`);
    if (seen.has(key)) fail(`duplicate option: ${key}`);
    seen.add(key);
    if (key === '--scope') options.scope = value;
    if (key === '--target') options.target = value;
    if (key === '--project-root') options.projectRoot = value;
  }
  if (!['user', 'project'].includes(options.scope)) fail('--scope must be user or project');
  if (!['claude', 'codex', 'both'].includes(options.target)) fail('--target must be claude, codex, or both');
  if (typeof options.projectRoot !== 'string' || options.projectRoot.length === 0) fail('--project-root must not be empty');
  options.projectRoot = path.resolve(options.projectRoot);
  return options;
}

function assertSafeExistingPathComponents(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    let status;
    try {
      status = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (status.isSymbolicLink()) fail(`destination path contains a symlink or junction: ${current}`);
    if (!status.isDirectory()) fail(`destination path component is not a directory: ${current}`);
  }
}

function ensureDirectoryTree(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const status = fs.lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) fail(`destination path is not a real directory: ${current}`);
  }
}

function targetParents(options) {
  const base = options.scope === 'user' ? os.homedir() : options.projectRoot;
  assertSafeExistingPathComponents(base);
  let baseStatus;
  try {
    baseStatus = fs.lstatSync(base);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`installation base does not exist: ${base}`);
    throw error;
  }
  if (baseStatus.isSymbolicLink() || !baseStatus.isDirectory()) fail(`installation base must be a real directory: ${base}`);
  const targets = options.target === 'both' ? ['claude', 'codex'] : [options.target];
  return targets.map((target) => ({
    target,
    parent: target === 'claude'
      ? path.join(base, '.claude', 'skills')
      : path.join(base, '.agents', 'skills'),
  }));
}

function destinations(options, manifest) {
  return targetParents(options).flatMap(({ target, parent }) => manifest.skills.map((skill) => ({
    target,
    parent,
    skill,
    destination: path.join(parent, skill.directory),
  })));
}

function loadInstalledState(destination, expectedSkillName) {
  const statePath = path.join(destination, STATE_FILE);
  const parsed = parseJsonFile(statePath, MAX_CONTROL_FILE_BYTES, 'Installed Skill state');
  const state = parsed.value;
  assertExactKeys(state, ['schemaVersion', 'suite', 'suiteVersion', 'skillName', 'sourceManifestSha256', 'files'], 'Installed Skill state');
  if (state.schemaVersion !== 1 || state.suite !== 'relu-ai-bridge-analysis-skills' || state.skillName !== expectedSkillName) {
    fail(`installed Skill state is not owned by this manager: ${statePath}`);
  }
  if (typeof state.suiteVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(state.suiteVersion)) fail(`installed Skill version is invalid: ${statePath}`);
  if (typeof state.sourceManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(state.sourceManifestSha256)) {
    fail(`installed Skill manifest checksum is invalid: ${statePath}`);
  }
  const files = validateFileRecords(state.files, 'Installed Skill state files');
  verifyFiles(destination, files, { allowedExtra: [STATE_FILE] });
  return { ...state, files, stateFileSha256: sha256(parsed.content) };
}

function isCurrent(state, skill, manifest) {
  if (state.suiteVersion !== manifest.suiteVersion || state.sourceManifestSha256 !== manifest.manifestSha256) return false;
  if (state.files.length !== skill.files.length) return false;
  return state.files.every((record, index) => {
    const current = skill.files[index];
    return record.path === current.path && record.bytes === current.bytes && record.sha256 === current.sha256;
  });
}

function managedSnapshotAt(destination, skill, manifest) {
  const before = directoryIdentity(destination);
  const state = loadInstalledState(destination, skill.name);
  const after = directoryIdentity(destination);
  if (!sameIdentity(before, after)) fail(`managed Skill changed while it was verified: ${destination}`);
  return {
    kind: isCurrent(state, skill, manifest) ? 'current' : 'managed-old',
    state,
    stateFileSha256: state.stateFileSha256,
    identity: after,
  };
}

function destinationStatus(item, manifest) {
  assertSafeExistingPathComponents(item.parent);
  let status;
  try {
    status = fs.lstatSync(item.destination);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', state: null };
    throw error;
  }
  if (status.isSymbolicLink() || !status.isDirectory()) fail(`Skill destination is not a real directory: ${item.destination}`);
  return managedSnapshotAt(item.destination, item.skill, manifest);
}

function assertDestinationSnapshot(item, expected, manifest) {
  const actual = destinationStatus(item, manifest);
  if (actual.kind !== expected.kind) fail(`Skill destination changed after preflight: ${item.destination}`);
  if (expected.kind === 'missing') return actual;
  if (!sameIdentity(actual.identity, expected.identity)
      || actual.stateFileSha256 !== expected.stateFileSha256) {
    fail(`Skill destination identity or state changed after preflight: ${item.destination}`);
  }
  return actual;
}

function assertMovedManagedSnapshot(destination, expected, skill, manifest, includeObserved = false) {
  if (!expected) fail(`managed Skill snapshot is unavailable; retained for operator review: ${destination}`);
  const actual = managedSnapshotAt(destination, skill, manifest);
  if (actual.kind !== expected.kind
      || !sameIdentity(actual.identity, expected.identity, includeObserved)
      || actual.stateFileSha256 !== expected.stateFileSha256) {
    fail(`moved managed Skill does not match the verified source: ${destination}`);
  }
  return actual;
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeExclusiveFile(filePath, content) {
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertLockOwned(lock) {
  const identity = directoryIdentity(lock.lockPath);
  if (!sameIdentity(identity, lock.identity, false)) fail(`Skill manager lock identity changed: ${lock.lockPath}`);
  const entries = fs.readdirSync(lock.lockPath);
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER_FILE) fail(`Skill manager lock contents changed: ${lock.lockPath}`);
  const owner = readRegularFile(lock.ownerPath, MAX_CONTROL_FILE_BYTES);
  if (sha256(owner) !== lock.ownerSha256) fail(`Skill manager lock ownership changed: ${lock.lockPath}`);
  const parentIdentity = directoryIdentity(lock.parent);
  if (!sameIdentity(parentIdentity, lock.parentIdentity, false)) fail(`Skill manager parent identity changed: ${lock.parent}`);
}

function releaseParentLock(lock) {
  assertLockOwned(lock);
  fs.unlinkSync(lock.ownerPath);
  const identity = directoryIdentity(lock.lockPath);
  if (!sameIdentity(identity, lock.identity, false) || fs.readdirSync(lock.lockPath).length !== 0) {
    fail(`Skill manager lock could not be safely released: ${lock.lockPath}`);
  }
  fs.rmdirSync(lock.lockPath);
  fsyncDirectory(lock.parent);
}

function acquireParentLocks(items) {
  const parents = [...new Set(items.map((item) => item.parent))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const locks = [];
  try {
    for (const parent of parents) {
      ensureDirectoryTree(parent);
      const lockPath = path.join(parent, LOCK_DIRECTORY);
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code === 'EEXIST') fail(`another Skill manager or stale lock owns this parent: ${lockPath}`);
        throw error;
      }
      const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
      const owner = Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        nonce: crypto.randomBytes(32).toString('hex'),
        startedAt: new Date().toISOString(),
      })}\n`, 'utf8');
      try {
        writeExclusiveFile(ownerPath, owner);
        fsyncDirectory(lockPath);
        locks.push({
          parent,
          parentIdentity: directoryIdentity(parent),
          lockPath,
          ownerPath,
          ownerSha256: sha256(owner),
          identity: directoryIdentity(lockPath),
        });
      } catch (error) {
        // A partially created lock remains fail-closed unless ownership can be proven.
        try {
          const entries = fs.readdirSync(lockPath);
          if (entries.length === 0) fs.rmdirSync(lockPath);
          else if (entries.length === 1 && entries[0] === LOCK_OWNER_FILE
                   && sha256(readRegularFile(ownerPath, MAX_CONTROL_FILE_BYTES)) === sha256(owner)) {
            fs.unlinkSync(ownerPath);
            fs.rmdirSync(lockPath);
          }
        } catch {
          // Preserve the lock for operator review instead of deleting uncertain data.
        }
        throw error;
      }
    }
    return locks;
  } catch (error) {
    const releaseFailures = [];
    for (const lock of [...locks].reverse()) {
      try { releaseParentLock(lock); } catch (releaseError) { releaseFailures.push(releaseError.message); }
    }
    if (releaseFailures.length > 0) fail(`${error.message}; lock release failed: ${releaseFailures.join('; ')}`);
    throw error;
  }
}

function withParentLocks(items, action) {
  const locks = acquireParentLocks(items);
  let result;
  let operationError = null;
  try {
    result = action(locks);
  } catch (error) {
    operationError = error;
  }
  const releaseFailures = [];
  for (const lock of [...locks].reverse()) {
    try { releaseParentLock(lock); } catch (error) { releaseFailures.push(error.message); }
  }
  if (operationError) {
    if (releaseFailures.length > 0) operationError.message += `; lock release failed: ${releaseFailures.join('; ')}`;
    throw operationError;
  }
  if (releaseFailures.length > 0) fail(`Skill manager lock release failed: ${releaseFailures.join('; ')}`);
  return result;
}

function assertAllLocksOwned(locks) {
  for (const lock of locks) assertLockOwned(lock);
}

function createStage(item, manifest) {
  ensureDirectoryTree(item.parent);
  const stage = fs.mkdtempSync(path.join(item.parent, `.${item.skill.directory}.staging-`));
  fs.chmodSync(stage, 0o700);
  try {
    const sourceRoot = path.join(SKILLS_ROOT, item.skill.directory);
    for (const record of item.skill.files) {
      const source = path.join(sourceRoot, ...record.path.split('/'));
      const destination = path.join(stage, ...record.path.split('/'));
      ensureDirectoryTree(path.dirname(destination));
      const content = readRegularFile(source, MAX_SKILL_FILE_BYTES);
      if (content.byteLength !== record.bytes || sha256(content) !== record.sha256) fail(`Skill source changed during staging: ${source}`);
      writeExclusiveFile(destination, content);
    }
    const state = {
      schemaVersion: 1,
      suite: manifest.suite,
      suiteVersion: manifest.suiteVersion,
      skillName: item.skill.name,
      sourceManifestSha256: manifest.manifestSha256,
      files: item.skill.files,
    };
    writeExclusiveFile(path.join(stage, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    verifyFiles(stage, item.skill.files, { allowedExtra: [STATE_FILE] });
    fsyncDirectory(stage);
    return { path: stage, snapshot: managedSnapshotAt(stage, item.skill, manifest) };
  } catch (error) {
    error.message += `; incomplete staging retained for operator review: ${stage}`;
    throw error;
  }
}

function regularFileIdentity(filePath) {
  const status = fs.lstatSync(filePath, { bigint: true });
  if (status.isSymbolicLink() || !status.isFile()) fail(`expected a regular file without symlinks: ${filePath}`);
  return [status.dev, status.ino, status.birthtimeNs, status.ctimeNs, status.mtimeNs, status.size, status.mode]
    .map(String).join(':');
}

function unlinkVerifiedFile(filePath, expectedBytes, expectedSha256) {
  const before = regularFileIdentity(filePath);
  const content = readRegularFile(filePath, MAX_SKILL_FILE_BYTES);
  if ((expectedBytes !== null && content.byteLength !== expectedBytes) || sha256(content) !== expectedSha256) {
    fail(`refusing to delete a changed managed file: ${filePath}`);
  }
  if (regularFileIdentity(filePath) !== before) fail(`managed file changed before deletion: ${filePath}`);
  fs.unlinkSync(filePath);
}

function deleteVerifiedManagedDirectory(directory, expected, skill, manifest) {
  const actual = assertMovedManagedSnapshot(directory, expected, skill, manifest, true);
  for (const record of actual.state.files) {
    unlinkVerifiedFile(
      path.join(directory, ...record.path.split('/')),
      record.bytes,
      record.sha256,
    );
  }
  unlinkVerifiedFile(path.join(directory, STATE_FILE), null, actual.stateFileSha256);

  const directories = new Set();
  for (const record of actual.state.files) {
    const parts = record.path.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  }
  for (const relative of [...directories].sort((left, right) => {
    const depth = right.split('/').length - left.split('/').length;
    return depth || right.localeCompare(left, 'en');
  })) {
    const target = path.join(directory, ...relative.split('/'));
    const identity = directoryIdentity(target);
    if (fs.readdirSync(target).length !== 0) fail(`refusing to delete a non-empty managed directory: ${target}`);
    if (!sameIdentity(directoryIdentity(target), identity, false)) fail(`managed directory changed before deletion: ${target}`);
    fs.rmdirSync(target);
  }
  if (!sameIdentity(directoryIdentity(directory), actual.identity, false)
      || fs.readdirSync(directory).length !== 0) {
    fail(`refusing to delete a changed managed Skill directory: ${directory}`);
  }
  fs.rmdirSync(directory);
  fsyncDirectory(path.dirname(directory));
}

function uniqueSibling(parent, name, purpose) {
  return path.join(parent, `.${name}.${purpose}-${crypto.randomUUID()}`);
}

function install(options, manifest) {
  const lockItems = destinations(options, manifest);
  return withParentLocks(lockItems, (locks) => {
    assertAllLocksOwned(locks);
    const items = lockItems.map((item) => ({ ...item, status: destinationStatus(item, manifest) }));
    const changes = items.filter((item) => item.status.kind !== 'current');
    if (changes.length === 0) {
      for (const item of items) console.log(`current ${item.target}: ${item.destination}`);
      return;
    }

    const prepared = [];
    try {
      for (const item of changes) {
        assertAllLocksOwned(locks);
        prepared.push({
          ...item,
          stage: createStage(item, manifest),
          backup: null,
          backupSnapshot: null,
          installedSnapshot: null,
          committed: false,
        });
      }
    } catch (error) {
      const cleanupFailures = [];
      for (const item of prepared) {
        try {
          deleteVerifiedManagedDirectory(item.stage.path, item.stage.snapshot, item.skill, manifest);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError.message);
        }
      }
      if (cleanupFailures.length > 0) error.message += `; staged cleanup failed: ${cleanupFailures.join('; ')}`;
      throw error;
    }

    try {
      for (const item of prepared) {
        assertAllLocksOwned(locks);
        assertDestinationSnapshot(item, item.status, manifest);
        if (item.status.kind === 'managed-old') {
          item.backup = uniqueSibling(item.parent, item.skill.directory, 'backup');
          fs.renameSync(item.destination, item.backup);
          item.backupSnapshot = assertMovedManagedSnapshot(
            item.backup, item.status, item.skill, manifest, false,
          );
        }
        assertAllLocksOwned(locks);
        const afterMove = destinationStatus(item, manifest);
        if (afterMove.kind !== 'missing') fail(`Skill destination was created during replacement: ${item.destination}`);
        fs.renameSync(item.stage.path, item.destination);
        item.installedSnapshot = assertMovedManagedSnapshot(
          item.destination, item.stage.snapshot, item.skill, manifest, false,
        );
        item.stage = null;
        item.committed = true;
        fsyncDirectory(item.parent);
      }
    } catch (error) {
      const rollbackFailures = [];
      for (const item of [...prepared].reverse()) {
        if (item.committed) {
          try {
            // Never delete a destination that no longer equals the staged managed content.
            deleteVerifiedManagedDirectory(
              item.destination, item.installedSnapshot, item.skill, manifest,
            );
          } catch (rollbackError) {
            rollbackFailures.push(`new destination retained (${rollbackError.message})`);
          }
        }
        if (item.backup) {
          try {
            const current = destinationStatus(item, manifest);
            if (current.kind !== 'missing') {
              fail(`destination is occupied; verified backup retained at ${item.backup}`);
            }
            assertMovedManagedSnapshot(item.backup, item.backupSnapshot, item.skill, manifest, true);
            fs.renameSync(item.backup, item.destination);
            assertMovedManagedSnapshot(item.destination, item.status, item.skill, manifest, false);
            item.backup = null;
          } catch (rollbackError) {
            rollbackFailures.push(`backup not restored (${rollbackError.message})`);
          }
        }
        if (item.stage) {
          try {
            deleteVerifiedManagedDirectory(item.stage.path, item.stage.snapshot, item.skill, manifest);
            item.stage = null;
          } catch (cleanupError) {
            rollbackFailures.push(`staged content retained (${cleanupError.message})`);
          }
        }
      }
      if (rollbackFailures.length > 0) error.message += `; rollback incomplete: ${rollbackFailures.join('; ')}`;
      throw error;
    }

    assertAllLocksOwned(locks);
    for (const item of prepared) {
      item.installedSnapshot = assertMovedManagedSnapshot(
        item.destination, item.installedSnapshot, item.skill, manifest, true,
      );
    }
    for (const item of prepared.filter((entry) => entry.backup)) {
      item.backupSnapshot = assertMovedManagedSnapshot(
        item.backup, item.backupSnapshot, item.skill, manifest, true,
      );
    }
    for (const item of prepared.filter((entry) => entry.backup)) {
      deleteVerifiedManagedDirectory(item.backup, item.backupSnapshot, item.skill, manifest);
      item.backup = null;
    }
    for (const item of prepared) {
      console.log(`${item.status.kind === 'missing' ? 'installed' : 'updated'} ${item.target}: ${item.destination}`);
    }
    for (const item of items.filter((entry) => entry.status.kind === 'current')) console.log(`current ${item.target}: ${item.destination}`);
  });
}

function verifyInstalled(options, manifest) {
  const items = destinations(options, manifest);
  for (const item of items) {
    const status = destinationStatus(item, manifest);
    if (status.kind !== 'current') fail(`installed Skill is not the current verified release: ${item.destination}`);
    console.log(`verified ${item.target}: ${item.destination}`);
  }
}

function uninstall(options, manifest) {
  const lockItems = destinations(options, manifest);
  return withParentLocks(lockItems, (locks) => {
    assertAllLocksOwned(locks);
    const items = lockItems.map((item) => ({ ...item, status: destinationStatus(item, manifest) }));
    for (const item of items) {
      if (item.status.kind === 'missing') fail(`managed Skill is not installed: ${item.destination}`);
    }

    const moved = [];
    try {
      for (const item of items) {
        assertAllLocksOwned(locks);
        assertDestinationSnapshot(item, item.status, manifest);
        const removal = uniqueSibling(item.parent, item.skill.directory, 'removing');
        fs.renameSync(item.destination, removal);
        const movedItem = { ...item, removal, removalSnapshot: null };
        moved.push(movedItem);
        movedItem.removalSnapshot = assertMovedManagedSnapshot(
          removal, item.status, item.skill, manifest, false,
        );
      }
      assertAllLocksOwned(locks);
      for (const item of moved) {
        item.removalSnapshot = assertMovedManagedSnapshot(
          item.removal, item.removalSnapshot, item.skill, manifest, true,
        );
      }
    } catch (error) {
      const rollbackFailures = [];
      for (const item of [...moved].reverse()) {
        try {
          if (!item.removalSnapshot) fail(`unverified removal retained at ${item.removal}`);
          const current = destinationStatus(item, manifest);
          if (current.kind !== 'missing') fail(`destination is occupied; removal retained at ${item.removal}`);
          assertMovedManagedSnapshot(item.removal, item.removalSnapshot, item.skill, manifest, true);
          fs.renameSync(item.removal, item.destination);
          assertMovedManagedSnapshot(item.destination, item.status, item.skill, manifest, false);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError.message);
        }
      }
      if (rollbackFailures.length > 0) error.message += `; uninstall rollback incomplete: ${rollbackFailures.join('; ')}`;
      throw error;
    }

    for (const item of moved) {
      deleteVerifiedManagedDirectory(item.removal, item.removalSnapshot, item.skill, manifest);
      console.log(`uninstalled ${item.target}: ${item.destination}`);
    }
  });
}

try {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 11)) fail('Node.js 20.11 or newer is required');
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
  } else {
    const manifest = loadSourceManifest();
    verifySource(manifest);
    if (options.command === 'verify-source') console.log(`verified source: ${manifest.skills.length} Skill(s), suite ${manifest.suiteVersion}`);
    if (options.command === 'install') install(options, manifest);
    if (options.command === 'verify') verifyInstalled(options, manifest);
    if (options.command === 'uninstall') uninstall(options, manifest);
  }
} catch (error) {
  console.error(`RELU Skill manager: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
