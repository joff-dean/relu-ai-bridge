import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AuditLog } from '../src/audit.mjs';
import { ApprovalRequiredError, ApprovalStore } from '../src/approvals.mjs';
import {
  computePerfettoClientProof,
  computePerfettoServerProof,
  computeTraceBinding,
  PerfettoBroker,
} from '../src/perfetto-broker.mjs';
import { PerfettoSessionStore } from '../src/perfetto-store.mjs';
import { fixture } from './helpers.mjs';

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
  }
  sendJson(value) { this.sent.push(value); }
  ping() {}
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close', code, reason);
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForHelloAck(connection) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const acknowledgment = connection.sent.findLast((item) => item.type === 'hello_ack');
    if (acknowledgment) return acknowledgment;
    if (connection.closed) throw new Error('Perfetto connector closed before hello acknowledgment');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Perfetto connector hello was not acknowledged');
}

async function authenticatePerfetto(connection, token, input) {
  const origin = input.origin ?? 'http://127.0.0.1:10000';
  const pluginId = input.pluginId ?? 'io.company.RELUPerfettoBridge';
  const client = {
    clientId: input.clientId,
    pluginId,
    pluginVersion: input.pluginVersion ?? '0.3.0',
  };
  const trace = {
    traceId: input.traceId,
    title: input.title ?? input.traceId,
    sourceUrl: input.sourceUrl ?? '',
    startNs: input.startNs ?? '0',
    endNs: input.endNs ?? '100',
    traceTypes: input.traceTypes ?? [],
    hasFtrace: input.hasFtrace ?? false,
    importErrors: input.importErrors ?? 0,
  };
  const clientNonce = crypto.randomBytes(32).toString('hex');
  connection.emit('message', JSON.stringify({
    type: 'auth_challenge',
    protocolVersion: '1.0',
    clientNonce,
    audience: { origin, pluginId },
  }));
  await tick();
  const challengeAck = connection.sent.at(-1);
  assert.equal(challengeAck.type, 'auth_challenge_ack');
  assert.equal(challengeAck.clientNonce, clientNonce);
  assert.equal(challengeAck.serverProof, computePerfettoServerProof(token, {
    origin, pluginId, clientNonce, serverNonce: challengeAck.serverNonce,
  }));
  assert.doesNotMatch(JSON.stringify(connection.sent), new RegExp(token, 'u'));
  const authResponse = {
    type: 'auth_response',
    protocolVersion: '1.0',
    clientNonce,
    serverNonce: challengeAck.serverNonce,
    audience: { origin, pluginId },
    clientProof: computePerfettoClientProof(token, {
      origin, pluginId, clientNonce, serverNonce: challengeAck.serverNonce, client, trace,
    }),
    client,
    trace,
  };
  connection.emit('message', JSON.stringify(authResponse));
  await waitForHelloAck(connection);
  return { clientNonce, challengeAck, client, trace, authResponse };
}

test('broker authenticates, routes a request, and restores durable REF assignment', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const session = await store.create({ name: 'pair' });
  const binding = computeTraceBinding({
    origin: 'http://127.0.0.1:10000',
    pluginId: 'io.company.RELUPerfettoBridge',
    clientId: 'stable_client',
    traceId: 'trace-a',
  });
  await store.attach(session.id, 'ref', 'stable_client', binding);
  const audit = new AuditLog(env.config, (value) => value);
  const approvals = new ApprovalStore(env.config);
  await approvals.initialize();
  const broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });

  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });
  await authenticatePerfetto(connection, env.config.perfetto.token, {
    clientId: 'stable_client', pluginVersion: '0.1.0', traceId: 'trace-a', title: 'REF trace',
  });
  assert.equal(broker.listClients()[0].role, 'ref');
  assert.deepEqual(connection.sent.find((message) => message.type === 'hello_ack'), {
    type: 'hello_ack', protocolVersion: '1.0', accepted: true,
    connectionId: 'stable_client', heartbeatMs: 20_000,
  });

  const pending = broker.request('stable_client', 'trace.getInfo');
  const request = connection.sent.at(-1);
  const traceInfo = {
    traceId: 'trace-a', title: 'REF trace', sourceUrl: '', startNs: '0', endNs: '100',
    traceTypes: [], hasFtrace: false, importErrors: 0,
  };
  connection.emit('message', JSON.stringify({ type: 'response', id: request.id, ok: true, result: traceInfo }));
  assert.deepEqual(await pending, traceInfo);
});

test('broker rejects a client proof made with the control token at the Perfetto audience', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const audit = new AuditLog(env.config, (value) => value);
  const approvals = new ApprovalStore(env.config);
  await approvals.initialize();
  const broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });
  const clientNonce = crypto.randomBytes(32).toString('hex');
  connection.emit('message', JSON.stringify({
    type: 'auth_challenge', protocolVersion: '1.0', clientNonce,
    audience: { origin: 'http://127.0.0.1:10000', pluginId: 'io.company.RELUPerfettoBridge' },
  }));
  await tick();
  const challengeAck = connection.sent.at(-1);
  const client = {
    clientId: 'bad_client', pluginId: 'io.company.RELUPerfettoBridge', pluginVersion: '1',
  };
  const trace = {
    traceId: 'bad', title: 'bad', sourceUrl: '', startNs: '0', endNs: '100',
    traceTypes: [], hasFtrace: false, importErrors: 0,
  };
  connection.emit('message', JSON.stringify({
    type: 'auth_response', protocolVersion: '1.0', clientNonce,
    serverNonce: challengeAck.serverNonce,
    audience: { origin: 'http://127.0.0.1:10000', pluginId: 'io.company.RELUPerfettoBridge' },
    clientProof: computePerfettoClientProof(env.config.server.token, {
      origin: 'http://127.0.0.1:10000', pluginId: 'io.company.RELUPerfettoBridge',
      clientNonce, serverNonce: challengeAck.serverNonce, client, trace,
    }),
    client,
    trace,
  }));
  await tick();
  assert.equal(connection.closed, true);
  assert.equal(broker.listClients().length, 0);
});

test('broker does not acknowledge a valid client when the connect audit cannot be committed', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const approvals = new ApprovalStore(env.config);
  await approvals.initialize();
  const audit = { append: async (event) => {
    if (event.action === 'client.connect') throw new Error('audit unavailable');
  } };
  const broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });

  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });
  await assert.rejects(
    authenticatePerfetto(connection, env.config.perfetto.token, {
      clientId: 'audit_failure_client', traceId: 'trace-audit-failure',
    }),
    /closed before hello acknowledgment/u,
  );
  assert.equal(connection.closed, true);
  assert.equal(connection.closeCode, 1008);
  assert.equal(connection.sent.some((message) => message.type === 'hello_ack' && message.accepted), false);
  assert.equal(broker.listClients().length, 0);
});

test('broker rejects legacy raw-token hello before accepting any trace context', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const audit = new AuditLog(env.config, (value) => value);
  const broker = new PerfettoBroker(env.config, store, audit, null);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });

  connection.emit('message', JSON.stringify({
    type: 'hello', protocolVersion: '1.0', token: env.config.perfetto.token,
    client: { clientId: 'legacy_client', pluginId: 'io.company.RELUPerfettoBridge' },
    trace: { traceId: 'PRIVATE_TRACE_CONTEXT' },
  }));
  await tick();

  assert.equal(connection.closed, true);
  assert.equal(broker.listClients().length, 0);
  assert.doesNotMatch(JSON.stringify(connection.sent), /PRIVATE_TRACE_CONTEXT/u);
  assert.doesNotMatch(JSON.stringify(connection.sent), new RegExp(env.config.perfetto.token, 'u'));
});

test('broker rejects replayed and out-of-order Perfetto authentication frames', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const audit = new AuditLog(env.config, (value) => value);
  const broker = new PerfettoBroker(env.config, store, audit, null);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });

  const original = new FakeConnection();
  broker.accept(original, { origin: 'http://127.0.0.1:10000' });
  const authenticated = await authenticatePerfetto(original, env.config.perfetto.token, {
    clientId: 'replay_client', traceId: 'trace-replay',
  });

  const replay = new FakeConnection();
  broker.accept(replay, { origin: 'http://127.0.0.1:10000' });
  replay.emit('message', JSON.stringify({
    type: 'auth_challenge', protocolVersion: '1.0',
    clientNonce: crypto.randomBytes(32).toString('hex'),
    audience: {
      origin: 'http://127.0.0.1:10000', pluginId: 'io.company.RELUPerfettoBridge',
    },
  }));
  await tick();
  replay.emit('message', JSON.stringify(authenticated.authResponse));
  await tick();
  assert.equal(replay.closed, true);
  assert.equal(broker.getClient('replay_client').connection, original);

  const outOfOrder = new FakeConnection();
  broker.accept(outOfOrder, { origin: 'http://127.0.0.1:10000' });
  outOfOrder.emit('message', JSON.stringify(authenticated.authResponse));
  await tick();
  assert.equal(outOfOrder.closed, true);
});

test('broker closes an incomplete Perfetto mutual-auth handshake on timeout', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const audit = new AuditLog(env.config, (value) => value);
  const broker = new PerfettoBroker(env.config, store, audit, null, { authTimeoutMs: 10 });
  t.after(async () => { broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connection.closed, true);
  assert.equal(connection.closeCode, 1008);
  assert.equal(connection.closeReason, 'authentication timeout');
  assert.equal(broker.listClients().length, 0);
});

test('broker never reflects untrusted Perfetto client error text', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const audit = new AuditLog(env.config, (value) => value);
  const approvals = new ApprovalStore(env.config);
  await approvals.initialize();
  const broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });
  await authenticatePerfetto(connection, env.config.perfetto.token, {
    clientId: 'error_client', traceId: 'trace-error', title: 'Error trace',
  });

  const pending = broker.request('error_client', 'trace.getInfo');
  const request = connection.sent.at(-1);
  connection.emit('message', JSON.stringify({
    type: 'response',
    id: request.id,
    ok: false,
    error: { code: 'REQUEST_FAILED', message: 'PRIVATE_TRACE_MARKER must never escape' },
  }));
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, 'Perfetto client request failed (REQUEST_FAILED)');
    assert.doesNotMatch(error.message, /PRIVATE_TRACE_MARKER/u);
    return true;
  });
});

test('Perfetto attach session grants bind to the MCP session, not the durable trace session', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const session = await store.create({ name: 'pair' });
  const audit = new AuditLog(env.config, (value) => value);
  const approvals = new ApprovalStore(env.config);
  await approvals.initialize();
  const broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });

  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });
  await authenticatePerfetto(connection, env.config.perfetto.token, {
    clientId: 'attach_client', pluginVersion: '0.1.0', traceId: 'trace-attach', title: 'Attach trace',
  });

  let pending;
  await assert.rejects(
    () => broker.requestAttach(session.id, 'ref', 'attach_client', 'mcp', 'mcp_session_a'),
    (error) => {
      pending = error.request;
      return error instanceof ApprovalRequiredError;
    },
  );
  assert.equal(pending.sessionId, 'mcp_session_a');
  assert.deepEqual(pending.allowedDecisions, ['once', 'session', 'always', 'deny']);
  await approvals.decide(pending.id, 'session');

  await assert.rejects(
    () => broker.requestAttach(session.id, 'ref', 'attach_client', 'mcp', 'mcp_session_b'),
    ApprovalRequiredError,
  );

  const attaching = broker.requestAttach(session.id, 'ref', 'attach_client', 'mcp', 'mcp_session_a');
  await tick();
  const request = connection.sent.at(-1);
  assert.equal(request.method, 'session.attach');
  connection.emit('message', JSON.stringify({
    type: 'response', id: request.id, ok: true,
    result: { attached: true, sessionId: session.id, role: 'REF', traceId: 'trace-attach' },
  }));
  assert.equal((await attaching).session.refClientId, 'attach_client');
});

test('broker rejects a successful response that violates the method schema', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const audit = new AuditLog(env.config, (value) => value);
  const approvals = new ApprovalStore(env.config);
  await approvals.initialize();
  const broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });
  await authenticatePerfetto(connection, env.config.perfetto.token, {
    clientId: 'invalid_result_client', traceId: 'trace-invalid', title: 'Invalid',
  });

  const pending = broker.request('invalid_result_client', 'trace.query', { sql: 'SELECT 1', maxRows: 10 });
  const request = connection.sent.at(-1);
  connection.emit('message', JSON.stringify({
    type: 'response', id: request.id, ok: true, result: { rows: [{ leaked: 'PRIVATE_RESULT' }] },
  }));

  await assert.rejects(pending, /invalid response/u);
  assert.equal(connection.closed, true);
});

test('Perfetto attach fails closed if the client changes trace after approval', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const session = await store.create({ name: 'pair' });
  const audit = new AuditLog(env.config, (value) => value);
  let broker;
  let replacement;
  const approvals = {
    async require() {
      replacement = new FakeConnection();
      broker.accept(replacement, { origin: 'http://127.0.0.1:10000' });
      await authenticatePerfetto(replacement, env.config.perfetto.token, {
        clientId: 'swapped_client', pluginVersion: '0.1.0',
        traceId: 'trace-after', title: 'Replacement trace',
      });
      return { approvedBy: 'always' };
    },
  };
  broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });

  const original = new FakeConnection();
  broker.accept(original, { origin: 'http://127.0.0.1:10000' });
  await authenticatePerfetto(original, env.config.perfetto.token, {
    clientId: 'swapped_client', pluginVersion: '0.1.0',
    traceId: 'trace-before', title: 'Original trace',
  });

  await assert.rejects(
    () => broker.requestAttach(session.id, 'dut', 'swapped_client', 'mcp', 'mcp_session'),
    /target changed after approval/,
  );
  assert.equal(store.get(session.id).dutClientId, null);
  assert.equal(replacement.sent.some((message) => message.method === 'session.attach'), false);
});

test('Perfetto attach approval and commit bind the durable session instance', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const original = await store.create({ id: 'reused_session', name: 'original' });
  const audit = new AuditLog(env.config, (value) => value);
  let approval;
  let replacement;
  const approvals = {
    async require(input) {
      approval = input;
      await store.remove(original.id, original.instanceId);
      replacement = await store.create({ id: original.id, name: 'replacement' });
      return { approvedBy: 'once' };
    },
  };
  const broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'http://127.0.0.1:10000' });
  await authenticatePerfetto(connection, env.config.perfetto.token, {
    clientId: 'attach_reuse_client', traceId: 'trace-reuse', title: 'Reuse',
  });

  await assert.rejects(
    broker.requestAttach(original.id, 'ref', 'attach_reuse_client', 'mcp', 'mcp_session'),
    /session changed after approval/u,
  );
  assert.match(approval.scope, new RegExp(original.instanceId, 'u'));
  assert.equal(approval.details.instanceId, original.instanceId);
  assert.equal(approval.displayDetails.instanceKey, original.instanceId.slice(-12));
  assert.equal(store.get(original.id).instanceId, replacement.instanceId);
  assert.equal(store.get(original.id).refClientId, null);
  assert.equal(connection.sent.some((message) => message.method === 'session.attach'), false);
});

test('Perfetto detach refuses a role assignment changed after approval', async (t) => {
  const env = await fixture();
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const session = await store.create({ name: 'pair' });
  const audit = new AuditLog(env.config, (value) => value);
  const approvals = new ApprovalStore(env.config);
  await approvals.initialize();
  const broker = new PerfettoBroker(env.config, store, audit, approvals);
  t.after(async () => { broker.shutdown(); await env.cleanup(); });

  const connect = async (clientId, traceId) => {
    const connection = new FakeConnection();
    broker.accept(connection, { origin: 'http://127.0.0.1:10000' });
    await authenticatePerfetto(connection, env.config.perfetto.token, {
      clientId, pluginVersion: '0.1.0', traceId,
    });
    return connection;
  };
  await connect('detach_client_a', 'trace-a');
  await connect('detach_client_b', 'trace-b');
  const clientA = broker.getClient('detach_client_a');
  const clientB = broker.getClient('detach_client_b');
  await store.attach(session.id, 'ref', clientA.id, clientA.traceBinding);
  const approvedSnapshot = broker.createSnapshot(clientA, { sessionId: session.id, role: 'ref' });

  await store.attach(session.id, 'ref', clientB.id, clientB.traceBinding);
  await assert.rejects(
    () => broker.detach(session.id, 'ref', approvedSnapshot),
    /target changed after approval/,
  );
  assert.equal(store.get(session.id).refClientId, clientB.id);
});
