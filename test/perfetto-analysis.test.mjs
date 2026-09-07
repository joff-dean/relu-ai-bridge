import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {PerfettoAnalysisManager, createCodexAnalysisRunner} from '../src/perfetto-analysis.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function harness(runner) {
  const messages = [];
  const connection = {sendJson: (message) => messages.push(message)};
  const client = {
    id: 'perfetto_analysis_client',
    traceBinding: 'trace-binding',
    traceResourceBinding: 'resource-binding',
    connection,
    sessionId: null,
    role: null,
    origin: 'http://127.0.0.1:10000',
    plugin: {version: '0.7.0'},
    trace: {startNs: '100', endNs: '1000'},
  };
  const manager = new PerfettoAnalysisManager({runner});
  manager.attach({
    bridge: {
      getClient: () => client,
      assertSnapshot: () => client,
      resolveSessionClient: () => { throw new Error('no session'); },
    },
    focusHandler: async () => {},
  });
  return {manager, client, messages};
}

const REPORT = {
  summary: '고정 구간 분석 완료',
  findings: [{
    title: '긴 실행 구간',
    severity: 'warning',
    explanation: '선택 영역 안에서 긴 실행이 관찰되었습니다.',
    evidence: [{
      label: '근거 구간', target: 'current', startNs: '200', endNs: '300', trackUris: [],
    }],
  }],
  caveats: [],
};

test('analysis job freezes the submitted selection while the UI can move independently', async () => {
  const pending = deferred();
  let observed;
  const {manager, client, messages} = harness(async (job) => {
    observed = structuredClone(job.selection);
    return pending.promise;
  });
  const selection = {startNs: '150', endNs: '450', trackUris: ['/sched_cpu0']};
  const created = manager.start(client, {requestId: 'request_0001', selection});
  selection.startNs = '700';
  selection.trackUris.push('/sched_cpu7');
  pending.resolve(REPORT);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(observed, {startNs: '150', endNs: '450', trackUris: ['/sched_cpu0']});
  assert.equal(created.status, 'running');
  assert.equal(messages.at(-1).job.status, 'completed');
  assert.equal(messages.at(-1).job.selection.startNs, '150');
});

test('cancel stops a running job and discards a late report', async () => {
  const pending = deferred();
  const {manager, client, messages} = harness(async (_job, {signal}) => {
    await pending.promise;
    if (signal.aborted) throw Object.assign(new Error('cancelled'), {code: 'CANCELLED'});
    return REPORT;
  });
  const job = manager.start(client, {
    requestId: 'request_0002',
    selection: {startNs: '200', endNs: '400', trackUris: []},
  });
  await new Promise((resolve) => setImmediate(resolve));
  manager.cancel(client, job.id);
  assert.equal(messages.at(-1).job.status, 'cancel_requested');
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.at(-1).job.status, 'cancelled');
  assert.equal(messages.at(-1).job.report, null);
});

test('analysis evidence focus is resolved only from a completed owned job', async () => {
  const focused = [];
  const {manager, client, messages} = harness(async () => REPORT);
  manager.attach({
    bridge: {
      getClient: () => client,
      assertSnapshot: () => client,
      resolveSessionClient: () => { throw new Error('no session'); },
    },
    focusHandler: async (...args) => focused.push(args),
  });
  const job = manager.start(client, {
    requestId: 'request_0003',
    selection: {startNs: '200', endNs: '400', trackUris: []},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.at(-1).job.status, 'completed');
  await manager.focus(client, {
    jobId: job.id,
    findingIndex: 0,
    evidenceIndex: 0,
    operationId: 'focus_000001',
  });
  assert.equal(focused.length, 1);
  assert.equal(focused[0][1].startNs, '200');
  await assert.rejects(
    manager.focus(client, {
      jobId: job.id, findingIndex: 9, evidenceIndex: 0, operationId: 'focus_000002',
    }),
    /unavailable/u,
  );
});

test('invalid or out-of-trace analysis selections fail before a runner starts', () => {
  let calls = 0;
  const {manager, client} = harness(async () => { calls += 1; return REPORT; });
  assert.throws(() => manager.start(client, {
    requestId: 'request_0004',
    selection: {startNs: '50', endNs: '200', trackUris: []},
  }), /outside/u);
  assert.equal(calls, 0);
});

test('analysis manager bounds global Codex concurrency while preserving per-tab queues', async () => {
  const pending = [deferred(), deferred(), deferred()];
  let calls = 0;
  const clients = new Map();
  const manager = new PerfettoAnalysisManager({
    runner: async () => pending[calls++].promise,
  });
  manager.attach({
    bridge: {
      getClient: (id) => clients.get(id),
      assertSnapshot: (snapshot) => clients.get(snapshot.clientId),
      resolveSessionClient: () => { throw new Error('no session'); },
    },
    focusHandler: async () => {},
  });
  for (let index = 0; index < 3; index += 1) {
    const id = `perfetto_analysis_client_${index}`;
    clients.set(id, {
      id,
      traceBinding: `trace-binding-${index}`,
      traceResourceBinding: `resource-binding-${index}`,
      connection: {sendJson: () => {}},
      sessionId: null,
      role: null,
      origin: 'http://127.0.0.1:10000',
      plugin: {version: '0.7.0'},
      trace: {startNs: '100', endNs: '1000'},
    });
    manager.start(clients.get(id), {
      requestId: `request_concurrency_${index}`,
      selection: {startNs: '200', endNs: '400', trackUris: []},
    });
  }
  assert.equal(calls, 2);
  pending[0].resolve(REPORT);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  pending[1].resolve(REPORT);
  pending[2].resolve(REPORT);
  await new Promise((resolve) => setImmediate(resolve));
});

test('Codex runner uses fixed argument arrays, read-only sandbox, and no credential arguments', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-analysis-runner-test-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  let invocation;
  const spawnImpl = (command, args, options) => {
    invocation = {command, args, options};
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const outputIndex = args.indexOf('--output-last-message') + 1;
    setImmediate(async () => {
      await fs.writeFile(args[outputIndex], JSON.stringify(REPORT));
      child.emit('exit', 0, null);
    });
    return child;
  };
  const runner = createCodexAnalysisRunner({
    codexCli: '/verified/codex',
    nodePath: '/verified/node',
    proxyPath: '/verified/codex-mcp-proxy.mjs',
    schemaPath: '/verified/analysis-output.schema.json',
    cwd: temporary,
    outputDir: path.join(temporary, 'private-output'),
    spawnImpl,
  });
  const result = await runner({
    id: 'analysis_0123456789abcdef', clientId: 'perfetto_client',
    sessionId: null, role: null,
    selection: {startNs: '100', endNs: '200', trackUris: []},
  }, {signal: new AbortController().signal, onProgress: () => {}});

  assert.deepEqual(result, REPORT);
  assert.equal(invocation.command, '/verified/codex');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.includes('--skip-git-repo-check'), true);
  assert.equal(Object.keys(invocation.options.env).some((name) =>
    /token|secret|password|credential|authorization|auth|api[_-]?key|(^|_)key($|_)/iu.test(name)), false);
  assert.equal(invocation.args.includes('--ignore-user-config'), true);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--sandbox'), invocation.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.doesNotMatch(invocation.args.join('\n'), /token|authorization|bearer/iu);
});
