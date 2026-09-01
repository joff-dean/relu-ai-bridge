import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerfettoToolDefinitions, PerfettoTools, validateReadOnlySql } from '../src/perfetto-tools.mjs';
import { fixture } from './helpers.mjs';

test('PerfettoSQL validator accepts bounded reads and rejects mutations or batches', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  assert.equal(validateReadOnlySql(env.config, 'SELECT ts, value FROM counter LIMIT 10'), 'SELECT ts, value FROM counter LIMIT 10');
  assert.throws(() => validateReadOnlySql(env.config, 'WITH x AS (SELECT 1) SELECT * FROM x;'), /Only SELECT queries/);
  assert.throws(() => validateReadOnlySql(env.config, 'DROP TABLE slice'), /Only SELECT queries/);
  assert.throws(() => validateReadOnlySql(env.config, 'SELECT 1; DELETE FROM slice'), /Multiple SQL statements/);
  assert.throws(() => validateReadOnlySql(env.config, 'WITH x AS (SELECT 1) DELETE FROM slice'), /Only SELECT queries/);
  assert.equal(validateReadOnlySql(env.config, "SELECT 'DROP; RUN_METRIC' AS value FROM slice LIMIT 1"), "SELECT 'DROP; RUN_METRIC' AS value FROM slice LIMIT 1");
  assert.equal(validateReadOnlySql(env.config, 'SELECT COUNT(*) AS value FROM slice LIMIT 1'), 'SELECT COUNT(*) AS value FROM slice LIMIT 1');
  for (const query of [
    "SELECT RUN_METRIC('android/foo.sql')",
    "SELECT run_metric /* hidden */ ('android/foo.sql')",
    "SELECT \"RUN_METRIC\"('android/foo.sql')",
    "SELECT [RUN_METRIC]('android/foo.sql')",
    "SELECT `RUN_METRIC`('android/foo.sql')",
    "SELECT load_extension('unsafe')",
    "SELECT printf('%1000000000s', 'x')",
    'SELECT group_concat(name) FROM slice',
    'SELECT unknown_company_function(value) FROM slice LIMIT 1',
  ]) {
    assert.throws(() => validateReadOnlySql(env.config, query), /function is not allowed/);
  }
  assert.throws(
    () => validateReadOnlySql(env.config, 'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT n FROM x'),
    /Only SELECT queries/,
  );
  assert.throws(
    () => validateReadOnlySql(env.config, 'WITH cnt AS (SELECT 1 AS x UNION ALL SELECT x + 1 FROM cnt) SELECT max(x) FROM cnt'),
    /Only SELECT queries/,
  );
  assert.throws(
    () => validateReadOnlySql(env.config, 'SELECT (WITH cnt AS (SELECT 1 AS x UNION ALL SELECT x + 1 FROM cnt) SELECT max(x) FROM cnt) AS value'),
    /keyword is not allowed: WITH/u,
  );
});

test('Perfetto client selector rejects mixed direct and durable-session identities', () => {
  const tools = new PerfettoTools({
    perfetto: {
      getClient: (id) => ({ id }),
      resolveSessionClient: (sessionId, role) => ({ id: `${sessionId}:${role}` }),
    },
  });
  assert.throws(() => tools.targetClient({ clientId: 'client-a', sessionId: 'session-b', role: 'ref' }), /not both/);
  assert.equal(tools.targetClient({ clientId: 'client-a' }).id, 'client-a');
  assert.equal(tools.targetClient({ sessionId: 'session-b', role: 'dut' }).id, 'session-b:dut');
});

test('dedicated Perfetto selection declares the same required operationId contract', () => {
  const definitions = createPerfettoToolDefinitions();
  const selection = definitions.find((item) => item.name === 'perfetto_select_area');
  assert.ok(selection.inputSchema.required.includes('operationId'));
  assert.equal(selection.inputSchema.properties.operationId.minLength, 8);
  assert.equal(selection.inputSchema.properties.operationId.maxLength, 128);
  const align = definitions.find((item) => item.name === 'perfetto_align');
  assert.equal(align.inputSchema.required.includes('operationId'), false);
  assert.match(align.inputSchema.properties.operationId.description, /applySelection/);
});

test('detach approval and dispatch bind the durable session instance', async () => {
  const instanceId = `session_${'d'.repeat(32)}`;
  const client = { id: 'detach-client', traceBinding: 'a'.repeat(32) };
  let approval;
  let detached;
  const perfetto = {
    resolveSessionClient: () => client,
    createSnapshot: (_client, selector) => ({
      clientId: client.id,
      traceBinding: client.traceBinding,
      connection: { close() {} },
      ...selector,
    }),
    assertSnapshot: () => client,
    async detach(...args) {
      detached = args;
      return { id: args[0] };
    },
  };
  const tools = new PerfettoTools({
    perfetto,
    perfettoStore: { get: () => ({ id: 'durable_session', instanceId }) },
    approvals: { async require(input) { approval = input; } },
  });

  await tools.sessionAction({ action: 'detach', sessionId: 'durable_session', role: 'ref' }, 'mcp_session');

  assert.match(approval.scope, new RegExp(instanceId, 'u'));
  assert.equal(approval.details.instanceId, instanceId);
  assert.equal(approval.displayDetails.instanceKey, instanceId.slice(-12));
  assert.equal(detached[3], instanceId);
});

test('alignment apply approval binds the complete normalized mutation arguments', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const clients = {
    ref: { id: 'ref-client', traceBinding: 'a'.repeat(32) },
    dut: { id: 'dut-client', traceBinding: 'b'.repeat(32) },
  };
  const perfetto = {
    resolveSessionClient: (_sessionId, role) => clients[role],
    createSnapshot: (client, selector) => ({
      clientId: client.id,
      traceBinding: client.traceBinding,
      traceResourceBinding: `resource-${client.id}`,
      origin: 'http://127.0.0.1:10000',
      connection: { close() {} },
      ...selector,
    }),
    assertSnapshot: (snapshot) => (snapshot.role === 'ref' ? clients.ref : clients.dut),
    assertSessionInstance: () => {},
    approvalBinding: (client) => client.traceBinding,
  };
  const capturedHashes = [];
  const context = {
    config: env.config,
    perfetto,
    perfettoStore: { get: () => ({ id: 'alignment_session', instanceId: `session_${'c'.repeat(32)}` }) },
    connectors: {
      preparePerfettoMutation: (_snapshot, _capability, parameters) => ({
        argsHash: JSON.stringify(parameters),
      }),
    },
    approvals: { require: async () => {} },
  };
  const tools = new PerfettoTools(context);
  const base = {
    sessionId: 'alignment_session',
    refSql: 'SELECT ts, value FROM ref_values',
    dutSql: 'SELECT ts, value FROM dut_values',
    refStart: '10',
    refEnd: '20',
    operationId: 'alignment-operation-0001',
  };
  for (const trackUris of [['track://one'], ['track://two']]) {
    const approvals = [];
    context.approvals.require = async (input) => {
      approvals.push(input);
      if (approvals.length === 2) throw new Error('captured apply approval');
    };
    await assert.rejects(() => tools.align({ ...base, trackUris }), /captured apply approval/u);
    assert.match(approvals[0].scope, /session_c{32}/u);
    assert.equal(approvals[0].details.instanceId, `session_${'c'.repeat(32)}`);
    assert.match(approvals[1].scope, /session_c{32}/u);
    assert.equal(approvals[1].details.instanceId, `session_${'c'.repeat(32)}`);
    assert.match(approvals[1].details.argumentsHash, /"sessionInstanceId":"session_c{32}"/u);
    capturedHashes.push(approvals[1].details.argumentsHash);
  }
  assert.notEqual(capturedHashes[0], capturedHashes[1]);
});
