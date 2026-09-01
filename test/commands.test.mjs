import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CommandManager } from '../src/tools/commands.mjs';
import { fixture } from './helpers.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForCompletion(manager, sessionId, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let stdout = '';
  let stderr = '';
  while (Date.now() < deadline) {
    const status = manager.write({ sessionId });
    stdout += status.stdout;
    stderr += status.stderr;
    if (!status.running) return { ...status, stdout, stderr };
    await delay(10);
  }
  throw new Error(`Timed out waiting for command session ${sessionId}`);
}

async function waitForCondition(condition, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

test('commands are shell-free, output-bounded, and do not inherit secret-like environment variables', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  env.config.limits.maxCommandOutputBytes = 64;
  env.config.commandProfiles.spam = {
    program: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(1000))'],
    allowExtraArgs: false,
    timeoutMs: 5000,
  };
  env.config.commandProfiles.environment = {
    program: process.execPath,
    args: ['-e', 'process.stdout.write(["COMPANY_TEST_PASSWORD", "RELU_CHILD_FOO", "RELU_CHILD_BAR", "RELU_CHILD_BAZ", "RELU_CHILD_PERFETTO"].map((key) => process.env[key] || "absent").join(","))'],
    allowExtraArgs: false,
    timeoutMs: 5000,
  };
  env.config.connectors.services = [{
    tokenEnv: 'RELU_CHILD_FOO',
    capabilities: [{ http: { auth: { env: 'RELU_CHILD_BAR' } } }],
  }];
  env.config.goal.apiKeyEnv = 'RELU_CHILD_BAZ';
  env.config.perfetto.tokenEnv = 'RELU_CHILD_PERFETTO';
  process.env.COMPANY_TEST_PASSWORD = 'must-not-leak';
  process.env.RELU_CHILD_FOO = 'service-must-not-leak';
  process.env.RELU_CHILD_BAR = 'http-must-not-leak';
  process.env.RELU_CHILD_BAZ = 'goal-must-not-leak';
  process.env.RELU_CHILD_PERFETTO = 'perfetto-must-not-leak';
  t.after(() => {
    delete process.env.COMPANY_TEST_PASSWORD;
    delete process.env.RELU_CHILD_FOO;
    delete process.env.RELU_CHILD_BAR;
    delete process.env.RELU_CHILD_BAZ;
    delete process.env.RELU_CHILD_PERFETTO;
  });
  const manager = new CommandManager(env.config, (value) => value);
  const output = await manager.run({ rootId: 'project', profile: 'spam' });
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.stdout) <= 64);
  const environment = await manager.run({ rootId: 'project', profile: 'environment' });
  assert.equal(environment.stdout, 'absent,absent,absent,absent,absent');
});

test('caller cannot turn a non-interactive named profile into an interactive process', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  env.config.commandProfiles.noninteractive = {
    program: process.execPath,
    args: ['-e', 'process.stdout.write("profile-only")'],
    allowExtraArgs: false,
    interactive: false,
    timeoutMs: 5000,
  };
  const manager = new CommandManager(env.config, (value) => value);
  t.after(() => manager.shutdown());
  const output = await manager.run({
    rootId: 'project',
    profile: 'noninteractive',
    interactive: true,
  });
  assert.equal(output.stdout, 'profile-only');
  assert.equal('sessionId' in output, false);
  assert.throws(() => manager.write({ sessionId: undefined, chars: 'must-not-open-stdin' }), /Unknown command session/u);
});

test('interactive profiles enforce their timeout and escalate SIGTERM to SIGKILL', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  env.config.limits.commandKillGraceMs = 50;
  env.config.commandProfiles.stubborn = {
    program: process.execPath,
    args: ['-e', [
      'process.stdout.write("ready\\n")',
      'process.on("SIGTERM", () => process.stdout.write("term\\n"))',
      'setInterval(() => {}, 1000)',
    ].join(';')],
    allowExtraArgs: false,
    interactive: true,
    timeoutMs: 250,
  };
  const manager = new CommandManager(env.config, (value) => value);
  t.after(() => manager.shutdown());

  const started = await manager.run({
    rootId: 'project',
    profile: 'stubborn',
    timeoutMs: 30_000,
  });
  const completed = await waitForCompletion(manager, started.sessionId);
  assert.equal(completed.running, false);
  assert.equal(completed.timedOut, true);
  assert.equal(completed.signal, 'SIGKILL');
  assert.match(completed.stdout, /ready/u);
  assert.match(completed.stdout, /term/u);
});

test('global and per-root command caps are shared by batch and interactive executions', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const secondRoot = path.join(env.directory, 'second-project');
  await fs.mkdir(secondRoot);
  env.config.roots.push({ ...env.config.roots[0], id: 'second', path: secondRoot });
  env.config.limits.maxConcurrentCommands = 2;
  env.config.limits.maxConcurrentCommandsPerRoot = 1;
  env.config.commandProfiles.hold = {
    program: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    allowExtraArgs: false,
    interactive: true,
    timeoutMs: 5_000,
  };
  env.config.commandProfiles.holdBatch = {
    program: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 500)'],
    allowExtraArgs: false,
    interactive: false,
    timeoutMs: 5_000,
  };
  const manager = new CommandManager(env.config, (value) => value);
  t.after(() => manager.shutdown());

  const first = manager.run({ rootId: 'project', profile: 'holdBatch' });
  await waitForCondition(() => manager.activeTotal === 1);
  await assert.rejects(
    () => manager.run({ rootId: 'project', profile: 'hold' }),
    /Concurrent command limit reached for root: project/u,
  );
  const second = await manager.run({ rootId: 'second', profile: 'hold' });
  await assert.rejects(
    () => manager.run({ rootId: 'second', profile: 'hold' }),
    /Global concurrent command limit reached/u,
  );

  manager.write({ sessionId: second.sessionId, terminate: true });
  await Promise.all([first, waitForCompletion(manager, second.sessionId)]);
});

test('completed interactive sessions are removed automatically after their TTL', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  env.config.limits.commandSessionTtlMs = 40;
  env.config.commandProfiles.short = {
    program: process.execPath,
    args: ['-e', 'process.stdout.write("done")'],
    allowExtraArgs: false,
    interactive: true,
    timeoutMs: 1_000,
  };
  const manager = new CommandManager(env.config, (value) => value);
  t.after(() => manager.shutdown());

  const started = await manager.run({ rootId: 'project', profile: 'short' });
  const completed = await waitForCompletion(manager, started.sessionId);
  assert.equal(completed.stdout, 'done');
  await delay(80);
  assert.throws(
    () => manager.write({ sessionId: started.sessionId }),
    /Unknown command session/u,
  );
});
