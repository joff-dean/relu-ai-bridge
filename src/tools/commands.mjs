import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findRoot, resolveApprovedPath, safeChildEnvironment } from '../security.mjs';
import { randomId, truncateUtf8 } from '../utils.mjs';

function boundedCollector(maxBytes) {
  return {
    chunks: [],
    bytes: 0,
    truncated: false,
    push(chunk) {
      const buffer = Buffer.from(chunk);
      const remaining = maxBytes - this.bytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        this.chunks.push(kept);
        this.bytes += kept.length;
      }
      if (buffer.length > Math.max(remaining, 0)) this.truncated = true;
    },
    value() { return Buffer.concat(this.chunks).toString('utf8'); },
  };
}

function validateArguments(args) {
  if (!Array.isArray(args) || args.length > 100) throw new Error('args must be an array of at most 100 strings');
  return args.map((value) => {
    const text = String(value);
    if (text.includes('\0') || text.length > 4096) throw new Error('Invalid command argument');
    return text;
  });
}

export class CommandManager {
  constructor(config, redactor) {
    this.config = config;
    this.redactor = redactor;
    this.sessions = new Map();
    this.processes = new Set();
    this.activeTotal = 0;
    this.activeByRoot = new Map();
    this.shuttingDown = false;
  }

  resolveSpec(input) {
    if (!this.config.permissions.commands) throw new Error('Command execution is disabled');
    const root = findRoot(this.config, input.rootId);
    let program;
    let args;
    let timeoutMs;
    let interactive;
    if (input.profile) {
      const profile = this.config.commandProfiles[input.profile];
      if (!profile) throw new Error(`Unknown command profile: ${input.profile}`);
      const extraArgs = validateArguments(input.extraArgs ?? []);
      if (extraArgs.length && !profile.allowExtraArgs) throw new Error(`Profile ${input.profile} does not allow extra arguments`);
      program = profile.program;
      args = [...(profile.args ?? []), ...extraArgs];
      timeoutMs = profile.timeoutMs;
      interactive = Boolean(profile.interactive);
    } else {
      if (!this.config.permissions.allowArbitraryCommands) throw new Error('Arbitrary commands are disabled; use a named command profile');
      program = String(input.program ?? '');
      if (!program || program.includes('/') || program.includes('\\')) throw new Error('program must be a bare executable name');
      args = validateArguments(input.args ?? []);
      timeoutMs = input.timeoutMs;
      interactive = Boolean(input.interactive);
    }
    const maximumTimeout = this.config.limits.commandTimeoutMs;
    const requestedTimeout = timeoutMs ?? maximumTimeout;
    if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0) {
      throw new Error('Command timeout must be a positive integer');
    }
    return {
      root,
      program,
      args,
      interactive,
      timeoutMs: Math.min(requestedTimeout, maximumTimeout),
    };
  }

  async resolveCwd(rootId, relativeCwd = '.') {
    const resolved = await resolveApprovedPath(this.config, rootId, relativeCwd, { mustExist: true });
    if (!(await fs.stat(resolved.absolutePath)).isDirectory()) throw new Error('Command cwd must be a directory');
    return resolved.absolutePath;
  }

  async run(input) {
    const spec = this.resolveSpec(input);
    const cwd = await this.resolveCwd(spec.root.id, input.cwd ?? '.');
    const releaseSlot = this.acquireSlot(spec.root.id);
    if (spec.interactive) return this.startInteractive(spec, cwd, releaseSlot);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(spec.program, spec.args, {
          cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: safeChildEnvironment({ NO_COLOR: '1', CI: '1' }, this.config),
        });
      } catch (error) {
        releaseSlot();
        reject(error);
        return;
      }
      const stdout = boundedCollector(this.config.limits.maxCommandOutputBytes);
      const stderr = boundedCollector(this.config.limits.maxCommandOutputBytes);
      const state = this.trackProcess(child, releaseSlot);
      state.timeoutTimer = setTimeout(() => {
        state.timedOut = true;
        this.requestTermination(state);
      }, spec.timeoutMs);
      state.timeoutTimer.unref();
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.once('error', (error) => {
        if (!this.finishProcess(state)) return;
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (!this.finishProcess(state)) return;
        const out = truncateUtf8(this.redactor(stdout.value()), this.config.limits.maxCommandOutputBytes);
        const err = truncateUtf8(this.redactor(stderr.value()), this.config.limits.maxCommandOutputBytes);
        resolve({
          program: spec.program,
          args: spec.args,
          cwd: path.relative(spec.root.path, cwd) || '.',
          exitCode: code,
          signal,
          timedOut: state.timedOut,
          stdout: out.text,
          stderr: err.text,
          truncated: stdout.truncated || stderr.truncated || out.truncated || err.truncated,
        });
      });
    });
  }

  acquireSlot(rootId) {
    if (this.shuttingDown) throw new Error('Command manager is shutting down');
    const maxTotal = this.config.limits.maxConcurrentCommands;
    const maxPerRoot = this.config.limits.maxConcurrentCommandsPerRoot;
    if (this.activeTotal >= maxTotal) throw new Error('Global concurrent command limit reached');
    const rootActive = this.activeByRoot.get(rootId) ?? 0;
    if (rootActive >= maxPerRoot) throw new Error(`Concurrent command limit reached for root: ${rootId}`);
    this.activeTotal += 1;
    this.activeByRoot.set(rootId, rootActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTotal = Math.max(0, this.activeTotal - 1);
      const remaining = (this.activeByRoot.get(rootId) ?? 1) - 1;
      if (remaining > 0) this.activeByRoot.set(rootId, remaining);
      else this.activeByRoot.delete(rootId);
    };
  }

  trackProcess(child, releaseSlot) {
    let resolveFinished;
    const state = {
      child,
      releaseSlot,
      running: true,
      timedOut: false,
      timeoutTimer: null,
      killTimer: null,
      terminationRequested: false,
      finished: new Promise((resolve) => { resolveFinished = resolve; }),
      resolveFinished,
    };
    this.processes.add(state);
    return state;
  }

  finishProcess(state) {
    if (!state.running) return false;
    state.running = false;
    clearTimeout(state.timeoutTimer);
    clearTimeout(state.killTimer);
    this.processes.delete(state);
    state.releaseSlot();
    state.resolveFinished();
    return true;
  }

  requestTermination(state) {
    if (!state.running || state.terminationRequested) return;
    state.terminationRequested = true;
    try { state.child.kill('SIGTERM'); } catch { /* Process may already be gone. */ }
    state.killTimer = setTimeout(() => {
      if (!state.running) return;
      try { state.child.kill('SIGKILL'); } catch { /* Process may already be gone. */ }
    }, this.config.limits.commandKillGraceMs);
    state.killTimer.unref();
  }

  startInteractive(spec, cwd, releaseSlot) {
    const id = randomId('cmd_');
    let child;
    try {
      child = spawn(spec.program, spec.args, {
        cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeChildEnvironment({ NO_COLOR: '1' }, this.config),
      });
    } catch (error) {
      releaseSlot();
      throw error;
    }
    const state = Object.assign(this.trackProcess(child, releaseSlot), {
      id,
      stdout: boundedCollector(this.config.limits.maxCommandOutputBytes),
      stderr: boundedCollector(this.config.limits.maxCommandOutputBytes),
      exitCode: null,
      signal: null,
      createdAt: Date.now(),
      completedAt: null,
      cleanupTimer: null,
    });
    this.sessions.set(id, state);
    state.timeoutTimer = setTimeout(() => {
      state.timedOut = true;
      this.requestTermination(state);
    }, spec.timeoutMs);
    state.timeoutTimer.unref();
    child.stdout.on('data', (chunk) => state.stdout.push(chunk));
    child.stderr.on('data', (chunk) => state.stderr.push(chunk));
    child.once('close', (code, signal) => {
      state.exitCode = code;
      state.signal = signal;
      if (this.finishProcess(state)) this.scheduleSessionCleanup(state);
    });
    child.once('error', (error) => {
      state.stderr.push(Buffer.from(error.message));
      if (this.finishProcess(state)) this.scheduleSessionCleanup(state);
    });
    return { sessionId: id, running: true, program: spec.program, args: spec.args };
  }

  scheduleSessionCleanup(state) {
    state.completedAt = Date.now();
    if (this.shuttingDown) {
      this.sessions.delete(state.id);
      return;
    }
    state.cleanupTimer = setTimeout(() => {
      if (this.sessions.get(state.id) === state && !state.running) this.sessions.delete(state.id);
    }, this.config.limits.commandSessionTtlMs);
    state.cleanupTimer.unref();
  }

  pruneCompletedSessions(now = Date.now()) {
    for (const state of this.sessions.values()) {
      if (state.running || state.completedAt === null) continue;
      if (now - state.completedAt < this.config.limits.commandSessionTtlMs) continue;
      clearTimeout(state.cleanupTimer);
      this.sessions.delete(state.id);
    }
  }

  write(input) {
    this.pruneCompletedSessions();
    const state = this.sessions.get(input.sessionId);
    if (!state) throw new Error('Unknown command session');
    if (input.chars && state.running) state.child.stdin.write(String(input.chars));
    if (input.closeStdin && state.running) state.child.stdin.end();
    if (input.terminate && state.running) this.requestTermination(state);
    const stdoutCollector = state.stdout;
    const stderrCollector = state.stderr;
    const stdout = truncateUtf8(this.redactor(stdoutCollector.value()), this.config.limits.maxCommandOutputBytes);
    const stderr = truncateUtf8(this.redactor(stderrCollector.value()), this.config.limits.maxCommandOutputBytes);
    state.stdout = boundedCollector(this.config.limits.maxCommandOutputBytes);
    state.stderr = boundedCollector(this.config.limits.maxCommandOutputBytes);
    return {
      sessionId: state.id,
      running: state.running,
      exitCode: state.exitCode,
      signal: state.signal,
      timedOut: state.timedOut,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdoutCollector.truncated || stderrCollector.truncated || stdout.truncated || stderr.truncated,
    };
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const state of this.sessions.values()) {
      clearTimeout(state.cleanupTimer);
      if (!state.running) this.sessions.delete(state.id);
    }
    const running = [...this.processes];
    for (const state of running) this.requestTermination(state);
    if (running.length) {
      await Promise.race([
        Promise.all(running.map((state) => state.finished)),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, this.config.limits.commandKillGraceMs + 2_000);
          timer.unref();
        }),
      ]);
    }
  }
}
