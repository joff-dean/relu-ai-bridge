import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import test from 'node:test';
import { ConnectorBroker } from '../src/connectors.mjs';
import {
  computePerfettoClientProof,
  computePerfettoServerProof,
} from '../src/perfetto-broker.mjs';
import { createApplication } from '../src/server.mjs';
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

const emptyObject = { type: 'object', properties: {}, required: [], additionalProperties: false };
const serviceToken = 'battery_connector_token_1234567890';
const genericAuthAudience = 'relu-ai-bridge://loopback/relu/ws';
const desktopAuthAudience = 'relu-ai-bridge://loopback/relu/desktop/ws';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function authPayload(role, serviceId, origin, clientNonce, serverNonce, registrationDigest = '') {
  return stableJson([
    'RELU_GENERIC_CONNECTOR_AUTH', '1.0', genericAuthAudience, role,
    serviceId, origin, clientNonce, serverNonce, registrationDigest,
  ]);
}

function authProof(token, role, serviceId, origin, clientNonce, serverNonce, registrationDigest = '') {
  return crypto.createHmac('sha256', token)
    .update(authPayload(role, serviceId, origin, clientNonce, serverNonce, registrationDigest))
    .digest('hex');
}

function desktopAuthPayload(
  role, serviceId, appId, instanceId, clientNonce, serverNonce, registrationDigest = '',
) {
  return stableJson([
    'RELU_DESKTOP_CONNECTOR_AUTH', '1.0', desktopAuthAudience, role,
    serviceId, appId, instanceId, clientNonce, serverNonce, registrationDigest,
  ]);
}

function desktopAuthProof(
  token, role, serviceId, appId, instanceId, clientNonce, serverNonce, registrationDigest = '',
) {
  return crypto.createHmac('sha256', token)
    .update(desktopAuthPayload(
      role, serviceId, appId, instanceId, clientNonce, serverNonce, registrationDigest,
    ))
    .digest('hex');
}

function batteryService(overrides = {}) {
  return {
    id: 'battery-viewer',
    displayName: 'Battery Log Viewer',
    tokenEnv: 'RELU_BATTERY_CONNECTOR_TOKEN',
    token: serviceToken,
    origins: ['https://battery.internal.example'],
    bindingFields: ['payloadId'],
    contextSchema: {
      type: 'object',
      properties: {
        payloadId: { type: 'string', maxLength: 100 },
        view: { type: 'string', maxLength: 100 },
      },
      required: ['payloadId'],
      additionalProperties: false,
    },
    capabilities: [
      {
        name: 'get_stats', description: 'Get bounded stats', transport: 'browser', readOnly: true, effect: 'read',
        inputSchema: emptyObject,
        outputSchema: {
          type: 'object',
          properties: { count: { type: 'integer', minimum: 0, maximum: 100000 } },
          required: ['count'], additionalProperties: false,
        },
      },
      {
        name: 'focus_range', description: 'Focus a range', transport: 'browser', readOnly: false, effect: 'ui_mutation',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'integer', minimum: 0, maximum: 100000 },
            end: { type: 'integer', minimum: 0, maximum: 100000 },
          },
          required: ['start', 'end'], additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: { focused: { type: 'boolean' } }, required: ['focused'], additionalProperties: false },
      },
    ],
    ...overrides,
  };
}

function desktopService(overrides = {}) {
  return batteryService({
    id: 'android-log-viewer',
    displayName: 'Android Log Viewer',
    token: 'desktop_connector_token_1234567890',
    tokenEnv: 'RELU_ANDROID_LOG_VIEWER_TOKEN',
    clientKinds: ['desktop'],
    origins: [],
    desktopAppIds: ['com.relu.AndroidLogViewer'],
    bindingFields: ['logResourceId', 'datasetRevision'],
    executionGuardFields: ['logResourceId', 'datasetRevision', 'selectionRevision'],
    contextSchema: {
      type: 'object',
      properties: {
        logResourceId: { type: 'string', maxLength: 128 },
        datasetRevision: { type: 'string', maxLength: 128 },
        selectionRevision: { type: 'string', maxLength: 128 },
        view: { type: 'string', maxLength: 64 },
        label: { type: 'string', maxLength: 128 },
        sampleRate: { type: 'number', minimum: 0, maximum: 1000000 },
      },
      required: ['logResourceId', 'datasetRevision', 'selectionRevision', 'view'],
      additionalProperties: false,
    },
    capabilities: [{
      name: 'get_selection_stats', description: 'Get selected range statistics',
      transport: 'desktop', readOnly: true, effect: 'read',
      inputSchema: emptyObject,
      outputSchema: {
        type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 100000 } },
        required: ['count'], additionalProperties: false,
      },
    }, {
      name: 'focus_range', description: 'Focus a range', transport: 'desktop',
      readOnly: false, effect: 'ui_mutation',
      inputSchema: {
        type: 'object',
        properties: {
          start: { type: 'integer', minimum: 0, maximum: 100000 },
          end: { type: 'integer', minimum: 0, maximum: 100000 },
        },
        required: ['start', 'end'], additionalProperties: false,
      },
      outputSchema: {
        type: 'object', properties: { focused: { type: 'boolean' } },
        required: ['focused'], additionalProperties: false,
      },
    }],
    ...overrides,
  });
}

function configure(env, services = [batteryService()]) {
  env.config.connectors.services = services;
  env.config.connectors.allowedOrigins = [...new Set(services.flatMap((service) => service.origins))];
}

function connectorRegistration(overrides = {}) {
  return {
    client: {
      clientId: 'browser_instance_one', serviceId: 'battery-viewer', connectorVersion: '0.3.0',
      capabilities: ['get_stats', 'focus_range'],
    },
    context: { payloadId: 'case-123', view: 'timeline' },
    active: true,
    ...overrides,
  };
}

function beginAuth(connection, serviceId = 'battery-viewer', clientNonce = crypto.randomBytes(32).toString('hex')) {
  const sentBefore = connection.sent.length;
  connection.emit('message', JSON.stringify({
    type: 'auth_init', protocolVersion: '1.0', serviceId, clientNonce,
  }));
  return { challenge: connection.sent[sentBefore] ?? null, clientNonce, sentBefore };
}

function authResponse(challenge, registration, token = serviceToken, origin = 'https://battery.internal.example') {
  const serviceId = registration.client.serviceId;
  const registrationDigest = crypto.createHash('sha256').update(stableJson(registration)).digest('hex');
  return {
    type: 'auth_response', protocolVersion: '1.0', serviceId,
    clientNonce: challenge.clientNonce, serverNonce: challenge.serverNonce, registration,
    proof: authProof(token, 'client', serviceId, origin, challenge.clientNonce, challenge.serverNonce, registrationDigest),
  };
}

function hello(connection, overrides = {}) {
  const { token = serviceToken, ...registrationOverrides } = overrides;
  const registration = connectorRegistration(registrationOverrides);
  const serviceId = registration.client.serviceId;
  const origin = serviceId === 'wiki' ? 'https://wiki.internal.example' : 'https://battery.internal.example';
  const { challenge, sentBefore } = beginAuth(connection, serviceId);
  if (challenge?.type !== 'auth_challenge') return null;
  connection.sent.splice(sentBefore, 1);
  connection.emit('message', JSON.stringify(authResponse(challenge, registration, token, origin)));
  return challenge;
}

function desktopRegistration(overrides = {}) {
  return {
    client: {
      serviceId: 'android-log-viewer', clientKind: 'desktop',
      appId: 'com.relu.AndroidLogViewer', instanceId: 'wpf_instance_one',
      connectorVersion: '0.6.0', capabilities: ['get_selection_stats', 'focus_range'],
    },
    context: {
      logResourceId: 'log-001', datasetRevision: 'rev-42',
      selectionRevision: 'selection-1', view: 'timeline',
    },
    active: true,
    ...overrides,
  };
}

function beginDesktopAuth(
  connection,
  { serviceId = 'android-log-viewer', appId = 'com.relu.AndroidLogViewer', instanceId = 'wpf_instance_one',
    clientNonce = crypto.randomBytes(32).toString('hex'), audience = desktopAuthAudience } = {},
) {
  const sentBefore = connection.sent.length;
  connection.emit('message', JSON.stringify({
    type: 'auth_init', protocolVersion: '1.0', serviceId, clientKind: 'desktop',
    appId, instanceId, audience, clientNonce,
  }));
  return { challenge: connection.sent[sentBefore] ?? null, clientNonce, sentBefore };
}

function desktopAuthResponse(challenge, registration, token = 'desktop_connector_token_1234567890') {
  const { serviceId, appId, instanceId } = registration.client;
  const registrationJson = JSON.stringify(registration);
  const registrationDigest = crypto.createHash('sha256').update(registrationJson).digest('hex');
  return {
    type: 'auth_response', protocolVersion: '1.0', serviceId, clientKind: 'desktop',
    appId, instanceId, audience: desktopAuthAudience,
    clientNonce: challenge.clientNonce, serverNonce: challenge.serverNonce, registrationJson,
    proof: desktopAuthProof(
      token, 'client', serviceId, appId, instanceId,
      challenge.clientNonce, challenge.serverNonce, registrationDigest,
    ),
  };
}

function desktopRawAuthResponse(
  challenge, registrationJson,
  { token = 'desktop_connector_token_1234567890', serviceId = 'android-log-viewer',
    appId = 'com.relu.AndroidLogViewer', instanceId = 'wpf_instance_one' } = {},
) {
  const registrationDigest = crypto.createHash('sha256').update(registrationJson).digest('hex');
  return {
    type: 'auth_response', protocolVersion: '1.0', serviceId, clientKind: 'desktop',
    appId, instanceId, audience: desktopAuthAudience,
    clientNonce: challenge.clientNonce, serverNonce: challenge.serverNonce, registrationJson,
    proof: desktopAuthProof(
      token, 'client', serviceId, appId, instanceId,
      challenge.clientNonce, challenge.serverNonce, registrationDigest,
    ),
  };
}

function withDuplicateOuterField(value, field) {
  const serialized = JSON.stringify(value);
  return `{${JSON.stringify(field)}:${JSON.stringify(value[field])},${serialized.slice(1)}`;
}

function desktopHello(connection, overrides = {}) {
  const { token = 'desktop_connector_token_1234567890', ...registrationOverrides } = overrides;
  const registration = desktopRegistration(registrationOverrides);
  const { challenge, sentBefore } = beginDesktopAuth(connection, {
    serviceId: registration.client.serviceId,
    appId: registration.client.appId,
    instanceId: registration.client.instanceId,
  });
  if (challenge?.type !== 'auth_challenge') return null;
  connection.sent.splice(sentBefore, 1);
  connection.emit('message', JSON.stringify(desktopAuthResponse(challenge, registration, token)));
  return challenge;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function rawUpgrade(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for WebSocket upgrade response'));
    }, 2_000);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('connect', () => {
      const requestHeaders = {
        Host: `127.0.0.1:${port}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64'),
        ...headers,
      };
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        ...Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`),
        '', '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    });
  });
}

async function waitForRequest(connection, previousId = null) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const request = connection.sent.findLast((item) => item.type === 'request' && item.id !== previousId);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Connector request was not dispatched');
}

async function waitForHelloAck(connection) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const acknowledgment = connection.sent.findLast((item) => item.type === 'hello_ack');
    if (acknowledgment) return acknowledgment;
    if (connection.closed) throw new Error('Connector closed before hello acknowledgment');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Connector hello was not acknowledged');
}

async function waitForMethod(connection, method) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const request = connection.sent.findLast((item) => item.type === 'request' && item.method === method);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Connector request was not dispatched for ${method}`);
}

function perfettoTraceResult(traceId, title, startNs = '0', endNs = '1000') {
  return {
    traceId, title, sourceUrl: '', startNs, endNs,
    traceTypes: [], hasFtrace: false, importErrors: 0,
  };
}

async function perfettoHello(connection, token, input) {
  const origin = 'http://127.0.0.1:10000';
  const pluginId = 'io.company.RELUPerfettoBridge';
  const clientNonce = crypto.randomBytes(32).toString('hex');
  const client = {
    clientId: input.clientId, pluginId, pluginVersion: input.pluginVersion ?? '0.3.0',
  };
  const trace = perfettoTraceResult(
    input.traceId,
    input.title ?? input.traceId,
    input.startNs ?? '0',
    input.endNs ?? '1000',
  );
  connection.emit('message', JSON.stringify({
    type: 'auth_challenge', protocolVersion: '1.0', clientNonce,
    audience: { origin, pluginId },
  }));
  await tick();
  const challenge = connection.sent.at(-1);
  assert.equal(challenge.type, 'auth_challenge_ack');
  assert.equal(challenge.serverProof, computePerfettoServerProof(token, {
    origin, pluginId, clientNonce, serverNonce: challenge.serverNonce,
  }));
  connection.emit('message', JSON.stringify({
    type: 'auth_response', protocolVersion: '1.0', clientNonce,
    serverNonce: challenge.serverNonce,
    audience: { origin, pluginId },
    clientProof: computePerfettoClientProof(token, {
      origin, pluginId, clientNonce, serverNonce: challenge.serverNonce, client, trace,
    }),
    client,
    trace,
  }));
  await waitForHelloAck(connection);
  assert.doesNotMatch(JSON.stringify(connection.sent), new RegExp(token, 'u'));
}

function perfettoQueryResult(rows) {
  return {
    columns: Object.keys(rows[0] ?? {}),
    rows,
    truncated: false,
    elapsedTimeMs: 1,
    statementCount: 1,
    statementWithOutputCount: 1,
  };
}

function perfettoAreaResult(request) {
  return {
    startNs: request.params.startNs,
    endNs: request.params.endNs,
    trackUris: request.params.trackUris ?? [],
  };
}

function perfettoAttachResult(request, traceId) {
  return {
    attached: true,
    sessionId: request.params.sessionId,
    role: request.params.role,
    traceId,
  };
}

async function rpc(baseUrl, token, body, sessionId = null) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('connector registry authenticates per service and only exposes configured capabilities', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await waitForHelloAck(connection);
  assert.equal(connection.sent[0].accepted, true);
  const [session] = app.context.connectors.listSessions();
  assert.equal(session.serviceId, 'battery-viewer');
  assert.deepEqual(session.capabilities, ['get_stats', 'focus_range']);
  assert.deepEqual(app.context.connectors.getContext(session.id).context, { payloadId: 'case-123', view: 'timeline' });

  const collision = new FakeConnection();
  app.context.connectors.accept(collision, { origin: 'https://battery.internal.example' });
  hello(collision);
  await settle();
  assert.equal(collision.closed, true);
  assert.equal(app.context.connectors.listSessions().length, 1);

  const reconnect = new FakeConnection();
  app.context.connectors.accept(reconnect, { origin: 'https://battery.internal.example' });
  hello(reconnect, {
    client: {
      clientId: 'browser_instance_one', serviceId: 'battery-viewer', connectorVersion: '0.3.0',
      capabilities: ['get_stats', 'focus_range'], resumeSecret: connection.sent[0].resumeSecret,
    },
  });
  await settle();
  assert.equal(reconnect.sent[0].sessionId, session.id);
  assert.equal(connection.closed, true);

  const compromised = new FakeConnection();
  app.context.connectors.accept(compromised, { origin: 'https://battery.internal.example' });
  hello(compromised, {
    client: {
      clientId: 'compromised_instance', serviceId: 'battery-viewer', connectorVersion: '0.3.0',
      capabilities: ['get_stats', 'admin.delete'],
    },
  });
  await settle();
  assert.equal(compromised.closed, true);
  assert.equal(app.context.connectors.listSessions().length, 1);
});

test('generic connector uses fresh audience-bound mutual proofs and never sends its raw token', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });

  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  const { challenge, clientNonce } = beginAuth(connection);
  assert.equal(challenge.type, 'auth_challenge');
  assert.match(challenge.serverNonce, /^[a-f0-9]{64}$/u);
  assert.notEqual(challenge.serverNonce, clientNonce);
  assert.equal(challenge.origin, 'https://battery.internal.example');
  assert.equal(challenge.serviceId, 'battery-viewer');
  assert.equal(challenge.proof, authProof(
    serviceToken, 'server', 'battery-viewer', 'https://battery.internal.example',
    clientNonce, challenge.serverNonce,
  ));
  assert.equal(JSON.stringify(challenge).includes(serviceToken), false);
  assert.equal(JSON.stringify(challenge).includes('case-123'), false);

  const registration = connectorRegistration();
  const response = authResponse(challenge, registration);
  assert.equal('token' in response, false);
  assert.equal(JSON.stringify(response).includes(serviceToken), false);
  connection.emit('message', JSON.stringify(response));
  await waitForHelloAck(connection);
  assert.equal(connection.sent.at(-1).accepted, true);
  assert.equal(app.context.connectors.listSessions().length, 1);

  const other = new FakeConnection();
  app.context.connectors.accept(other, { origin: 'https://battery.internal.example' });
  const otherChallenge = beginAuth(other).challenge;
  assert.notEqual(otherChallenge.serverNonce, challenge.serverNonce);
});

test('desktop connector auth compatibility vector is stable across implementations', async () => {
  const vector = JSON.parse(await fs.readFile(
    new URL('../compat/desktop-auth-v1.json', import.meta.url), 'utf8',
  ));
  assert.equal(stableJson(vector.registration), vector.registrationJson);
  assert.equal(
    crypto.createHash('sha256').update(vector.registrationJson).digest('hex'),
    vector.registrationDigest,
  );
  assert.equal(desktopAuthPayload(
    'server', vector.serviceId, vector.appId, vector.instanceId,
    vector.clientNonce, vector.serverNonce,
  ), vector.serverPayload);
  assert.equal(desktopAuthProof(
    vector.token, 'server', vector.serviceId, vector.appId, vector.instanceId,
    vector.clientNonce, vector.serverNonce,
  ), vector.serverProof);
  assert.equal(desktopAuthPayload(
    'client', vector.serviceId, vector.appId, vector.instanceId,
    vector.clientNonce, vector.serverNonce, vector.registrationDigest,
  ), vector.clientPayload);
  assert.equal(desktopAuthProof(
    vector.token, 'client', vector.serviceId, vector.appId, vector.instanceId,
    vector.clientNonce, vector.serverNonce, vector.registrationDigest,
  ), vector.clientProof);
  for (const edge of vector.rawRegistrationCases) {
    const digest = crypto.createHash('sha256').update(edge.registrationJson).digest('hex');
    assert.equal(digest, edge.registrationDigest, edge.name);
    assert.equal(desktopAuthPayload(
      'client', vector.serviceId, vector.appId, vector.instanceId,
      vector.clientNonce, vector.serverNonce, digest,
    ), edge.clientPayload, edge.name);
    assert.equal(desktopAuthProof(
      vector.token, 'client', vector.serviceId, vector.appId, vector.instanceId,
      vector.clientNonce, vector.serverNonce, digest,
    ), edge.clientProof, edge.name);
  }
});

test('desktop connector uses a dedicated app and instance bound mutual-HMAC transcript', async (t) => {
  const env = await fixture();
  configure(env, [desktopService()]);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });

  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { clientKind: 'desktop' });
  const { challenge, clientNonce } = beginDesktopAuth(connection);
  assert.deepEqual(new Set(Object.keys(challenge)), new Set([
    'type', 'protocolVersion', 'serviceId', 'clientKind', 'appId', 'instanceId',
    'audience', 'clientNonce', 'serverNonce', 'proof',
  ]));
  assert.equal(challenge.clientKind, 'desktop');
  assert.equal(challenge.audience, desktopAuthAudience);
  assert.equal(challenge.appId, 'com.relu.AndroidLogViewer');
  assert.equal(challenge.instanceId, 'wpf_instance_one');
  assert.equal(challenge.proof, desktopAuthProof(
    desktopService().token, 'server', desktopService().id,
    'com.relu.AndroidLogViewer', 'wpf_instance_one', clientNonce, challenge.serverNonce,
  ));
  assert.equal(JSON.stringify(challenge).includes(desktopService().token), false);
  assert.equal(JSON.stringify(challenge).includes('log-001'), false);

  connection.emit('message', JSON.stringify(desktopAuthResponse(challenge, desktopRegistration())));
  await waitForHelloAck(connection);
  const [session] = app.context.connectors.listSessions();
  assert.equal(session.clientKind, 'desktop');
  assert.equal(session.appId, 'com.relu.AndroidLogViewer');
  assert.equal(session.clientKey, session.pageKey);
  assert.deepEqual(session.capabilities, ['get_selection_stats', 'focus_range']);
  assert.doesNotMatch(JSON.stringify(connection.sent), new RegExp(desktopService().token, 'u'));

  const replay = new FakeConnection();
  app.context.connectors.accept(replay, { clientKind: 'desktop' });
  beginDesktopAuth(replay);
  replay.emit('message', JSON.stringify(desktopAuthResponse(challenge, desktopRegistration({
    client: { ...desktopRegistration().client, instanceId: 'wpf_replay_other' },
  }))));
  await settle();
  assert.equal(replay.closed, true);
  assert.equal(app.context.connectors.listSessions().length, 1);
});

test('desktop registrationJson binds exact UTF-8 bytes without cross-language number or escape canonicalization', async (t) => {
  const env = await fixture();
  configure(env, [desktopService()]);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });

  const instanceId = 'wpf_noncanonical_json';
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { clientKind: 'desktop' });
  const challenge = beginDesktopAuth(connection, { instanceId }).challenge;
  const client = {
    ...desktopRegistration().client,
    instanceId,
  };
  const registrationJson = [
    '{',
    '  "context": {"sampleRate":1e3,"label":"\\uBD84\\uC11D","view":"timeline",',
    '    "selectionRevision":"selection-1","datasetRevision":"rev-42","logResourceId":"log-001"},',
    `  "client": ${JSON.stringify(client)},`,
    '  "active": true',
    '}',
  ].join('\n');
  connection.emit('message', JSON.stringify(desktopRawAuthResponse(
    challenge, registrationJson, { instanceId },
  )));
  await waitForHelloAck(connection);
  const sessionId = app.context.connectors.listSessions()[0].id;
  const context = app.context.connectors.getContext(sessionId).context;
  assert.equal(context.label, '분석');
  assert.equal(context.sampleRate, 1000);
});

test('desktop app restart rotates an in-memory resume secret only after the old session is gone', async (t) => {
  const env = await fixture();
  configure(env, [desktopService()]);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });

  const first = new FakeConnection();
  app.context.connectors.accept(first, { clientKind: 'desktop' });
  desktopHello(first);
  const firstAck = await waitForHelloAck(first);
  const firstSessionId = firstAck.sessionId;
  const firstSecret = firstAck.resumeSecret;
  first.close(1000, 'desktop app exited');
  await tick();
  assert.equal(app.context.connectors.listSessions().length, 0);

  const restarted = new FakeConnection();
  app.context.connectors.accept(restarted, { clientKind: 'desktop' });
  desktopHello(restarted);
  const restartAck = await waitForHelloAck(restarted);
  assert.equal(restartAck.sessionId, firstSessionId);
  assert.notEqual(restartAck.resumeSecret, firstSecret);
  assert.equal(app.context.connectors.listSessions().length, 1);

  const takeover = new FakeConnection();
  app.context.connectors.accept(takeover, { clientKind: 'desktop' });
  desktopHello(takeover);
  await settle();
  assert.equal(takeover.closed, true);
  assert.equal(takeover.sent.some((message) => message.type === 'hello_ack' && message.accepted), false);
  assert.equal(app.context.connectors.listSessions()[0].id, firstSessionId);

  const authenticatedReconnect = new FakeConnection();
  app.context.connectors.accept(authenticatedReconnect, { clientKind: 'desktop' });
  desktopHello(authenticatedReconnect, {
    client: { ...desktopRegistration().client, resumeSecret: restartAck.resumeSecret },
  });
  const reconnectAck = await waitForHelloAck(authenticatedReconnect);
  assert.equal(reconnectAck.sessionId, firstSessionId);
  assert.equal(restarted.closed, true);
});

test('desktop connector rejects Origin, wrong audience, unallowlisted apps, and identity tampering', async (t) => {
  const env = await fixture();
  configure(env, [desktopService()]);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });

  for (const input of [
    { metadata: { clientKind: 'desktop', origin: 'https://battery.internal.example' }, init: {} },
    { metadata: { clientKind: 'desktop' }, init: { audience: 'relu-ai-bridge://loopback/relu/ws' } },
    { metadata: { clientKind: 'desktop' }, init: { appId: 'com.attacker.LogViewer' } },
  ]) {
    const connection = new FakeConnection();
    app.context.connectors.accept(connection, input.metadata);
    beginDesktopAuth(connection, input.init);
    await settle();
    assert.equal(connection.closed, true);
    assert.equal(connection.sent.length, 0);
  }

  const tampered = new FakeConnection();
  app.context.connectors.accept(tampered, { clientKind: 'desktop' });
  const challenge = beginDesktopAuth(tampered).challenge;
  const response = desktopAuthResponse(challenge, desktopRegistration());
  response.registrationJson = response.registrationJson.replace(
    'com.relu.AndroidLogViewer', 'com.relu.OtherViewer',
  );
  tampered.emit('message', JSON.stringify(response));
  await settle();
  assert.equal(tampered.closed, true);
  assert.equal(app.context.connectors.listSessions().length, 0);

  const duplicate = new FakeConnection();
  const instanceId = 'wpf_duplicate_json';
  app.context.connectors.accept(duplicate, { clientKind: 'desktop' });
  const duplicateChallenge = beginDesktopAuth(duplicate, { instanceId }).challenge;
  const duplicateRegistration = desktopRegistration({
    client: { ...desktopRegistration().client, instanceId },
  });
  const duplicateJson = JSON.stringify(duplicateRegistration).replace('{', '{"active":false,');
  duplicate.emit('message', JSON.stringify(desktopRawAuthResponse(
    duplicateChallenge, duplicateJson, { instanceId },
  )));
  await settle();
  assert.equal(duplicate.closed, true);
  assert.equal(app.context.connectors.listSessions().length, 0);
});

test('desktop connector rejects duplicate identity and proof keys in the outer WebSocket envelope', async (t) => {
  const env = await fixture();
  configure(env, [desktopService()]);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });

  const duplicateInit = new FakeConnection();
  app.context.connectors.accept(duplicateInit, { clientKind: 'desktop' });
  const init = {
    type: 'auth_init', protocolVersion: '1.0', serviceId: 'android-log-viewer',
    clientKind: 'desktop', appId: 'com.relu.AndroidLogViewer', instanceId: 'wpf_duplicate_init',
    audience: desktopAuthAudience, clientNonce: crypto.randomBytes(32).toString('hex'),
  };
  duplicateInit.emit('message', withDuplicateOuterField(init, 'serviceId'));
  await settle();
  assert.equal(duplicateInit.closed, true);
  assert.equal(duplicateInit.sent.length, 0);

  for (const field of ['appId', 'proof', 'registrationJson']) {
    const instanceId = `wpf_duplicate_${field.toLowerCase()}`;
    const connection = new FakeConnection();
    app.context.connectors.accept(connection, { clientKind: 'desktop' });
    const challenge = beginDesktopAuth(connection, { instanceId }).challenge;
    const registration = desktopRegistration({
      client: { ...desktopRegistration().client, instanceId },
    });
    const response = desktopAuthResponse(challenge, registration);
    connection.emit('message', withDuplicateOuterField(response, field));
    await settle();
    assert.equal(connection.closed, true, field);
    assert.equal(
      connection.sent.some((message) => message.type === 'hello_ack' && message.accepted),
      false,
      field,
    );
  }
  assert.equal(app.context.connectors.listSessions().length, 0);
});

test('desktop resource approvals persist across guarded selection changes while stale dispatch fails closed', async (t) => {
  const env = await fixture();
  configure(env, [desktopService()]);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { clientKind: 'desktop' });
  desktopHello(connection);
  await waitForHelloAck(connection);
  const sessionId = app.context.connectors.listSessions()[0].id;
  const requestContext = { mcpSessionId: 'mcp_desktop_binding' };

  const blocked = await app.context.mcp.callTool('execute', {
    sessionId, action: 'get_selection_stats', parameters: {},
  }, requestContext);
  assert.equal(blocked.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'always');
  const firstExecution = app.context.mcp.callTool('execute', {
    sessionId, action: 'get_selection_stats', parameters: {},
  }, requestContext);
  const firstRequest = await waitForRequest(connection);
  assert.deepEqual(firstRequest.contextGuard.fields, [
    'logResourceId', 'datasetRevision', 'selectionRevision',
  ]);
  assert.deepEqual(firstRequest.contextGuard.projection, {
    logResourceId: 'log-001', datasetRevision: 'rev-42', selectionRevision: 'selection-1',
  });
  connection.emit('message', JSON.stringify({
    type: 'response', id: firstRequest.id, ok: true, result: { count: 7 },
  }));
  assert.deepEqual((await firstExecution).structuredContent, { count: 7 });

  const stalePrepared = app.context.connectors.prepareExecution(sessionId, 'get_selection_stats', {});
  const beforeSelection = stalePrepared.snapshot;
  connection.emit('message', JSON.stringify({
    type: 'event', event: 'context.update',
    context: {
      logResourceId: 'log-001', datasetRevision: 'rev-42',
      selectionRevision: 'selection-2', view: 'timeline',
    },
    active: true,
  }));
  await tick();
  const afterSelection = app.context.connectors.createSnapshot(sessionId, 'get_selection_stats');
  assert.equal(afterSelection.contextBinding, beforeSelection.contextBinding);
  assert.notEqual(afterSelection.executionBinding, beforeSelection.executionBinding);
  await assert.rejects(
    () => app.context.connectors.executePrepared(stalePrepared),
    /changed after approval|execution guard changed/u,
  );

  const secondExecution = app.context.mcp.callTool('execute', {
    sessionId, action: 'get_selection_stats', parameters: {},
  }, requestContext);
  const secondRequest = await waitForRequest(connection, firstRequest.id);
  assert.equal(secondRequest.contextGuard.projection.selectionRevision, 'selection-2');
  connection.emit('message', JSON.stringify({
    type: 'response', id: secondRequest.id, ok: true, result: { count: 9 },
  }));
  assert.deepEqual((await secondExecution).structuredContent, { count: 9 });

  const viewOnlyPrepared = app.context.connectors.prepareExecution(sessionId, 'get_selection_stats', {});
  connection.emit('message', JSON.stringify({
    type: 'event', event: 'context.update',
    context: {
      logResourceId: 'log-001', datasetRevision: 'rev-42',
      selectionRevision: 'selection-2', view: 'details',
    },
    active: true,
  }));
  await tick();
  const viewOnlyExecution = app.context.connectors.executePrepared(viewOnlyPrepared);
  const viewOnlyRequest = await waitForRequest(connection, secondRequest.id);
  connection.emit('message', JSON.stringify({
    type: 'response', id: viewOnlyRequest.id, ok: true, result: { count: 10 },
  }));
  assert.deepEqual(await viewOnlyExecution, { count: 10 });

  connection.emit('message', JSON.stringify({
    type: 'event', event: 'context.update',
    context: {
      logResourceId: 'log-002', datasetRevision: 'rev-1',
      selectionRevision: 'selection-1', view: 'timeline',
    },
    active: true,
  }));
  await tick();
  const changedResource = await app.context.mcp.callTool('execute', {
    sessionId, action: 'get_selection_stats', parameters: {},
  }, requestContext);
  assert.equal(changedResource.structuredContent.error, 'APPROVAL_REQUIRED');
});

test('desktop connector exposes only fixed allowlisted failure guidance', async (t) => {
  const env = await fixture();
  configure(env, [desktopService()]);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { clientKind: 'desktop' });
  desktopHello(connection);
  await waitForHelloAck(connection);
  const sessionId = app.context.connectors.listSessions()[0].id;
  const requestContext = { mcpSessionId: 'mcp_desktop_failure_code' };

  const blocked = await app.context.mcp.callTool('execute', {
    sessionId, action: 'get_selection_stats', parameters: {},
  }, requestContext);
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'always');

  const staleCall = app.context.mcp.callTool('execute', {
    sessionId, action: 'get_selection_stats', parameters: {},
  }, requestContext);
  const staleRequest = await waitForRequest(connection);
  connection.emit('message', JSON.stringify({
    type: 'response', id: staleRequest.id, ok: false,
    errorCode: 'CONTEXT_CHANGED', error: 'sensitive/raw/log/line',
  }));
  const staleResult = await staleCall;
  assert.equal(staleResult.structuredContent.error, 'TOOL_ERROR');
  assert.match(staleResult.structuredContent.message, /call get_context and retry/u);
  assert.doesNotMatch(staleResult.structuredContent.message, /sensitive|raw|log/u);

  const untrustedCall = app.context.mcp.callTool('execute', {
    sessionId, action: 'get_selection_stats', parameters: {},
  }, requestContext);
  const untrustedRequest = await waitForRequest(connection, staleRequest.id);
  connection.emit('message', JSON.stringify({
    type: 'response', id: untrustedRequest.id, ok: false,
    errorCode: 'ATTACKER_CONTROLLED', error: 'sensitive/raw/log/line',
  }));
  const untrustedResult = await untrustedCall;
  assert.equal(untrustedResult.structuredContent.message, 'Connector action failed');
});

test('desktop mutation ledger persists its opaque app peer and validates it after restart', async (t) => {
  const env = await fixture();
  configure(env, [desktopService()]);
  let first = await createApplication({ config: env.config });
  let second = null;
  t.after(async () => { await second?.close(); await first?.close(); await env.cleanup(); });

  const connection = new FakeConnection();
  first.context.connectors.accept(connection, { clientKind: 'desktop' });
  desktopHello(connection);
  await waitForHelloAck(connection);
  const sessionId = first.context.connectors.listSessions()[0].id;
  const outcome = first.context.connectors.execute(
    sessionId, 'focus_range', { start: 10, end: 20 },
    { operationId: 'desktop-ledger-operation-0001' },
  );
  const request = await waitForRequest(connection);
  connection.emit('message', JSON.stringify({
    type: 'response', id: request.id, ok: true, result: { focused: true },
  }));
  assert.deepEqual(await outcome, { focused: true });
  await first.close();
  first = null;

  const ledger = JSON.parse(await fs.readFile(
    `${env.dataDir}/connector-operations.json`, 'utf8',
  ));
  assert.match(ledger.records[0].origin, /^relu-desktop:\/\/[a-f0-9]{64}$/u);
  assert.equal(ledger.records[0].origin.includes('AndroidLogViewer'), false);

  second = await createApplication({ config: env.config });
  assert.equal(second.context.connectors.listOperations()[0].status, 'completed');
});

test('desktop WebSocket endpoint rejects every Origin and query-string path before authentication', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  t.after(async () => { await app.close(); await env.cleanup(); });

  const browserLike = await rawUpgrade(address.port, '/relu/desktop/ws', {
    Origin: 'https://battery.internal.example',
  });
  assert.match(browserLike, /^HTTP\/1\.1 403 Forbidden/u);

  const nullOrigin = await rawUpgrade(address.port, '/relu/desktop/ws', { Origin: 'null' });
  assert.match(nullOrigin, /^HTTP\/1\.1 403 Forbidden/u);

  const query = await rawUpgrade(address.port, '/relu/desktop/ws?service=android-log-viewer');
  assert.match(query, /^HTTP\/1\.1 404 Not Found/u);

  const native = await rawUpgrade(address.port, '/relu/desktop/ws');
  assert.match(native, /^HTTP\/1\.1 101 Switching Protocols/u);
});

test('generic connector rejects wrong proofs, tampering, replay, and out-of-order authentication', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });

  const outOfOrder = new FakeConnection();
  app.context.connectors.accept(outOfOrder, { origin: 'https://battery.internal.example' });
  outOfOrder.emit('message', JSON.stringify({
    type: 'auth_response', protocolVersion: '1.0', serviceId: 'battery-viewer',
    clientNonce: 'a'.repeat(64), serverNonce: 'b'.repeat(64), registration: connectorRegistration(),
    proof: 'c'.repeat(64),
  }));
  await settle();
  assert.equal(outOfOrder.closed, true);
  assert.equal(outOfOrder.sent.length, 0);

  const wrongProof = new FakeConnection();
  app.context.connectors.accept(wrongProof, { origin: 'https://battery.internal.example' });
  const wrongChallenge = beginAuth(wrongProof).challenge;
  wrongProof.emit('message', JSON.stringify({
    ...authResponse(wrongChallenge, connectorRegistration()), proof: '0'.repeat(64),
  }));
  await settle();
  assert.equal(wrongProof.closed, true);

  const tampered = new FakeConnection();
  app.context.connectors.accept(tampered, { origin: 'https://battery.internal.example' });
  const tamperChallenge = beginAuth(tampered).challenge;
  const signed = authResponse(tamperChallenge, connectorRegistration());
  signed.registration.context.payloadId = 'attacker-changed';
  tampered.emit('message', JSON.stringify(signed));
  await settle();
  assert.equal(tampered.closed, true);

  const source = new FakeConnection();
  app.context.connectors.accept(source, { origin: 'https://battery.internal.example' });
  const sourceChallenge = beginAuth(source).challenge;
  const captured = authResponse(sourceChallenge, connectorRegistration({
    client: {
      clientId: 'browser_replay_source', serviceId: 'battery-viewer', connectorVersion: '0.3.0',
      capabilities: ['get_stats', 'focus_range'],
    },
  }));
  source.emit('message', JSON.stringify(captured));
  await waitForHelloAck(source);
  assert.equal(source.sent.at(-1).accepted, true);

  const replay = new FakeConnection();
  app.context.connectors.accept(replay, { origin: 'https://battery.internal.example' });
  const replayChallenge = beginAuth(replay).challenge;
  assert.notEqual(replayChallenge.clientNonce, captured.clientNonce);
  assert.notEqual(replayChallenge.serverNonce, captured.serverNonce);
  replay.emit('message', JSON.stringify(captured));
  await settle();
  assert.equal(replay.closed, true);
  assert.equal(app.context.connectors.listSessions().length, 1);

  const unavailableAudit = new FakeConnection();
  const originalAudit = app.context.connectors.audit;
  const sessionsBeforeAuditFailure = app.context.connectors.listSessions().length;
  app.context.connectors.audit = { append: async () => { throw new Error('audit unavailable'); } };
  app.context.connectors.accept(unavailableAudit, { origin: 'https://battery.internal.example' });
  const unavailableChallenge = beginAuth(unavailableAudit).challenge;
  unavailableAudit.emit('message', JSON.stringify(authResponse(
    unavailableChallenge,
    connectorRegistration({
      client: {
        clientId: 'browser_audit_unavailable', serviceId: 'battery-viewer', connectorVersion: '0.3.0',
        capabilities: ['get_stats', 'focus_range'],
      },
    }),
  )));
  await settle();
  app.context.connectors.audit = originalAudit;
  assert.equal(unavailableAudit.closed, true);
  assert.equal(unavailableAudit.closeCode, 1008);
  assert.equal(unavailableAudit.sent.some((message) => message.type === 'hello_ack' && message.accepted), false);
  assert.equal(app.context.connectors.listSessions().length, sessionsBeforeAuditFailure);
});

test('generic connector authentication timeout closes without receiving registration context', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  app.context.connectors.authTimeoutMs = 10;
  t.after(async () => { await app.close(); await env.cleanup(); });

  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(connection.closed, true);
  assert.equal(connection.closeCode, 1008);
  assert.equal(connection.closeReason, 'authentication timeout');
  assert.equal(connection.sent.length, 0);
  assert.equal(app.context.connectors.listSessions().length, 0);
});

test('connector message processing queue is bounded and audits a fatal burst once', async (t) => {
  const env = await fixture();
  configure(env);
  const records = [];
  const broker = new ConnectorBroker(env.config, {
    append: async (record) => { records.push(record); },
  });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });

  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  const authInit = JSON.stringify({
    type: 'auth_init', protocolVersion: '1.0', serviceId: 'battery-viewer',
    clientNonce: 'a'.repeat(64),
  });
  for (let index = 0; index < 64; index += 1) connection.emit('message', authInit);
  await settle();

  assert.equal(connection.closed, true);
  assert.equal(connection.closeCode, 1008);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].type, 'auth_challenge');
  assert.equal(broker.listSessions().length, 0);
  assert.equal(records.filter((record) => record.action === 'session.invalid-message').length, 1);
});

test('connector message processing queue enforces a byte budget as well as a frame count', async (t) => {
  const env = await fixture();
  configure(env);
  const records = [];
  const broker = new ConnectorBroker(env.config, {
    append: async (record) => { records.push(record); },
  });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });

  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  connection.emit('message', JSON.stringify({
    type: 'auth_init', protocolVersion: '1.0', serviceId: 'battery-viewer',
    clientNonce: 'b'.repeat(64),
  }));
  const largeFrame = JSON.stringify({ padding: 'x'.repeat(800 * 1024) });
  connection.emit('message', largeFrame);
  connection.emit('message', largeFrame);
  connection.emit('message', largeFrame);
  await settle();

  assert.equal(connection.closed, true);
  assert.equal(connection.closeCode, 1008);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].type, 'auth_challenge');
  assert.equal(broker.queuedMessageBytes, 0);
  assert.equal(records.filter((record) => record.action === 'session.invalid-message').length, 1);
});

test('connector credential and exact service origin are separate from the control token', async (t) => {
  const env = await fixture();
  configure(env, [batteryService(), batteryService({
    id: 'wiki', displayName: 'Wiki', tokenEnv: 'RELU_WIKI_CONNECTOR_TOKEN', token: 'wiki_connector_token_1234567890123',
    origins: ['https://wiki.internal.example'], capabilities: [{
      name: 'search', description: 'Search wiki', transport: 'browser', readOnly: true, effect: 'read',
      inputSchema: emptyObject, outputSchema: emptyObject,
    }],
  })]);
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });

  const connectorAgainstControl = await fetch(`${baseUrl}/bridge/approvals`, {
    headers: { authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(connectorAgainstControl.status, 401);

  const wrongOrigin = new FakeConnection();
  app.context.connectors.accept(wrongOrigin, { origin: 'https://wiki.internal.example' });
  hello(wrongOrigin);
  await settle();
  assert.equal(wrongOrigin.closed, true);

  const controlAgainstConnector = new FakeConnection();
  app.context.connectors.accept(controlAgainstConnector, { origin: 'https://battery.internal.example' });
  hello(controlAgainstConnector, { token: env.config.server.token });
  await settle();
  assert.equal(controlAgainstConnector.closed, true);
});

test('generic MCP flow uses scoped approval and validates connector results', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const sessionId = app.context.connectors.listSessions()[0].id;

  const listed = await app.context.mcp.callTool('list_sessions', {});
  assert.equal(listed.structuredContent.sessions[0].id, sessionId);
  const contextBlocked = await app.context.mcp.callTool('get_context', { sessionId });
  assert.equal(contextBlocked.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(contextBlocked.structuredContent.approval.id, 'always');
  const context = await app.context.mcp.callTool('get_context', { sessionId });
  assert.equal(context.structuredContent.context.payloadId, 'case-123');

  const blocked = await app.context.mcp.callTool('execute', { sessionId, action: 'get_stats', parameters: {} });
  assert.equal(blocked.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'always');
  const pending = app.context.mcp.callTool('execute', { sessionId, action: 'get_stats', parameters: {} });
  const request = await waitForRequest(connection);
  assert.equal(request.action, 'get_stats');
  assert.deepEqual(request.contextGuard.fields, ['payloadId']);
  assert.deepEqual(request.contextGuard.projection, { payloadId: 'case-123' });
  connection.emit('message', JSON.stringify({ type: 'response', id: request.id, ok: true, result: { count: 42 } }));
  assert.deepEqual((await pending).structuredContent, { count: 42 });

  const invalidPending = app.context.mcp.callTool('execute', { sessionId, action: 'get_stats', parameters: {} });
  const invalidRequest = await waitForRequest(connection, request.id);
  const connectorControlledKey = '/company/private/raw-log-line';
  connection.emit('message', JSON.stringify({
    type: 'response', id: invalidRequest.id, ok: true,
    result: { count: 'many', [connectorControlledKey]: true },
  }));
  const invalidResult = await invalidPending;
  assert.equal(invalidResult.structuredContent.error, 'TOOL_ERROR');
  assert.equal(invalidResult.structuredContent.message, 'Connector result violated the configured output contract');
  assert.equal(JSON.stringify(invalidResult).includes(connectorControlledKey), false);
});

test('mutating connector capability requires operationId before dispatch', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const sessionId = app.context.connectors.listSessions()[0].id;
  const result = await app.context.mcp.callTool('execute', {
    sessionId, action: 'focus_range', parameters: { start: 10, end: 20 },
  });
  assert.match(result.structuredContent.message, /operationId/);
  assert.equal(connection.sent.some((item) => item.type === 'request'), false);
});

test('HTTP data plane is static, schema-validated, bounded, and credential-injected by the bridge', async (t) => {
  const env = await fixture();
  const httpCapability = {
    name: 'search', description: 'Search wiki', transport: 'http', readOnly: true, effect: 'read',
    inputSchema: {
      type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'], additionalProperties: false,
    },
    outputSchema: {
      type: 'object', properties: { hits: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['hits'], additionalProperties: false,
    },
    http: { url: 'https://wiki.internal.example/api/ai/search', method: 'POST', auth: { header: 'authorization', env: 'WIKI_API_AUTH' }, timeoutMs: 1000 },
  };
  const service = batteryService({ capabilities: [httpCapability] });
  configure(env, [service]);
  let observed;
  const audit = { append: async () => {} };
  const broker = new ConnectorBroker(env.config, audit, {
    environment: { WIKI_API_AUTH: 'Bearer internal-secret' },
    fetch: async (url, options) => {
      observed = { url: String(url), options };
      return new Response(JSON.stringify({ hits: 3 }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection, {
    client: { clientId: 'browser_http_one', serviceId: 'battery-viewer', connectorVersion: '0.3.0', capabilities: [] },
  });
  await tick();
  const sessionId = broker.listSessions()[0].id;
  assert.deepEqual(await broker.execute(sessionId, 'search', { query: 'wakelock' }), { hits: 3 });
  assert.equal(observed.url, 'https://wiki.internal.example/api/ai/search');
  assert.equal(observed.options.headers.authorization, 'Bearer internal-secret');
  assert.equal(observed.options.body, '{"query":"wakelock"}');
  await assert.rejects(() => broker.execute(sessionId, 'search', { query: 'x', url: 'https://evil.example' }), /not allowed/);
});

test('persistent approvals follow bindingFields while non-binding view updates retain the grant', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const sessionId = app.context.connectors.listSessions()[0].id;

  const first = await app.context.mcp.callTool('get_context', { sessionId }, { mcpSessionId: 'mcp_binding_test' });
  await app.context.approvals.decide(first.structuredContent.approval.id, 'always');
  assert.equal((await app.context.mcp.callTool('get_context', { sessionId }, { mcpSessionId: 'mcp_binding_test' })).isError, false);

  connection.emit('message', JSON.stringify({
    type: 'event', event: 'context.update', context: { payloadId: 'case-123', view: 'details' }, active: true,
  }));
  await tick();
  const sameResource = await app.context.mcp.callTool('get_context', { sessionId }, { mcpSessionId: 'mcp_binding_test' });
  assert.equal(sameResource.isError, false);
  assert.equal(sameResource.structuredContent.context.view, 'details');

  connection.emit('message', JSON.stringify({
    type: 'event', event: 'context.update', context: { payloadId: 'case-999', view: 'details' }, active: true,
  }));
  await tick();
  const changedResource = await app.context.mcp.callTool('get_context', { sessionId }, { mcpSessionId: 'mcp_binding_test' });
  assert.equal(changedResource.structuredContent.error, 'APPROVAL_REQUIRED');
});

test('legacy browser services retain strict contextVersion dispatch guards when executionGuardFields is omitted', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await waitForHelloAck(connection);
  const sessionId = app.context.connectors.listSessions()[0].id;
  const prepared = app.context.connectors.prepareExecution(sessionId, 'get_stats', {});
  assert.equal(prepared.snapshot.executionGuardMode, 'strict_context_version');

  connection.emit('message', JSON.stringify({
    type: 'event', event: 'context.update',
    context: { payloadId: 'case-123', view: 'details' }, active: true,
  }));
  await tick();
  await assert.rejects(
    () => app.context.connectors.executePrepared(prepared),
    /context changed after approval/u,
  );
  assert.equal(connection.sent.some((item) => item.type === 'request'), false);
});

test('approval snapshot prevents dispatch after a connector context swap', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const sessionId = app.context.connectors.listSessions()[0].id;
  const blocked = await app.context.mcp.callTool('execute', {
    sessionId, action: 'get_stats', parameters: {},
  }, { mcpSessionId: 'mcp_snapshot_test' });
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'always');

  const originalRequire = app.context.approvals.require.bind(app.context.approvals);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  app.context.approvals.require = async (input) => {
    entered();
    await gate;
    return originalRequire(input);
  };
  const execution = app.context.mcp.callTool('execute', {
    sessionId, action: 'get_stats', parameters: {},
  }, { mcpSessionId: 'mcp_snapshot_test' });
  await enteredGate;
  connection.emit('message', JSON.stringify({
    type: 'event', event: 'context.update', context: { payloadId: 'case-456', view: 'timeline' }, active: true,
  }));
  await tick();
  release();
  const result = await execution;
  assert.equal(result.structuredContent.error, 'TOOL_ERROR');
  assert.match(result.structuredContent.message, /changed after approval/);
  assert.equal(connection.sent.some((item) => item.type === 'request'), false);
});

test('generic session approval is isolated between real MCP sessions', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const connectorSessionId = app.context.connectors.listSessions()[0].id;
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  const a = await rpc(baseUrl, env.config.server.token, initialize);
  const b = await rpc(baseUrl, env.config.server.token, initialize);
  const mcpA = a.response.headers.get('mcp-session-id');
  const mcpB = b.response.headers.get('mcp-session-id');
  const call = {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'get_context', arguments: { sessionId: connectorSessionId } },
  };
  const blockedA = await rpc(baseUrl, env.config.server.token, call, mcpA);
  await app.context.approvals.decide(blockedA.body.result.structuredContent.approval.id, 'session');
  assert.equal((await rpc(baseUrl, env.config.server.token, call, mcpA)).body.result.isError, false);
  const blockedB = await rpc(baseUrl, env.config.server.token, call, mcpB);
  assert.equal(blockedB.body.result.structuredContent.error, 'APPROVAL_REQUIRED');
});

test('invalid connector input is rejected before an approval request is created', async (t) => {
  const env = await fixture();
  configure(env);
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const sessionId = app.context.connectors.listSessions()[0].id;
  const before = app.context.approvals.list().pending.length;
  const invalid = await app.context.mcp.callTool('execute', {
    sessionId, action: 'get_stats', parameters: { url: 'https://evil.example' },
  }, { mcpSessionId: 'mcp_invalid_input' });
  assert.equal(invalid.structuredContent.error, 'TOOL_ERROR');
  assert.equal(app.context.approvals.list().pending.length, before);
  assert.equal(connection.sent.some((item) => item.type === 'request'), false);
});

test('mutating operation ledger deduplicates concurrent and completed operation ids', async (t) => {
  const env = await fixture();
  configure(env);
  const broker = new ConnectorBroker(env.config, { append: async () => {} });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const sessionId = broker.listSessions()[0].id;
  const parameters = { start: 10, end: 20 };
  const options = { operationId: 'focus-operation-0001' };
  const first = broker.execute(sessionId, 'focus_range', parameters, options);
  const second = broker.execute(sessionId, 'focus_range', parameters, options);
  const request = await waitForRequest(connection);
  assert.equal(connection.sent.filter((item) => item.type === 'request').length, 1);
  connection.emit('message', JSON.stringify({ type: 'response', id: request.id, ok: true, result: { focused: true } }));
  await tick();
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.listOperations()[0].status, 'completed');
  assert.deepEqual(await first, { focused: true });
  assert.deepEqual(await second, { focused: true });
  assert.deepEqual(await broker.execute(sessionId, 'focus_range', parameters, options), { focused: true });
  assert.equal(connection.sent.filter((item) => item.type === 'request').length, 1);
  await assert.rejects(() => broker.execute(sessionId, 'focus_range', { start: 11, end: 20 }, options), /different arguments/);
  await assert.rejects(() => broker.execute(sessionId, 'focus_range', parameters, { operationId: 'short' }), /8 to 128/);
});

test('browser mutation revalidates its resource after the operation ledger is persisted', async (t) => {
  const env = await fixture();
  configure(env);
  const broker = new ConnectorBroker(env.config, { append: async () => {} });
  await broker.initialize();
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const sessionId = broker.listSessions()[0].id;

  const persist = broker.persistOperations.bind(broker);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  let firstPersist = true;
  broker.persistOperations = async () => {
    if (firstPersist) {
      firstPersist = false;
      entered();
      await gate;
    }
    return persist();
  };

  const execution = broker.execute(sessionId, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'persist-snapshot-operation-01',
  });
  await enteredGate;
  connection.emit('message', JSON.stringify({
    type: 'event', event: 'context.update', context: { payloadId: 'case-after-persist', view: 'timeline' }, active: true,
  }));
  await tick();
  release();
  await assert.rejects(() => execution, /changed after approval/);
  assert.equal(connection.sent.some((item) => item.type === 'request'), false);
  assert.equal(broker.listOperations().length, 0);
});

test('a mutation error response remains ambiguous because the side effect may have happened', async (t) => {
  const env = await fixture();
  configure(env);
  const broker = new ConnectorBroker(env.config, { append: async () => {} });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const sessionId = connection.sent[0].sessionId;
  const execution = broker.execute(sessionId, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'error-response-operation-01',
  });
  const request = await waitForRequest(connection);
  connection.emit('message', JSON.stringify({ type: 'response', id: request.id, ok: false, error: 'host failed after mutation' }));
  await assert.rejects(() => execution, /action failed/);
  assert.equal(broker.listOperations()[0].status, 'ambiguous');
  await assert.rejects(() => broker.execute(sessionId, 'focus_range', { start: 30, end: 40 }, {
    operationId: 'error-response-operation-02',
  }), /ambiguous/);
});

test('read timeout keeps a busy tombstone until a late response or disconnect', async (t) => {
  const env = await fixture();
  const capability = {
    name: 'slow_read', description: 'Slow read', transport: 'browser', readOnly: true, effect: 'read',
    timeoutMs: 15, maxConcurrent: 1, inputSchema: emptyObject,
    outputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
  };
  configure(env, [batteryService({ capabilities: [capability] })]);
  const broker = new ConnectorBroker(env.config, { append: async () => {} });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection, {
    client: { clientId: 'browser_slow_read', serviceId: 'battery-viewer', connectorVersion: '0.3.0', capabilities: ['slow_read'] },
  });
  await tick();
  const sessionId = broker.listSessions()[0].id;
  const timedOut = broker.execute(sessionId, 'slow_read', {});
  const request = await waitForRequest(connection);
  await assert.rejects(() => timedOut, /timed out/);
  await assert.rejects(() => broker.execute(sessionId, 'slow_read', {}), /concurrency limit/);
  connection.emit('message', JSON.stringify({ type: 'response', id: request.id, ok: true, result: { value: 1 } }));
  await tick();
  const retried = broker.execute(sessionId, 'slow_read', {});
  const retryRequest = await waitForRequest(connection, request.id);
  connection.emit('message', JSON.stringify({ type: 'response', id: retryRequest.id, ok: true, result: { value: 2 } }));
  assert.deepEqual(await retried, { value: 2 });
});

test('ambiguous mutation survives reconnect and requires explicit local reconciliation', async (t) => {
  const env = await fixture();
  const capability = {
    ...batteryService().capabilities[1], timeoutMs: 15, maxConcurrent: 1,
  };
  configure(env, [batteryService({ capabilities: [capability] })]);
  const broker = new ConnectorBroker(env.config, { append: async () => {} });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection, {
    client: { clientId: 'browser_mutation_timeout', serviceId: 'battery-viewer', connectorVersion: '0.3.0', capabilities: ['focus_range'] },
  });
  await tick();
  const sessionId = broker.listSessions()[0].id;
  const first = broker.execute(sessionId, 'focus_range', { start: 10, end: 20 }, { operationId: 'timeout-operation-0001' });
  await waitForRequest(connection);
  await assert.rejects(() => first, /timed out/);

  const reconnect = new FakeConnection();
  broker.accept(reconnect, { origin: 'https://battery.internal.example' });
  hello(reconnect, {
    client: {
      clientId: 'browser_mutation_timeout', serviceId: 'battery-viewer', connectorVersion: '0.3.0',
      capabilities: ['focus_range'], resumeSecret: connection.sent[0].resumeSecret,
    },
  });
  await settle();
  await assert.rejects(() => broker.execute(sessionId, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'timeout-operation-0001',
  }), /ambiguous/);
  await assert.rejects(() => broker.execute(sessionId, 'focus_range', { start: 30, end: 40 }, {
    operationId: 'timeout-operation-0002',
  }), /ambiguous/);
  const [ambiguous] = broker.listOperations().filter((item) => item.status === 'ambiguous');
  assert.ok(ambiguous);
  await broker.reconcileOperation(ambiguous.id, 'confirmed_not_applied');
  const retry = broker.execute(sessionId, 'focus_range', { start: 30, end: 40 }, {
    operationId: 'timeout-operation-0002',
  });
  const request = await waitForRequest(reconnect);
  reconnect.emit('message', JSON.stringify({ type: 'response', id: request.id, ok: true, result: { focused: true } }));
  assert.deepEqual(await retry, { focused: true });
});

test('stale resume secrets return RESET_REQUIRED instead of permanent generic rejection', async (t) => {
  const env = await fixture();
  configure(env);
  const broker = new ConnectorBroker(env.config, { append: async () => {} });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });
  const connection = new FakeConnection();
  broker.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const resumeSecret = connection.sent[0].resumeSecret;
  const record = broker.resumeRecords.get('battery-viewer:browser_instance_one');
  record.expiresAt = Date.now() - 1;
  connection.close(1000, 'test expiry');
  const reconnect = new FakeConnection();
  broker.accept(reconnect, { origin: 'https://battery.internal.example' });
  hello(reconnect, {
    client: {
      clientId: 'browser_instance_one', serviceId: 'battery-viewer', connectorVersion: '0.3.0',
      capabilities: ['get_stats', 'focus_range'], resumeSecret,
    },
  });
  await settle();
  assert.equal(reconnect.sent[0].accepted, false);
  assert.equal(reconnect.sent[0].errorCode, 'RESET_REQUIRED');
});

test('mutation ambiguity is shared across tabs for the same service resource', async (t) => {
  const env = await fixture();
  const capability = { ...batteryService().capabilities[1], timeoutMs: 15, maxConcurrent: 1 };
  configure(env, [batteryService({ capabilities: [capability] })]);
  const broker = new ConnectorBroker(env.config, { append: async () => {} });
  t.after(async () => { await broker.shutdown(); await env.cleanup(); });
  const tabA = new FakeConnection();
  const tabB = new FakeConnection();
  broker.accept(tabA, { origin: 'https://battery.internal.example' });
  hello(tabA, {
    client: { clientId: 'browser_tab_a', serviceId: 'battery-viewer', connectorVersion: '0.3.0', capabilities: ['focus_range'] },
  });
  broker.accept(tabB, { origin: 'https://battery.internal.example' });
  hello(tabB, {
    client: { clientId: 'browser_tab_b', serviceId: 'battery-viewer', connectorVersion: '0.3.0', capabilities: ['focus_range'] },
  });
  await tick();
  const sessionA = tabA.sent[0].sessionId;
  const sessionB = tabB.sent[0].sessionId;
  assert.notEqual(sessionA, sessionB);
  const first = broker.execute(sessionA, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'cross-tab-operation-0001',
  });
  await waitForRequest(tabA);
  await assert.rejects(() => first, /timed out/);
  await assert.rejects(() => broker.execute(sessionB, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'cross-tab-operation-0001',
  }), /ambiguous/);
  await assert.rejects(() => broker.execute(sessionB, 'focus_range', { start: 30, end: 40 }, {
    operationId: 'cross-tab-operation-0002',
  }), /ambiguous/);
  assert.equal(tabB.sent.some((item) => item.type === 'request'), false);
});

test('operation ledger is private, durable, and never redispatches a completed id after restart', async (t) => {
  const env = await fixture();
  configure(env);
  const audit = { append: async () => {} };
  const firstBroker = new ConnectorBroker(env.config, audit);
  await firstBroker.initialize();
  const firstConnection = new FakeConnection();
  firstBroker.accept(firstConnection, { origin: 'https://battery.internal.example' });
  hello(firstConnection);
  await tick();
  const firstSession = firstConnection.sent[0].sessionId;
  const execution = firstBroker.execute(firstSession, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'durable-operation-0001',
  });
  const request = await waitForRequest(firstConnection);
  firstConnection.emit('message', JSON.stringify({ type: 'response', id: request.id, ok: true, result: { focused: true } }));
  assert.deepEqual(await execution, { focused: true });
  await firstBroker.persistChain;
  assert.equal((await fs.stat(firstBroker.operationFile)).mode & 0o777, 0o600);
  await firstBroker.shutdown();

  const secondBroker = new ConnectorBroker(env.config, audit);
  await secondBroker.initialize();
  t.after(async () => { await secondBroker.shutdown(); await env.cleanup(); });
  const secondConnection = new FakeConnection();
  secondBroker.accept(secondConnection, { origin: 'https://battery.internal.example' });
  hello(secondConnection, {
    client: { clientId: 'browser_after_restart', serviceId: 'battery-viewer', connectorVersion: '0.3.0', capabilities: ['get_stats', 'focus_range'] },
  });
  await tick();
  await assert.rejects(() => secondBroker.execute(secondConnection.sent[0].sessionId, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'durable-operation-0001',
  }), /already completed/);
  assert.equal(secondConnection.sent.some((item) => item.type === 'request'), false);
});

test('a persisted pending mutation is recovered as ambiguous after a process restart', async (t) => {
  const env = await fixture();
  configure(env);
  const audit = { append: async () => {} };
  const firstBroker = new ConnectorBroker(env.config, audit);
  await firstBroker.initialize();
  const connection = new FakeConnection();
  firstBroker.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection);
  await tick();
  const execution = firstBroker.execute(connection.sent[0].sessionId, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'crash-pending-operation-01',
  });
  await waitForRequest(connection);
  await firstBroker.persistChain;

  const recovered = new ConnectorBroker(env.config, audit);
  await recovered.initialize();
  assert.equal(recovered.listOperations()[0].status, 'ambiguous');
  assert.equal(recovered.listOperations()[0].reason, 'server-restart');
  t.after(async () => {
    execution.catch(() => {});
    await firstBroker.shutdown();
    await recovered.shutdown();
    await env.cleanup();
  });
});

test('HTTP operation reconciliation requires a separate local once approval', async (t) => {
  const env = await fixture();
  // Even the trusted default cannot bypass a once-only ambiguous-operation
  // interlock; an operator must still confirm the observed external state.
  env.config.approvals.policy = 'trusted_always';
  const capability = { ...batteryService().capabilities[1], timeoutMs: 15, maxConcurrent: 1 };
  configure(env, [batteryService({ capabilities: [capability] })]);
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.connectors.accept(connection, { origin: 'https://battery.internal.example' });
  hello(connection, {
    client: { clientId: 'browser_reconcile_api', serviceId: 'battery-viewer', connectorVersion: '0.3.0', capabilities: ['focus_range'] },
  });
  await waitForHelloAck(connection);
  const execution = app.context.connectors.execute(connection.sent[0].sessionId, 'focus_range', { start: 10, end: 20 }, {
    operationId: 'reconcile-api-operation-01',
  });
  await waitForRequest(connection);
  await assert.rejects(() => execution, /timed out/);
  const operation = app.context.connectors.listOperations()[0];
  const headers = { authorization: `Bearer ${env.config.server.token}`, 'content-type': 'application/json' };
  const target = `${baseUrl}/api/v1/relu/operations/${operation.id}/reconcile`;
  const body = JSON.stringify({ decision: 'confirmed_not_applied' });
  const invalid = await fetch(target, {
    method: 'POST', headers, body: JSON.stringify({ decision: 'retry_anyway' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(app.context.approvals.list().pending.length, 0);
  const blocked = await fetch(target, { method: 'POST', headers, body });
  assert.equal(blocked.status, 409);
  const pending = app.context.approvals.list().pending.find((item) => item.scope.includes(operation.id));
  assert.ok(pending);
  assert.deepEqual(pending.allowedDecisions, ['once', 'deny']);
  await assert.rejects(() => app.context.approvals.decide(pending.id, 'always'), /does not permit/);
  await app.context.approvals.decide(pending.id, 'once');
  const reconciled = await fetch(target, { method: 'POST', headers, body });
  assert.equal(reconciled.status, 200);
  assert.equal(app.context.connectors.listOperations().length, 0);
  assert.equal(connection.closed, true);
  const repeated = await fetch(target, { method: 'POST', headers, body });
  assert.notEqual(repeated.status, 200);
});

test('generic RELU facade executes Perfetto trace, query, and selection capabilities', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const connection = new FakeConnection();
  app.context.perfetto.accept(connection, { origin: 'http://127.0.0.1:10000' });
  await perfettoHello(connection, env.config.perfetto.token, {
    clientId: 'perfetto_generic_client', traceId: 'trace-generic', title: 'Generic trace',
  });
  const sessionId = 'perfetto:perfetto_generic_client';
  const requestContext = { mcpSessionId: 'mcp_perfetto_generic' };
  const blocked = await app.context.mcp.callTool('execute', {
    sessionId, action: 'trace_info', parameters: {},
  }, requestContext);
  assert.equal(blocked.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'always');

  const traceCall = app.context.mcp.callTool('execute', {
    sessionId, action: 'trace_info', parameters: {},
  }, requestContext);
  const traceRequest = await waitForRequest(connection);
  assert.equal(traceRequest.method, 'trace.getInfo');
  connection.emit('message', JSON.stringify({ type: 'response', id: traceRequest.id, ok: true, result: perfettoTraceResult('trace-generic', 'Generic trace') }));
  assert.equal((await traceCall).structuredContent.title, 'Generic trace');

  const queryCall = app.context.mcp.callTool('execute', {
    sessionId, action: 'query_sql', parameters: { sql: 'SELECT 1 AS value' },
  }, requestContext);
  const queryRequest = await waitForRequest(connection, traceRequest.id);
  assert.equal(queryRequest.method, 'trace.query');
  assert.match(queryRequest.params.sql, /relu-ai-bridge:perfetto-bounded-read-v1/);
  connection.emit('message', JSON.stringify({ type: 'response', id: queryRequest.id, ok: true, result: perfettoQueryResult([{ value: 1 }]) }));
  assert.deepEqual((await queryCall).structuredContent.rows, [{ value: 1 }]);

  const selectionBlocked = await app.context.mcp.callTool('execute', {
    sessionId, action: 'select_range', parameters: { start: '10', end: '20' },
    operationId: 'perfetto-selection-0001',
  }, requestContext);
  assert.equal(selectionBlocked.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(selectionBlocked.structuredContent.approval.id, 'always');
  const selectionCall = app.context.mcp.callTool('execute', {
    sessionId, action: 'select_range', parameters: { start: '10', end: '20' },
    operationId: 'perfetto-selection-0001',
  }, requestContext);
  const selectionRequest = await waitForMethod(connection, 'selection.selectMappedArea');
  assert.equal(selectionRequest.method, 'selection.selectMappedArea');
  connection.emit('message', JSON.stringify({ type: 'response', id: selectionRequest.id, ok: true, result: perfettoAreaResult(selectionRequest) }));
  assert.equal((await selectionCall).structuredContent.startNs, '10');
  assert.equal(app.context.connectors.listOperations().find((item) => (
    item.serviceId === 'perfetto' && item.operationId === 'perfetto-selection-0001'
  ))?.status, 'completed');

  const sentBeforeDuplicate = connection.sent.length;
  const duplicate = await app.context.mcp.callTool('execute', {
    sessionId, action: 'select_range', parameters: { start: '10', end: '20' },
    operationId: 'perfetto-selection-0001',
  }, requestContext);
  assert.equal(duplicate.structuredContent.startNs, '10');
  assert.equal(connection.sent.length, sentBeforeDuplicate);
});

test('approved Perfetto session removal cannot delete a replacement with the same public id', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const original = await app.context.perfettoStore.create({ id: 'reused_session', name: 'original' });
  const args = { action: 'remove', sessionId: original.id };
  const requestContext = { mcpSessionId: 'mcp_session_remove' };
  const blocked = await app.context.mcp.callTool('perfetto_sessions', args, requestContext);
  assert.equal(blocked.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'once');
  await app.context.perfettoStore.remove(original.id, original.instanceId);
  const replacement = await app.context.perfettoStore.create({ id: original.id, name: 'replacement' });

  const result = await app.context.mcp.callTool('perfetto_sessions', args, requestContext);

  assert.equal(result.structuredContent.error, 'APPROVAL_REQUIRED');
  assert.notEqual(result.structuredContent.approval.id, blocked.structuredContent.approval.id);
  assert.equal(app.context.perfettoStore.get(original.id).instanceId, replacement.instanceId);
});

test('Perfetto approval snapshot rejects a same-id connection and trace swap before dispatch', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const original = new FakeConnection();
  app.context.perfetto.accept(original, { origin: 'http://127.0.0.1:10000' });
  await perfettoHello(original, env.config.perfetto.token, {
    clientId: 'perfetto_swap_client', traceId: 'trace-before', title: 'Before',
  });
  const args = { sessionId: 'perfetto:perfetto_swap_client', action: 'trace_info', parameters: {} };
  const requestContext = { mcpSessionId: 'mcp_perfetto_swap' };
  const blocked = await app.context.mcp.callTool('execute', args, requestContext);
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'once');

  const replacement = new FakeConnection();
  const requireApproval = app.context.approvals.require.bind(app.context.approvals);
  let swapped = false;
  app.context.approvals.require = async (input) => {
    const result = await requireApproval(input);
    if (!swapped) {
      swapped = true;
      app.context.perfetto.accept(replacement, { origin: 'http://127.0.0.1:10000' });
      await perfettoHello(replacement, env.config.perfetto.token, {
        clientId: 'perfetto_swap_client', traceId: 'trace-after', title: 'After',
      });
    }
    return result;
  };
  const result = await app.context.mcp.callTool('execute', args, requestContext);
  assert.equal(result.structuredContent.error, 'TOOL_ERROR');
  assert.match(result.structuredContent.message, /target changed after approval/);
  assert.equal(replacement.sent.some((item) => item.method === 'trace.getInfo'), false);
});

test('timed-out Perfetto selection remains ambiguous across restart and blocks a new operation', async (t) => {
  const env = await fixture();
  env.config.perfetto.requestTimeoutMs = 20;
  let app = await createApplication({ config: env.config });
  t.after(async () => { await app?.close(); await env.cleanup(); });
  let connection = new FakeConnection();
  let clientId = 'perfetto_timeout_client';
  const connect = async () => {
    app.context.perfetto.accept(connection, { origin: 'http://127.0.0.1:10000' });
    await perfettoHello(connection, env.config.perfetto.token, {
      clientId, traceId: 'trace-timeout', title: 'Timeout',
    });
  };
  await connect();
  let sessionId = `perfetto:${clientId}`;
  const requestContext = { mcpSessionId: 'mcp_perfetto_timeout' };
  const firstArgs = {
    sessionId, action: 'select_range', parameters: { start: '10', end: '20' },
    operationId: 'perfetto-timeout-operation-01',
  };
  const blocked = await app.context.mcp.callTool('execute', firstArgs, requestContext);
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'always');
  const timedOut = await app.context.mcp.callTool('execute', firstArgs, requestContext);
  assert.equal(timedOut.structuredContent.error, 'TOOL_ERROR');
  assert.match(timedOut.structuredContent.message, /timed out/);
  assert.equal(app.context.connectors.listOperations().find((item) => (
    item.operationId === firstArgs.operationId
  ))?.status, 'ambiguous');

  await app.close();
  app = await createApplication({ config: env.config });
  connection = new FakeConnection();
  clientId = 'perfetto_timeout_client_reloaded';
  sessionId = `perfetto:${clientId}`;
  await connect();
  const sentBefore = connection.sent.length;
  const secondArgs = {
    sessionId, action: 'select_range', parameters: { start: '30', end: '40' },
    operationId: 'perfetto-timeout-operation-02',
  };
  const newTraceApproval = await app.context.mcp.callTool('execute', secondArgs, requestContext);
  assert.equal(newTraceApproval.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(newTraceApproval.structuredContent.approval.id, 'always');
  const afterRestart = await app.context.mcp.callTool('execute', secondArgs, requestContext);
  assert.equal(afterRestart.structuredContent.error, 'TOOL_ERROR');
  assert.match(afterRestart.structuredContent.message, /ambiguous/);
  assert.equal(connection.sent.length, sentBefore);

  const ambiguous = app.context.connectors.listOperations().find((item) => (
    item.operationId === firstArgs.operationId
  ));
  await app.context.connectors.reconcileOperation(ambiguous.id, 'confirmed_not_applied');
  const retried = app.context.mcp.callTool('execute', secondArgs, requestContext);
  const request = await waitForMethod(connection, 'selection.selectMappedArea');
  connection.emit('message', JSON.stringify({ type: 'response', id: request.id, ok: true, result: perfettoAreaResult(request) }));
  assert.equal((await retried).structuredContent.startNs, '30');
});

test('Perfetto alignment preview needs no operationId and applied alignment deduplicates before queries', async (t) => {
  const env = await fixture();
  let app = await createApplication({ config: env.config });
  t.after(async () => { await app?.close(); await env.cleanup(); });
  let refConnection = new FakeConnection();
  let dutConnection = new FakeConnection();
  const connect = async (connection, clientId, traceId) => {
    app.context.perfetto.accept(connection, { origin: 'http://127.0.0.1:10000' });
    await perfettoHello(connection, env.config.perfetto.token, { clientId, traceId });
  };
  await connect(refConnection, 'perfetto_align_ref', 'trace-align-ref');
  await connect(dutConnection, 'perfetto_align_dut', 'trace-align-dut');
  const session = await app.context.perfettoStore.create({ name: 'alignment test' });
  const refClient = app.context.perfetto.getClient('perfetto_align_ref');
  const dutClient = app.context.perfetto.getClient('perfetto_align_dut');
  await app.context.perfettoStore.attach(session.id, 'ref', refClient.id, refClient.traceBinding);
  await app.context.perfettoStore.attach(session.id, 'dut', dutClient.id, dutClient.traceBinding);
  app.context.perfetto.synchronizeAssignments();

  const requestContext = { mcpSessionId: 'mcp_perfetto_align' };
  const baseArgs = {
    sessionId: session.id,
    refSql: 'SELECT ts, value FROM ref_values',
    dutSql: 'SELECT ts, value FROM dut_values',
    refStart: '2',
    refEnd: '15',
  };
  const missingOperation = await app.context.mcp.callTool('perfetto_align', baseArgs, requestContext);
  assert.equal(missingOperation.structuredContent.error, 'TOOL_ERROR');
  assert.match(missingOperation.structuredContent.message, /operationId is required/);

  const previewArgs = { ...baseArgs, applySelection: false };
  const previewBlocked = await app.context.mcp.callTool('perfetto_align', previewArgs, requestContext);
  assert.equal(previewBlocked.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(previewBlocked.structuredContent.approval.id, 'always');
  const rows = Array.from({ length: 20 }, (_, index) => ({ ts: String(index), value: index }));
  const previewCall = app.context.mcp.callTool('perfetto_align', previewArgs, requestContext);
  const previewRefQuery = await waitForMethod(refConnection, 'trace.query');
  const previewDutQuery = await waitForMethod(dutConnection, 'trace.query');
  refConnection.emit('message', JSON.stringify({ type: 'response', id: previewRefQuery.id, ok: true, result: perfettoQueryResult(rows) }));
  dutConnection.emit('message', JSON.stringify({ type: 'response', id: previewDutQuery.id, ok: true, result: perfettoQueryResult(rows) }));
  assert.equal((await previewCall).structuredContent.applied, false);
  assert.equal(app.context.connectors.listOperations().some((item) => item.serviceId === 'perfetto'), false);

  const applyArgs = { ...baseArgs, operationId: 'perfetto-align-operation-0001' };
  const applyBlocked = await app.context.mcp.callTool('perfetto_align', applyArgs, requestContext);
  assert.equal(applyBlocked.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(applyBlocked.structuredContent.approval.id, 'always');
  const applyCall = app.context.mcp.callTool('perfetto_align', applyArgs, requestContext);
  const applyRefQuery = await waitForRequest(refConnection, previewRefQuery.id);
  const applyDutQuery = await waitForRequest(dutConnection, previewDutQuery.id);
  refConnection.emit('message', JSON.stringify({ type: 'response', id: applyRefQuery.id, ok: true, result: perfettoQueryResult(rows) }));
  dutConnection.emit('message', JSON.stringify({ type: 'response', id: applyDutQuery.id, ok: true, result: perfettoQueryResult(rows) }));
  const selection = await waitForMethod(dutConnection, 'selection.selectMappedArea');
  dutConnection.emit('message', JSON.stringify({ type: 'response', id: selection.id, ok: true, result: perfettoAreaResult(selection) }));
  const applied = await applyCall;
  assert.equal(applied.structuredContent.applied, true);
  assert.equal(app.context.connectors.listOperations().find((item) => (
    item.operationId === applyArgs.operationId
  ))?.status, 'completed');

  const refQueryCount = refConnection.sent.filter((item) => item.method === 'trace.query').length;
  const dutQueryCount = dutConnection.sent.filter((item) => item.method === 'trace.query').length;
  const duplicate = await app.context.mcp.callTool('perfetto_align', applyArgs, requestContext);
  assert.equal(duplicate.structuredContent.applied, true);
  assert.equal(refConnection.sent.filter((item) => item.method === 'trace.query').length, refQueryCount);
  assert.equal(dutConnection.sent.filter((item) => item.method === 'trace.query').length, dutQueryCount);

  await app.close();
  app = await createApplication({ config: env.config });
  refConnection = new FakeConnection();
  dutConnection = new FakeConnection();
  await connect(refConnection, 'perfetto_align_ref', 'trace-align-ref');
  await connect(dutConnection, 'perfetto_align_dut', 'trace-align-dut');
  for (const [connection, traceId] of [[refConnection, 'trace-align-ref'], [dutConnection, 'trace-align-dut']]) {
    const restore = await waitForMethod(connection, 'session.attach');
    connection.emit('message', JSON.stringify({ type: 'response', id: restore.id, ok: true, result: perfettoAttachResult(restore, traceId) }));
  }
  const afterRestart = await app.context.mcp.callTool('perfetto_align', applyArgs, requestContext);
  assert.equal(afterRestart.structuredContent.error, 'TOOL_ERROR');
  assert.match(afterRestart.structuredContent.message, /already completed/);
  assert.equal(refConnection.sent.some((item) => item.method === 'trace.query'), false);
  assert.equal(dutConnection.sent.some((item) => item.method === 'trace.query'), false);
});
