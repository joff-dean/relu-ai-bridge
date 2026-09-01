import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { ReluWebConnector } from '../sdk/relu-web-connector.js';

const options = {
  serviceId: 'battery-viewer',
  token: 'connector_token_that_is_long_enough',
  origin: 'https://battery.internal.example',
  getContext: () => ({ payloadId: 'case-1' }),
  capabilities: { get_stats: () => ({ count: 1 }) },
};

const authAudience = 'relu-ai-bridge://loopback/relu/ws';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function authPayload(role, serviceId, origin, clientNonce, serverNonce, registrationDigest = '') {
  return stableJson([
    'RELU_GENERIC_CONNECTOR_AUTH', '1.0', authAudience, role,
    serviceId, origin, clientNonce, serverNonce, registrationDigest,
  ]);
}

function authProof(token, role, serviceId, origin, clientNonce, serverNonce, registrationDigest = '') {
  return crypto.createHmac('sha256', token)
    .update(authPayload(role, serviceId, origin, clientNonce, serverNonce, registrationDigest))
    .digest('hex');
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closeCode = null;
    this.closeReason = null;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    assert.equal(this.readyState, FakeWebSocket.CONNECTING);
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open');
  }

  receive(value) {
    assert.equal(this.readyState, FakeWebSocket.OPEN);
    this.dispatch('message', { data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  send(value) {
    assert.equal(this.readyState, FakeWebSocket.OPEN);
    this.sent.push(JSON.parse(value));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
    this.closeCode = code;
    this.closeReason = reason;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatch('close', { code, reason });
    });
  }

  serverClose(code = 1006, reason = '') {
    this.close(code, reason);
  }
}

function installFakeWebSocket(t) {
  const previous = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    if (previous === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previous;
  });
}

function validAck(overrides = {}) {
  return {
    type: 'hello_ack',
    protocolVersion: '1.0',
    accepted: true,
    sessionId: 'relu_0123456789abcdef01234567',
    resumeSecret: 'resume_0123456789abcdef0123456789abcdef',
    heartbeatMs: 20_000,
    ...overrides,
  };
}

function contextGuard(payloadId = 'case-1') {
  return {
    fields: ['payloadId'],
    projection: { payloadId },
    binding: 'a'.repeat(64),
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function serverChallenge(socket, overrides = {}) {
  const init = socket.sent.find((item) => item.type === 'auth_init');
  assert.ok(init, 'auth_init was not sent');
  const serverNonce = overrides.serverNonce ?? crypto.randomBytes(32).toString('hex');
  return {
    type: 'auth_challenge',
    protocolVersion: '1.0',
    serviceId: options.serviceId,
    origin: options.origin,
    clientNonce: init.clientNonce,
    serverNonce,
    proof: authProof(options.token, 'server', options.serviceId, options.origin, init.clientNonce, serverNonce),
    ...overrides,
  };
}

async function proveServer(socket, overrides = {}) {
  socket.receive(serverChallenge(socket, overrides));
  await waitFor(
    () => socket.sent.some((item) => item.type === 'auth_response'),
    'client authentication proof was not sent',
  );
  return socket.sent.find((item) => item.type === 'auth_response');
}

async function completeHandshake(socket, acknowledgement = validAck()) {
  const response = await proveServer(socket);
  socket.receive(acknowledgement);
  await tick();
  return response;
}

test('web connector accepts only the fixed loopback bridge path and uses per-load ids', () => {
  const first = new ReluWebConnector(options);
  const second = new ReluWebConnector(options);
  assert.notEqual(first.clientId, second.clientId);
  assert.throws(() => new ReluWebConnector({ ...options, bridgeUrl: 'wss://bridge.example/relu/ws' }), /loopback/);
  assert.throws(() => new ReluWebConnector({ ...options, bridgeUrl: 'ws://127.0.0.1:5746/other' }), /loopback/);
});

test('web connector source does not persist credentials or provide dynamic execution primitives', async () => {
  const source = await fs.readFile(new URL('../sdk/relu-web-connector.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|eval\s*\(|new\s+Function|document\.cookie/);
});

test('connector follows connecting/authenticating/connected states and only serves requests after hello_ack', async (t) => {
  installFakeWebSocket(t);
  const statuses = [];
  let executions = 0;
  const connector = new ReluWebConnector({
    ...options,
    capabilities: {
      get_stats: () => {
        executions += 1;
        return { count: 7 };
      },
    },
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => connector.stop());

  await connector.start();
  assert.equal(connector.state, 'connecting');
  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.equal(connector.state, 'authenticating');
  assert.equal(socket.sent[0].type, 'auth_init');
  assert.equal(socket.sent[0].protocolVersion, '1.0');
  assert.equal(socket.sent[0].serviceId, 'battery-viewer');
  assert.match(socket.sent[0].clientNonce, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(socket.sent[0]).includes(options.token), false);
  assert.equal(JSON.stringify(socket.sent[0]).includes('case-1'), false);
  assert.equal(connector.markActive(), false);
  assert.equal(await connector.updateContext({ payloadId: 'not-yet' }), false);

  const authResponse = await completeHandshake(socket);
  assert.equal('token' in authResponse, false);
  assert.equal(JSON.stringify(authResponse).includes(options.token), false);
  assert.deepEqual(authResponse.registration.context, { payloadId: 'case-1' });
  const registrationDigest = crypto.createHash('sha256')
    .update(stableJson(authResponse.registration)).digest('hex');
  assert.equal(authResponse.proof, authProof(
    options.token, 'client', options.serviceId, options.origin,
    authResponse.clientNonce, authResponse.serverNonce, registrationDigest,
  ));
  assert.equal(connector.state, 'connected');
  assert.equal(connector.sessionId, 'relu_0123456789abcdef01234567');
  assert.deepEqual(statuses.slice(0, 3).map((status) => status.state), [
    'connecting', 'authenticating', 'connected',
  ]);

  socket.receive({ type: 'ping', nonce: 'nonce_1' });
  socket.receive({
    type: 'request', id: 'request_1', action: 'get_stats', parameters: {}, timeoutMs: 1_000,
    contextGuard: contextGuard(),
  });
  await tick();
  assert.equal(executions, 1);
  assert.deepEqual(socket.sent.find((item) => item.type === 'pong'), { type: 'pong', nonce: 'nonce_1' });
  assert.deepEqual(socket.sent.find((item) => item.id === 'request_1'), {
    type: 'response', id: 'request_1', ok: true, result: { count: 7 },
  });
});

test('a port-squatting fake bridge cannot obtain token or context without a valid server proof', async (t) => {
  installFakeWebSocket(t);
  const connector = new ReluWebConnector(options);
  t.after(() => connector.stop());
  await connector.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();

  const initWire = JSON.stringify(socket.sent);
  assert.equal(initWire.includes(options.token), false);
  assert.equal(initWire.includes('case-1'), false);
  socket.receive(serverChallenge(socket, { proof: '0'.repeat(64) }));
  await tick();

  assert.equal(connector.state, 'rejected');
  assert.equal(socket.closeCode, 1008);
  assert.deepEqual(socket.sent.map((message) => message.type), ['auth_init']);
  assert.equal(JSON.stringify(socket.sent).includes(options.token), false);
  assert.equal(JSON.stringify(socket.sent).includes('case-1'), false);
});

test('auth challenge audience changes and replay are rejected fail-closed', async (t) => {
  installFakeWebSocket(t);
  const invalidBindings = [
    { origin: 'https://lookalike.internal.example' },
    { serviceId: 'different-service' },
    { clientNonce: 'a'.repeat(64) },
  ];
  for (const override of invalidBindings) {
    const connector = new ReluWebConnector(options);
    await connector.start();
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    socket.receive(serverChallenge(socket, override));
    await tick();
    assert.equal(connector.state, 'rejected');
    assert.equal(socket.closeCode, 1008);
    assert.deepEqual(socket.sent.map((message) => message.type), ['auth_init']);
    connector.stop();
  }

  const connector = new ReluWebConnector(options);
  await connector.start();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  const challenge = serverChallenge(socket);
  socket.receive(challenge);
  await waitFor(() => socket.sent.some((item) => item.type === 'auth_response'), 'proof was not sent');
  socket.receive(challenge);
  await tick();
  assert.equal(connector.state, 'rejected');
  assert.equal(socket.closeCode, 1008);
  assert.equal(socket.sent.filter((item) => item.type === 'auth_response').length, 1);
  connector.stop();
});

test('request context guard blocks a stale approved action before the host handler runs', async (t) => {
  installFakeWebSocket(t);
  let payloadId = 'case-1';
  let executions = 0;
  const connector = new ReluWebConnector({
    ...options,
    getContext: () => ({ payloadId }),
    capabilities: { get_stats: () => { executions += 1; return { count: 1 }; } },
  });
  t.after(() => connector.stop());
  await connector.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await completeHandshake(socket);
  payloadId = 'case-2';
  socket.receive({
    type: 'request', id: 'stale_request', action: 'get_stats', parameters: {}, timeoutMs: 1_000,
    contextGuard: contextGuard('case-1'),
  });
  await tick();
  assert.equal(executions, 0);
  assert.deepEqual(socket.sent.find((item) => item.id === 'stale_request'), {
    type: 'response', id: 'stale_request', ok: false, errorCode: 'CONTEXT_CHANGED',
    error: 'Connector context changed before capability execution',
  });
});

test('request, ping, and event messages cannot run before authentication', async (t) => {
  installFakeWebSocket(t);
  let executions = 0;
  const prematureMessages = [
    { type: 'request', id: 'early', action: 'get_stats', parameters: {} },
    { type: 'ping', nonce: 'early' },
    { type: 'event', event: 'context.update', context: { payloadId: 'attacker' } },
  ];

  for (const premature of prematureMessages) {
    const connector = new ReluWebConnector({
      ...options,
      capabilities: { get_stats: () => { executions += 1; return { count: 1 }; } },
    });
    await connector.start();
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    socket.receive(premature);
    await tick();
    assert.equal(connector.state, 'rejected');
    assert.equal(socket.closeCode, 1008);
    assert.deepEqual(socket.sent.map((item) => item.type), ['auth_init']);
    connector.stop();
  }
  assert.equal(executions, 0);
});

test('hello_ack fields are validated strictly before the connector becomes connected', async (t) => {
  installFakeWebSocket(t);
  const invalidAcks = [
    validAck({ protocolVersion: '2.0' }),
    validAck({ accepted: 'yes' }),
    (() => { const value = validAck(); delete value.sessionId; return value; })(),
    validAck({ sessionId: 'invalid session id' }),
    (() => { const value = validAck(); delete value.resumeSecret; return value; })(),
    validAck({ resumeSecret: 'short' }),
    validAck({ unexpected: true }),
    {
      type: 'hello_ack', protocolVersion: '1.0', accepted: false,
      errorCode: 'AUTHENTICATION_FAILED', sessionId: 'relu_unexpected',
    },
  ];

  for (const acknowledgement of invalidAcks) {
    const connector = new ReluWebConnector(options);
    await connector.start();
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    await proveServer(socket);
    socket.receive(acknowledgement);
    await tick();
    assert.equal(connector.state, 'rejected');
    assert.equal(connector.sessionId, null);
    assert.equal(socket.closeCode, 1008);
    assert.equal(connector.reconnectTimer, null);
    connector.stop();
  }
});

test('RESET_REQUIRED clears the resume secret, rotates clientId, and permits only one consecutive reset reconnect', async (t) => {
  installFakeWebSocket(t);
  const statuses = [];
  const connector = new ReluWebConnector({ ...options, onStatus: (status) => statuses.push(status) });
  t.after(() => connector.stop());
  connector.resumeSecret = 'resume_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const originalClientId = connector.clientId;

  await connector.start();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();
  const firstProof = await proveServer(firstSocket);
  assert.equal(firstProof.registration.client.resumeSecret, 'resume_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  firstSocket.receive({
    type: 'hello_ack', protocolVersion: '1.0', accepted: false,
    errorCode: 'RESET_REQUIRED', error: 'Reconnect binding expired',
  });
  await tick();

  assert.equal(connector.resumeSecret, null);
  assert.notEqual(connector.clientId, originalClientId);
  assert.equal(connector.state, 'reconnecting');
  assert.equal(statuses.some((status) => status.errorCode === 'RESET_REQUIRED'), true);

  await waitFor(() => FakeWebSocket.instances.length === 2, 'reset reconnect was not attempted');
  const secondSocket = FakeWebSocket.instances[1];
  secondSocket.open();
  const secondProof = await proveServer(secondSocket);
  assert.equal(secondProof.registration.client.clientId, connector.clientId);
  assert.equal('resumeSecret' in secondProof.registration.client, false);

  secondSocket.receive({
    type: 'hello_ack', protocolVersion: '1.0', accepted: false,
    errorCode: 'RESET_REQUIRED', error: 'Reset requested again',
  });
  await tick();
  assert.equal(connector.state, 'rejected');
  assert.equal(connector.authRejected, true);
  assert.equal(connector.reconnectTimer, null);
  assert.equal(statuses.some((status) => status.errorCode === 'RESET_LIMIT_REACHED'), true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('ordinary authentication rejection and policy close do not reconnect forever', async (t) => {
  installFakeWebSocket(t);

  const rejected = new ReluWebConnector(options);
  await rejected.start();
  const rejectedSocket = FakeWebSocket.instances[0];
  rejectedSocket.open();
  await proveServer(rejectedSocket);
  rejectedSocket.receive({
    type: 'hello_ack', protocolVersion: '1.0', accepted: false,
    error: 'Invalid connector credential',
  });
  await tick();
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.authRejected, true);
  assert.equal(rejected.reconnectTimer, null);

  const policyClosed = new ReluWebConnector(options);
  await policyClosed.start();
  const policySocket = FakeWebSocket.instances[1];
  policySocket.open();
  policySocket.serverClose(1008, 'registration rejected');
  await tick();
  assert.equal(policyClosed.state, 'rejected');
  assert.equal(policyClosed.authRejected, true);
  assert.equal(policyClosed.reconnectTimer, null);

  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(FakeWebSocket.instances.length, 2);
  rejected.stop();
  policyClosed.stop();
});
