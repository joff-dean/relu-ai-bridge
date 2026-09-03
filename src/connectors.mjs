import crypto from 'node:crypto';
import path from 'node:path';
import { validateJsonSchema } from './json-schema.mjs';
import {
  MAX_OPERATION_LEDGER_RECORDS,
  OPERATION_LEDGER_VERSION,
  operationLedgerId,
  operationLedgerKey,
  validateOperationLedgerDocument,
} from './operation-ledger.mjs';
import { randomId, readJson, secureEqual, writeJsonAtomic } from './utils.mjs';

const PROTOCOL_VERSION = '1.0';
const CLIENT_ID = /^[a-zA-Z0-9_-]{3,128}$/u;
const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 20_000;
const MAX_PENDING_PER_SESSION = 16;
const MAX_QUEUED_MESSAGES_PER_CONNECTION = 32;
const MAX_QUEUED_MESSAGE_BYTES_PER_CONNECTION = 4 * 1024 * 1024;
const MAX_QUEUED_MESSAGE_BYTES_TOTAL = 16 * 1024 * 1024;
const RESUME_TTL_MS = 10 * 60_000;
const MAX_CACHED_RESULT_BYTES = 16 * 1024 * 1024;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const GENERIC_AUTH_AUDIENCE = 'relu-ai-bridge://loopback/relu/ws';
const GENERIC_AUTH_NONCE = /^[a-f0-9]{64}$/u;
const GENERIC_AUTH_PROOF = /^[a-f0-9]{64}$/u;
const CONNECTOR_FAILURE_MESSAGES = new Map([
  ['CONTEXT_CHANGED', 'Connector selection context changed; call get_context and retry'],
  ['TIMEOUT', 'Connector capability execution timed out'],
  ['CAPABILITY_UNAVAILABLE', 'Connector capability is no longer available; refresh the session capability list'],
  ['CAPABILITY_FAILED', 'Connector capability execution failed'],
]);

class ConnectorProtocolError extends Error {
  constructor(message, code = 'INVALID_REGISTRATION') {
    super(message);
    this.code = code;
  }
}

function byteLength(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('value must be JSON serializable');
  return Buffer.byteLength(serialized);
}

function validateJsonValue(value, state, path = '$', depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) throw new Error(`${path} contains too many values`);
  if (depth > MAX_JSON_DEPTH) throw new Error(`${path} is too deeply nested`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite numbers`);
    return;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > state.maxStringBytes) throw new Error(`${path} contains an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateJsonValue(value[index], state, `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must contain JSON values only`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_JSON_KEYS.has(key) || Buffer.byteLength(key) > 200) throw new Error(`${path} contains an invalid key`);
    validateJsonValue(item, state, `${path}.${key}`, depth + 1);
  }
}

function boundedJson(value, maximumBytes, name) {
  validateJsonValue(value, { nodes: 0, maxStringBytes: Math.min(maximumBytes, 64 * 1024) });
  if (byteLength(value) > maximumBytes) throw new Error(`${name} exceeds ${maximumBytes} bytes`);
  return structuredClone(value);
}

function requireString(value, name, maximumBytes) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximumBytes) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function genericAuthPayload(role, serviceId, origin, clientNonce, serverNonce, registrationDigest = '') {
  return stableJson([
    'RELU_GENERIC_CONNECTOR_AUTH', PROTOCOL_VERSION, GENERIC_AUTH_AUDIENCE, role,
    serviceId, origin, clientNonce, serverNonce, registrationDigest,
  ]);
}

function genericAuthProof(token, role, serviceId, origin, clientNonce, serverNonce, registrationDigest = '') {
  return crypto.createHmac('sha256', token)
    .update(genericAuthPayload(role, serviceId, origin, clientNonce, serverNonce, registrationDigest))
    .digest('hex');
}

function requireExactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name} contains an unsupported field`);
  }
}

function pageBinding(origin, serviceId, clientId, serverNonce) {
  return hash([origin, serviceId, clientId, serverNonce]);
}

function serviceExecutionGuardFields(service) {
  return service.executionGuardFields ?? service.bindingFields;
}

function serviceExecutionGuardMode(service) {
  return service.executionGuardMode
    ?? (service.executionGuardFields === undefined ? 'strict_context_version' : 'projection');
}

function clientIndexKey(serviceId, origin, clientId) {
  return `${serviceId}:${origin}:${clientId}`;
}

function bindingProjection(service, context, fields = service.bindingFields) {
  return Object.fromEntries(fields.map((field) => [field, structuredClone(context[field])]));
}

function resourceBinding(service, context) {
  const projection = bindingProjection(service, context);
  return hash([service.id, projection]);
}

function executionBinding(service, context) {
  const fields = serviceExecutionGuardFields(service);
  return hash([service.id, bindingProjection(service, context, fields)]);
}

function publicCapability(capability) {
  return {
    name: capability.name,
    description: capability.description,
    readOnly: capability.readOnly,
    effect: capability.effect,
    transport: capability.transport,
    inputSchema: structuredClone(capability.inputSchema),
    outputSchema: structuredClone(capability.outputSchema),
  };
}

function publicSession(session) {
  return {
    id: session.id,
    serviceId: session.service.id,
    serviceName: session.service.displayName,
    clientKind: 'browser',
    connectorVersion: session.connectorVersion,
    sessionKey: hash([session.binding, session.contextBinding]).slice(0, 12),
    clientKey: session.binding.slice(0, 12),
    pageKey: session.binding.slice(0, 12),
    resourceKey: session.contextBinding.slice(0, 12),
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt,
    contextUpdatedAt: session.contextUpdatedAt,
    active: session.active,
    activeIsUntrustedHint: true,
    capabilities: session.capabilities.map((capability) => capability.name),
  };
}

function publicHttpDescriptor(capability) {
  if (capability.transport !== 'http') return null;
  return {
    url: capability.http.url,
    method: capability.http.method,
    auth: capability.http.auth ? {
      header: capability.http.auth.header,
      env: capability.http.auth.env,
    } : null,
  };
}

async function readBoundedResponse(response, maximumBytes) {
  if (!response.body?.getReader) {
    const value = Buffer.from(await response.arrayBuffer());
    if (value.length > maximumBytes) throw new Error('Connector API response exceeds configured limit');
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Connector API response exceeds configured limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function appendGetParameters(url, parameters) {
  for (const [key, raw] of Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right))) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined) continue;
      url.searchParams.append(key, value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
}

export class ConnectorBroker {
  constructor(config, audit, options = {}) {
    this.config = config;
    this.audit = audit;
    this.environment = options.environment ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.services = new Map((config.connectors?.services ?? []).map((service) => [service.id, service]));
    this.sessions = new Map();
    this.clientIndex = new Map();
    this.resumeRecords = new Map();
    this.connections = new Set();
    this.pending = new Map();
    this.busy = new Map();
    this.queuedMessageBytes = 0;
    this.operationLedger = new Map();
    this.operationFile = path.join(config.dataDir, 'connector-operations.json');
    this.persistenceEnabled = false;
    this.persistChain = Promise.resolve();
    this.cachedResultBytes = 0;
    this.authTimeoutMs = options.authTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.authTimeoutMs) || this.authTimeoutMs < 1 || this.authTimeoutMs > 30_000) {
      throw new Error('Connector authentication timeout is invalid');
    }
    this.pingTimer = setInterval(() => this.ping(), 20_000);
    this.pingTimer.unref?.();
  }

  async initialize() {
    const policyEpoch = this.config.connectors.policyEpoch;
    const loaded = await readJson(this.operationFile, {
      version: OPERATION_LEDGER_VERSION, policyEpoch, records: [],
    });
    const validated = validateOperationLedgerDocument(loaded);
    const legacy = validated.legacy;
    if (legacy && validated.records.length > 0 && policyEpoch !== 1) {
      throw new Error('Legacy connector operation ledger must be archived before increasing connectors.policyEpoch');
    }
    if (!legacy && loaded.policyEpoch > policyEpoch) {
      throw new Error(`connectors.policyEpoch rollback is forbidden; configured ${policyEpoch}, durable ledger requires at least ${loaded.policyEpoch}`);
    }
    if (!legacy && loaded.policyEpoch < policyEpoch && loaded.records.length > 0) {
      throw new Error('Connector policy epoch changed with a non-empty operation ledger; run the approved archive-ledger maintenance command while the bridge is stopped');
    }
    for (const raw of validated.records) {
      const service = this.services.get(raw?.serviceId);
      const allowedOrigin = service?.origins.includes(raw.origin)
        || (raw?.serviceId === 'perfetto' && this.config.perfetto.allowedOrigins.includes(raw.origin));
      if (!allowedOrigin) {
        throw new Error('Connector operation ledger contains an invalid record');
      }
      const key = operationLedgerKey(policyEpoch, raw);
      const id = operationLedgerId(policyEpoch, raw);
      if (this.operationLedger.has(key)) throw new Error('Connector operation ledger contains a duplicate record');
      this.operationLedger.set(key, {
        id,
        key,
        serviceId: raw.serviceId,
        origin: raw.origin,
        pageBinding: raw.pageBinding,
        contextBinding: raw.contextBinding,
        capability: raw.capability,
        operationId: raw.operationId,
        argsHash: raw.argsHash,
        status: raw.status === 'pending' ? 'ambiguous' : raw.status,
        reason: raw.status === 'pending' ? 'server-restart' : (raw.reason ?? null),
        lateOutcome: raw.lateOutcome ?? null,
        createdAt: raw.createdAt,
        updatedAt: raw.status === 'pending' ? new Date().toISOString() : raw.updatedAt,
        promise: null,
      });
    }
    this.persistenceEnabled = true;
    await this.persistOperations();
  }

  serializedOperations() {
    return [...this.operationLedger.values()].map((record) => ({
      id: record.id,
      serviceId: record.serviceId,
      origin: record.origin,
      pageBinding: record.pageBinding,
      contextBinding: record.contextBinding,
      capability: record.capability,
      operationId: record.operationId,
      argsHash: record.argsHash,
      status: record.status,
      reason: record.reason ?? null,
      lateOutcome: record.lateOutcome ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  persistOperations() {
    if (!this.persistenceEnabled) return Promise.resolve();
    const snapshot = {
      version: OPERATION_LEDGER_VERSION,
      policyEpoch: this.config.connectors.policyEpoch,
      records: this.serializedOperations(),
    };
    const write = () => writeJsonAtomic(this.operationFile, snapshot, 0o600);
    this.persistChain = this.persistChain.catch(() => {}).then(write);
    return this.persistChain;
  }

  queuePersist() {
    void this.persistOperations().catch(() => {
      void this.audit.append({ category: 'connector', action: 'operation.persist-failed' }).catch(() => {});
    });
  }

  accept(connection, metadata = {}) {
    if (this.connections.size >= this.config.connectors.maxSessions * 2) {
      connection.close(1013, 'connection limit reached');
      return;
    }
    this.connections.add(connection);
    const connectionMetadata = { ...metadata };
    let session = null;
    let handshake = { stage: 'await_init' };
    let clientAuthenticated = false;
    let messageChain = null;
    let queuedMessages = 0;
    let queuedMessageBytes = 0;
    let terminal = false;
    const perConnectionQueuedByteLimit = Math.min(
      MAX_QUEUED_MESSAGE_BYTES_PER_CONNECTION,
      this.config.connectors.maxWebSocketMessageBytes * 2,
    );
    const authTimer = setTimeout(() => connection.close(1008, 'authentication timeout'), this.authTimeoutMs);
    authTimer.unref?.();

    const failConnection = (error) => {
      if (terminal) return;
      terminal = true;
      const errorCode = error?.code === 'RESET_REQUIRED' ? 'RESET_REQUIRED' : 'INVALID_MESSAGE';
      void this.audit.append({
        category: 'connector', action: 'session.invalid-message', serviceId: session?.service.id,
        sessionKey: session ? publicSession(session).sessionKey : undefined,
        errorCode,
      }).catch(() => {});
      if (!session && clientAuthenticated) {
        try {
          connection.sendJson({
            type: 'hello_ack', protocolVersion: PROTOCOL_VERSION, accepted: false,
            error: errorCode === 'RESET_REQUIRED' ? 'Client identity reset required' : 'Authentication or registration failed',
            ...(errorCode === 'RESET_REQUIRED' ? { errorCode } : {}),
          });
        } catch {}
      }
      try { connection.close(1008, 'invalid connector message'); } catch {}
    };

    const processMessage = async (text) => {
      if (terminal) return;
      try {
        const message = JSON.parse(text);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('message must be a JSON object');
        if (!session) {
          if (handshake.stage === 'await_init') {
            handshake = this.acceptAuthInit(connection, connectionMetadata, message);
            return;
          }
          if (handshake.stage !== 'await_proof') throw new Error('Connector authentication message is out of order');
          const authenticated = this.acceptAuthResponse(connectionMetadata, handshake, message);
          clientAuthenticated = true;
          handshake = { stage: 'complete' };
          session = this.acceptHello(connection, connectionMetadata, authenticated.registration, authenticated);
          clearTimeout(authTimer);
          await this.audit.append({
            category: 'connector', action: 'session.connect', serviceId: session.service.id,
            sessionKey: publicSession(session).sessionKey,
          });
          if (terminal) return;
          connection.sendJson({
            type: 'hello_ack',
            protocolVersion: PROTOCOL_VERSION,
            accepted: true,
            sessionId: session.id,
            resumeSecret: session.resumeSecret,
            heartbeatMs: 20_000,
          });
          return;
        }
        session.lastSeenAt = new Date().toISOString();
        this.touchResumeRecord(session);
        if (message.type === 'response') return this.handleResponse(session, message);
        if (message.type === 'event') return this.handleEvent(session, message);
        if (message.type === 'pong') return;
        throw new Error('Unsupported connector message type');
      } catch (error) {
        failConnection(error);
      }
    };

    connection.on('message', (text) => {
      if (terminal) return;
      const messageBytes = Buffer.byteLength(text);
      if (messageBytes > this.config.connectors.maxWebSocketMessageBytes
        || queuedMessages >= MAX_QUEUED_MESSAGES_PER_CONNECTION
        || queuedMessageBytes + messageBytes > perConnectionQueuedByteLimit
        || this.queuedMessageBytes + messageBytes > MAX_QUEUED_MESSAGE_BYTES_TOTAL) {
        failConnection(new Error('Connector message queue limit reached'));
        return;
      }
      queuedMessages += 1;
      queuedMessageBytes += messageBytes;
      this.queuedMessageBytes += messageBytes;
      const pendingMessage = messageChain
        ? messageChain.then(() => processMessage(text))
        : processMessage(text);
      messageChain = pendingMessage
        .catch((error) => failConnection(error))
        .finally(() => {
          queuedMessages -= 1;
          queuedMessageBytes -= messageBytes;
          this.queuedMessageBytes -= messageBytes;
        });
    });
    connection.on('error', () => {
      void this.audit.append({
        category: 'connector', action: 'session.socket-error', serviceId: session?.service.id,
        sessionKey: session ? publicSession(session).sessionKey : undefined,
      }).catch(() => {});
    });
    connection.on('close', () => {
      terminal = true;
      clearTimeout(authTimer);
      handshake = { stage: 'closed' };
      this.connections.delete(connection);
      this.dropConnectionPending(connection, 'Connector session disconnected');
      if (!session || this.sessions.get(session.id)?.connection !== connection) return;
      this.sessions.delete(session.id);
      this.clientIndex.delete(clientIndexKey(session.service.id, session.origin, session.clientId));
      void this.audit.append({
        category: 'connector', action: 'session.disconnect', serviceId: session.service.id,
        sessionKey: publicSession(session).sessionKey,
      }).catch(() => {});
    });
  }

  pruneResumeRecords(now = Date.now()) {
    for (const [key, record] of this.resumeRecords) {
      if (record.expiresAt <= now && !this.clientIndex.has(key)) this.resumeRecords.delete(key);
    }
  }

  touchResumeRecord(session) {
    const record = this.resumeRecords.get(clientIndexKey(session.service.id, session.origin, session.clientId));
    if (record) record.expiresAt = Date.now() + RESUME_TTL_MS;
  }

  acceptAuthInit(connection, metadata, message) {
    if (message.type !== 'auth_init') throw new Error('First message must be auth_init');
    if (message.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported connector protocol version');
    const serviceId = requireString(message.serviceId, 'serviceId', 64);
    const service = this.services.get(serviceId);
    if (!service || !service.origins.includes(metadata.origin)) throw new Error('Authentication failed');
    if (typeof message.clientNonce !== 'string' || !GENERIC_AUTH_NONCE.test(message.clientNonce)) {
      throw new Error('clientNonce is invalid');
    }
    requireExactKeys(message, new Set(['type', 'protocolVersion', 'serviceId', 'clientNonce']), 'auth_init');
    const serverNonce = crypto.randomBytes(32).toString('hex');
    const proof = genericAuthProof(
      service.token, 'server', service.id, metadata.origin, message.clientNonce, serverNonce,
    );
    connection.sendJson({
      type: 'auth_challenge',
      protocolVersion: PROTOCOL_VERSION,
      serviceId: service.id,
      origin: metadata.origin,
      clientNonce: message.clientNonce,
      serverNonce,
      proof,
    });
    return {
      stage: 'await_proof', service, origin: metadata.origin, clientNonce: message.clientNonce, serverNonce,
    };
  }

  acceptAuthResponse(metadata, handshake, message) {
    if (message.type !== 'auth_response') throw new Error('Second message must be auth_response');
    if (message.protocolVersion !== PROTOCOL_VERSION
      || message.serviceId !== handshake.service.id
      || message.clientNonce !== handshake.clientNonce
      || message.serverNonce !== handshake.serverNonce) {
      throw new Error('Connector authentication binding changed');
    }
    requireExactKeys(message, new Set([
      'type', 'protocolVersion', 'serviceId', 'clientNonce', 'serverNonce', 'registration', 'proof',
    ]), 'auth_response');
    if (metadata.origin !== handshake.origin) throw new Error('Connector authentication binding changed');
    if (!message.registration || typeof message.registration !== 'object' || Array.isArray(message.registration)) {
      throw new Error('registration is invalid');
    }
    requireExactKeys(message.registration, new Set(['client', 'context', 'active']), 'registration');
    const registration = boundedJson(
      message.registration, this.config.connectors.maxContextBytes + 16_384, 'registration',
    );
    const registrationDigest = hash(registration);
    if (typeof message.proof !== 'string' || !GENERIC_AUTH_PROOF.test(message.proof)) {
      throw new Error('Connector authentication proof is invalid');
    }
    const expected = genericAuthProof(
      handshake.service.token, 'client', handshake.service.id, handshake.origin,
      handshake.clientNonce, handshake.serverNonce, registrationDigest,
    );
    if (!secureEqual(message.proof, expected)) throw new Error('Connector authentication proof is invalid');
    return { service: handshake.service, registration };
  }

  acceptHello(connection, metadata, message, authenticated) {
    this.pruneResumeRecords();
    const requestedServiceId = requireString(message.client?.serviceId, 'client.serviceId', 64);
    const service = authenticated.service;
    if (!service || requestedServiceId !== service.id) throw new Error('Authenticated service binding changed');
    if (!service.origins.includes(metadata.origin)) throw new Error('Connector origin is not allowed for this service');
    if (message.client?.clientKind !== undefined && message.client.clientKind !== 'browser') {
      throw new Error('Browser connector clientKind is invalid');
    }
    const clientId = requireString(message.client?.clientId, 'client.clientId', 128);
    if (!CLIENT_ID.test(clientId)) throw new Error('client.clientId is invalid');
    const connectorVersion = requireString(message.client?.connectorVersion, 'client.connectorVersion', 100);
    const advertised = message.client?.capabilities ?? [];
    if (!Array.isArray(advertised) || advertised.length > 64
      || advertised.some((name) => typeof name !== 'string') || new Set(advertised).size !== advertised.length) {
      throw new Error('client.capabilities is invalid');
    }
    if (message.active !== undefined && typeof message.active !== 'boolean') throw new Error('active must be a boolean');
    const configuredClient = new Set(service.capabilities
      .filter((item) => item.transport === 'browser')
      .map((item) => item.name));
    if (advertised.some((name) => !configuredClient.has(name))) {
      throw new Error('Client advertised an unconfigured capability for its client kind');
    }
    const supportedClient = new Set(advertised);
    const capabilities = service.capabilities.filter((item) => (
      item.transport === 'http' || (item.transport === 'browser' && supportedClient.has(item.name))
    ));
    const context = boundedJson(message.context ?? {}, this.config.connectors.maxContextBytes, 'connector context');
    validateJsonSchema(service.contextSchema, context, { maxNodes: MAX_JSON_NODES, maxDepth: MAX_JSON_DEPTH });
    const contextBinding = resourceBinding(service, context);
    const contextExecutionBinding = executionBinding(service, context);
    const resumeKey = clientIndexKey(service.id, metadata.origin, clientId);
    const existingResume = this.resumeRecords.get(resumeKey);
    let binding;
    let resumeSecret;
    let generation;
    if (existingResume && existingResume.expiresAt > Date.now()) {
      const secretMatches = secureEqual(message.client?.resumeSecret, existingResume.secret);
      if (!secretMatches) {
        throw new Error('A valid reconnect secret is required for this client id');
      }
      binding = existingResume.binding;
      resumeSecret = existingResume.secret;
      generation = existingResume.generation + 1;
    } else {
      if (message.client?.resumeSecret !== undefined) {
        throw new ConnectorProtocolError('Reconnect secret is stale', 'RESET_REQUIRED');
      }
      if (!existingResume && this.resumeRecords.size >= this.config.connectors.maxSessions * 2) {
        throw new Error('Reconnect record limit reached');
      }
      resumeSecret = randomId('resume_');
      binding = pageBinding(metadata.origin, service.id, clientId, randomId('binding_'));
      generation = 1;
    }
    this.resumeRecords.set(resumeKey, {
      binding, secret: resumeSecret, generation,
      contextBinding, executionBinding: contextExecutionBinding,
      expiresAt: Date.now() + RESUME_TTL_MS,
    });
    const id = `relu_${binding.slice(0, 24)}`;
    if (!this.sessions.has(id) && this.sessions.size >= this.config.connectors.maxSessions) {
      throw new Error('Connector session limit reached');
    }
    const previousId = this.clientIndex.get(resumeKey);
    if (previousId) {
      const previous = this.sessions.get(previousId);
      if (previous) {
        this.dropConnectionPending(previous.connection, 'Connector session was replaced by reconnect');
        previous.connection.close(4001, 'replaced by reconnect');
      }
    }
    if (message.active === true) this.clearActive();
    const now = new Date().toISOString();
    const session = {
      id, binding, contextBinding, executionBinding: contextExecutionBinding,
      generation, resumeSecret, clientId, service, connectorVersion,
      capabilities, connection, origin: metadata.origin, context, contextVersion: 1, connectedAt: now,
      lastSeenAt: now, contextUpdatedAt: now, active: message.active === true,
    };
    this.sessions.set(id, session);
    this.clientIndex.set(resumeKey, id);
    return session;
  }

  clearActive(exceptId = null) {
    for (const item of this.sessions.values()) if (item.id !== exceptId) item.active = false;
  }

  busyKey(session, capability) {
    return `${session.id}:${session.generation}:${capability.name}`;
  }

  reserve(session, capability) {
    const key = this.busyKey(session, capability);
    const activeForSession = [...this.busy.entries()]
      .filter(([entry]) => entry.startsWith(`${session.id}:${session.generation}:`))
      .reduce((total, [, count]) => total + count, 0);
    const current = this.busy.get(key) ?? 0;
    const maximum = capability.maxConcurrent ?? (capability.effect === 'read' ? 4 : 1);
    if (activeForSession >= MAX_PENDING_PER_SESSION || current >= maximum) {
      throw new Error('Connector capability concurrency limit reached');
    }
    this.busy.set(key, current + 1);
    return key;
  }

  release(key) {
    const remaining = (this.busy.get(key) ?? 1) - 1;
    if (remaining > 0) this.busy.set(key, remaining);
    else this.busy.delete(key);
  }

  markAmbiguous(record, reason) {
    if (!record || record.status !== 'pending') return;
    record.status = 'ambiguous';
    record.reason = reason;
    record.updatedAt = new Date().toISOString();
    this.queuePersist();
  }

  storeCompleted(record, result) {
    if (!record) return;
    const resultBytes = byteLength(result);
    record.status = 'completed';
    record.updatedAt = new Date().toISOString();
    if (resultBytes <= MAX_CACHED_RESULT_BYTES - this.cachedResultBytes) {
      record.result = structuredClone(result);
      record.resultBytes = resultBytes;
      this.cachedResultBytes += resultBytes;
    } else {
      record.status = 'completed_no_result';
      record.result = undefined;
      record.resultBytes = 0;
    }
    this.queuePersist();
  }

  dropConnectionPending(connection, reason) {
    for (const [requestId, pending] of this.pending) {
      if (pending.connection !== connection) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      this.release(pending.busyKey);
      this.markAmbiguous(pending.operation, 'connection-lost');
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(new Error(reason));
      }
    }
  }

  handleEvent(session, message) {
    if (message.event === 'context.update') {
      if (message.active !== undefined && typeof message.active !== 'boolean') throw new Error('active must be a boolean');
      const context = boundedJson(message.context ?? {}, this.config.connectors.maxContextBytes, 'connector context');
      validateJsonSchema(session.service.contextSchema, context, { maxNodes: MAX_JSON_NODES, maxDepth: MAX_JSON_DEPTH });
      const nextBinding = resourceBinding(session.service, context);
      const nextExecutionBinding = executionBinding(session.service, context);
      const guardMode = serviceExecutionGuardMode(session.service);
      if (guardMode === 'strict_context_version' || nextExecutionBinding !== session.executionBinding) {
        this.dropConnectionPending(session.connection, 'Connector execution guard changed during execution');
      }
      session.context = context;
      session.contextVersion += 1;
      session.contextUpdatedAt = new Date().toISOString();
      if (nextBinding !== session.contextBinding || nextExecutionBinding !== session.executionBinding) {
        session.contextBinding = nextBinding;
        session.executionBinding = nextExecutionBinding;
        session.generation += 1;
        const record = this.resumeRecords.get(clientIndexKey(
          session.service.id, session.origin, session.clientId,
        ));
        if (record) {
          record.contextBinding = nextBinding;
          record.executionBinding = nextExecutionBinding;
          record.generation = session.generation;
        }
      }
      if (message.active === true) {
        this.clearActive(session.id);
        session.active = true;
      } else if (message.active === false) {
        session.active = false;
      }
      return;
    }
    if (message.event === 'session.active') {
      if (message.active === true) {
        this.clearActive(session.id);
        session.active = true;
      } else if (message.active === false) {
        session.active = false;
      } else {
        throw new Error('session.active requires a boolean active value');
      }
      return;
    }
    throw new Error('Unsupported connector event');
  }

  handleResponse(session, message) {
    if (typeof message.id !== 'string' || message.id.length > 128) throw new Error('response id is invalid');
    if (typeof message.ok !== 'boolean') throw new Error('response ok must be a boolean');
    const pending = this.pending.get(message.id);
    if (!pending || pending.sessionId !== session.id || pending.connection !== session.connection) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    this.release(pending.busyKey);
    let result;
    let resultError = null;
    if (message.ok) {
      try {
        result = boundedJson(message.result ?? null, this.config.connectors.maxResultBytes, 'connector result');
        validateJsonSchema(pending.capability.outputSchema, result, { maxNodes: MAX_JSON_NODES, maxDepth: MAX_JSON_DEPTH });
      } catch {
        // Schema diagnostics can include connector-controlled property names.
        // Preserve only a bridge-owned message at the MCP boundary.
        resultError = new Error('Connector result violated the configured output contract');
      }
    }
    if (pending.settled) {
      if (pending.operation) {
        pending.operation.lateOutcome = message.ok && !resultError ? 'success' : 'failure';
        pending.operation.updatedAt = new Date().toISOString();
        this.queuePersist();
      }
      return;
    }
    pending.settled = true;
    if (resultError) {
      if (pending.operation) {
        this.markAmbiguous(pending.operation, 'invalid-result');
      }
      pending.reject(resultError);
      return;
    }
    if (message.ok) {
      this.storeCompleted(pending.operation, result);
      pending.resolve(result);
    } else {
      this.markAmbiguous(pending.operation, 'connector-rejected-after-dispatch');
      // Never reflect connector-provided text into MCP output: a log viewer may
      // accidentally include a raw company log line or path in that field. Only
      // expose a fixed message for protocol error codes owned by this bridge.
      const failureMessage = CONNECTOR_FAILURE_MESSAGES.get(message.errorCode)
        ?? 'Connector action failed';
      pending.reject(new Error(failureMessage));
    }
  }

  listSessions(options = {}) {
    return [...this.sessions.values()]
      .filter((session) => !options.serviceId || session.service.id === options.serviceId)
      .filter((session) => !options.activeOnly || session.active)
      .sort((left, right) => Number(right.active) - Number(left.active) || right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map(publicSession);
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Connector session is not connected');
    return session;
  }

  getCapability(sessionId, action) {
    const session = this.getSession(sessionId);
    const capability = session.capabilities.find((item) => item.name === action);
    if (!capability) throw new Error('Capability is not available in this connector session');
    return { session, capability };
  }

  createSnapshot(sessionId, action = null) {
    const session = this.getSession(sessionId);
    const capability = action === null ? null : this.getCapability(sessionId, action).capability;
    return {
      sessionId: session.id,
      pageBinding: session.binding,
      contextBinding: session.contextBinding,
      executionBinding: session.executionBinding,
      executionGuardMode: serviceExecutionGuardMode(session.service),
      contextVersion: session.contextVersion,
      generation: session.generation,
      connection: session.connection,
      connectorVersion: session.connectorVersion,
      capability,
      session: publicSession(session),
      context: structuredClone(session.context),
      contextGuard: {
        fields: [...serviceExecutionGuardFields(session.service)],
        projection: bindingProjection(
          session.service, session.context, serviceExecutionGuardFields(session.service),
        ),
        binding: session.executionBinding,
      },
      resourceGuard: {
        fields: [...session.service.bindingFields],
        projection: bindingProjection(session.service, session.context),
        binding: session.contextBinding,
      },
      approvalDescriptor: {
        serviceId: session.service.id,
        serviceName: session.service.displayName,
        origin: session.origin,
        clientKind: 'browser',
        executionGuardMode: serviceExecutionGuardMode(session.service),
        executionGuardFields: [...serviceExecutionGuardFields(session.service)],
        pageBinding: session.binding,
        contextBinding: session.contextBinding,
        connectorVersion: session.connectorVersion,
        capability: capability ? {
          name: capability.name,
          effect: capability.effect,
          transport: capability.transport,
          inputSchema: capability.inputSchema,
          outputSchema: capability.outputSchema,
          http: publicHttpDescriptor(capability),
        } : null,
        contextSchema: capability ? null : session.service.contextSchema,
      },
    };
  }

  assertSnapshot(snapshot) {
    const session = this.sessions.get(snapshot.sessionId);
    if (!session || session.binding !== snapshot.pageBinding || session.contextBinding !== snapshot.contextBinding
      || session.generation !== snapshot.generation
      || session.connection !== snapshot.connection || session.connectorVersion !== snapshot.connectorVersion) {
      throw new Error('Connector context changed after approval; retry against the current session');
    }
    if (snapshot.capability) {
      if (snapshot.executionGuardMode === 'strict_context_version'
        && session.contextVersion !== snapshot.contextVersion) {
        throw new Error('Connector context changed after approval; retry against the current session');
      }
      if (snapshot.executionGuardMode !== 'strict_context_version'
        && session.executionBinding !== snapshot.executionBinding) {
        throw new Error('Connector execution guard changed after approval; retry against the current selection');
      }
      const current = session.capabilities.find((item) => item.name === snapshot.capability.name);
      if (current !== snapshot.capability) throw new Error('Connector capability changed after approval; retry discovery');
    } else if (session.contextVersion !== snapshot.contextVersion) {
      throw new Error('Connector context changed after approval; retry against the current session');
    }
    return session;
  }

  getContextSnapshot(sessionId) {
    return this.createSnapshot(sessionId);
  }

  readContextSnapshot(snapshot) {
    this.assertSnapshot(snapshot);
    return {
      session: structuredClone(snapshot.session),
      context: structuredClone(snapshot.context),
      contextVersion: snapshot.contextVersion,
    };
  }

  getContext(sessionId) {
    return this.readContextSnapshot(this.getContextSnapshot(sessionId));
  }

  listCapabilities(sessionId) {
    return this.getSession(sessionId).capabilities.map(publicCapability);
  }

  prepareExecution(sessionId, action, parameters = {}, options = {}) {
    const snapshot = this.createSnapshot(sessionId, action);
    const input = boundedJson(parameters, this.config.connectors.maxContextBytes, 'connector parameters');
    validateJsonSchema(snapshot.capability.inputSchema, input, { maxNodes: MAX_JSON_NODES, maxDepth: MAX_JSON_DEPTH });
    const argsHash = hash(input);
    const operationId = options.operationId;
    if (operationId !== undefined && !OPERATION_ID.test(operationId)) {
      throw new Error('operationId must be 8 to 128 safe ASCII characters');
    }
    if (snapshot.capability.effect !== 'read' && !operationId) {
      throw new Error('operationId is required for a mutating capability');
    }
    return { snapshot, input, argsHash, operationId: operationId ?? null };
  }

  preparePerfettoMutation(snapshot, capability, parameters = {}, operationId) {
    if (!snapshot || typeof snapshot !== 'object'
      || typeof snapshot.clientId !== 'string' || !CLIENT_ID.test(snapshot.clientId)
      || typeof snapshot.traceBinding !== 'string' || !/^[a-f0-9]{32}$/u.test(snapshot.traceBinding)
      || typeof snapshot.traceResourceBinding !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshot.traceResourceBinding)
      || typeof snapshot.origin !== 'string' || !this.config.perfetto.allowedOrigins.includes(snapshot.origin)) {
      throw new Error('Perfetto mutation target is invalid');
    }
    if (capability !== 'select_range') throw new Error('Perfetto mutation capability is not allowlisted');
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) {
      throw new Error('operationId must be 8 to 128 safe ASCII characters');
    }
    const maximumBytes = Math.min(
      256 * 1024,
      Math.max(this.config.connectors.maxContextBytes, (this.config.perfetto.maxQueryBytes * 2) + (64 * 1024)),
    );
    const input = boundedJson(parameters, maximumBytes, 'Perfetto mutation parameters');
    const page = hash(['perfetto-page', snapshot.origin, snapshot.clientId]);
    const resource = hash(['perfetto-trace', snapshot.origin, snapshot.traceResourceBinding]);
    return {
      external: 'perfetto',
      input,
      argsHash: hash(input),
      operationId,
      snapshot: {
        pageBinding: page,
        contextBinding: resource,
        capability: { name: capability, effect: 'ui_mutation' },
        approvalDescriptor: {
          serviceId: 'perfetto',
          origin: snapshot.origin,
          capability: { name: capability, effect: 'ui_mutation' },
        },
      },
    };
  }

  async beginPerfettoMutation(prepared, assertTarget, closeTarget) {
    if (prepared?.external !== 'perfetto' || typeof assertTarget !== 'function'
      || typeof closeTarget !== 'function') {
      throw new Error('Perfetto mutation execution is invalid');
    }
    assertTarget();
    const begun = await this.beginOperation(prepared);
    if (begun.duplicate) return { duplicate: true, outcome: begun.outcome };
    const operation = begun.record;
    operation.reconcileTarget = closeTarget;
    return { duplicate: false, operation };
  }

  async cancelPerfettoMutation(execution, error) {
    const operation = execution?.operation;
    if (!operation || operation.status !== 'pending' || operation.externalDispatchStarted) return;
    this.operationLedger.delete(operation.key);
    operation.rejectDuplicate(error);
    delete operation.reconcileTarget;
    await this.persistOperations().catch(() => {});
  }

  async completePerfettoMutation(execution, assertTarget, dispatch) {
    const operation = execution?.operation;
    if (!operation || operation.status !== 'pending'
      || typeof assertTarget !== 'function' || typeof dispatch !== 'function') {
      throw new Error('Perfetto mutation execution is invalid');
    }
    try {
      // Persistence above yields to the event loop. Revalidate immediately before
      // invoking the transport so an approved trace cannot be swapped meanwhile.
      assertTarget();
    } catch (error) {
      await this.cancelPerfettoMutation(execution, error);
      throw error;
    }
    operation.externalDispatchStarted = true;
    const outcome = (async () => {
      try {
        const result = boundedJson(await dispatch(), this.config.connectors.maxResultBytes, 'Perfetto mutation result');
        delete operation.reconcileTarget;
        this.storeCompleted(operation, result);
        return result;
      } catch (error) {
        this.markAmbiguous(operation, 'perfetto-outcome-unknown');
        throw error;
      }
    })();
    outcome.then(operation.resolveDuplicate, operation.rejectDuplicate);
    return await outcome;
  }

  async executePerfettoMutation(prepared, assertTarget, dispatch, closeTarget) {
    if (typeof dispatch !== 'function') throw new Error('Perfetto mutation execution is invalid');
    const execution = await this.beginPerfettoMutation(prepared, assertTarget, closeTarget);
    if (execution.duplicate) return await execution.outcome;
    return this.completePerfettoMutation(execution, assertTarget, dispatch);
  }

  pruneOperationLedger() {
    // Mutation ids are intentionally durable. Records are removed only by an
    // explicit, locally approved reconciliation/maintenance decision.
  }

  operationKey(prepared) {
    return operationLedgerKey(this.config.connectors.policyEpoch, {
      serviceId: prepared.snapshot.approvalDescriptor.serviceId,
      origin: prepared.snapshot.approvalDescriptor.origin,
      contextBinding: prepared.snapshot.contextBinding,
      capability: prepared.snapshot.capability.name,
      operationId: prepared.operationId,
    });
  }

  findAmbiguous(prepared) {
    return [...this.operationLedger.values()].find((record) => record.status === 'ambiguous'
      && record.serviceId === prepared.snapshot.approvalDescriptor.serviceId
      && record.origin === prepared.snapshot.approvalDescriptor.origin
      && record.contextBinding === prepared.snapshot.contextBinding
      && record.capability === prepared.snapshot.capability.name);
  }

  async beginOperation(prepared) {
    this.pruneOperationLedger();
    const key = this.operationKey(prepared);
    const existing = this.operationLedger.get(key);
    if (existing) {
      if (existing.argsHash !== prepared.argsHash) throw new Error('operationId was already used with different arguments');
      if (existing.status === 'pending') return { existing, duplicate: true, outcome: existing.promise };
      if (existing.status === 'completed' && existing.result !== undefined) {
        return { existing, duplicate: true, outcome: Promise.resolve(structuredClone(existing.result)) };
      }
      if (existing.status === 'completed' || existing.status === 'completed_no_result') {
        throw new Error('Operation was already completed and will not be dispatched again');
      }
      if (existing.status === 'confirmed_applied') {
        throw new Error('Operation was administratively confirmed as applied and will not be dispatched again');
      }
      if (existing.status === 'ambiguous') throw new Error('Previous mutating operation outcome is ambiguous; reconcile it locally before retrying');
      throw new Error('Operation previously failed and will not be dispatched again with the same operationId');
    }
    if (this.findAmbiguous(prepared)) {
      throw new Error('A previous mutating capability outcome is ambiguous; reconcile it locally before another mutation');
    }
    if (this.operationLedger.size >= MAX_OPERATION_LEDGER_RECORDS) {
      throw new Error('Operation ledger capacity reached; archive resolved records under an approved maintenance procedure');
    }
    const now = new Date().toISOString();
    let resolveDuplicate;
    let rejectDuplicate;
    const duplicatePromise = new Promise((resolve, reject) => {
      resolveDuplicate = resolve;
      rejectDuplicate = reject;
    });
    duplicatePromise.catch(() => {});
    const record = {
      id: operationLedgerId(this.config.connectors.policyEpoch, {
        serviceId: prepared.snapshot.approvalDescriptor.serviceId,
        origin: prepared.snapshot.approvalDescriptor.origin,
        contextBinding: prepared.snapshot.contextBinding,
        capability: prepared.snapshot.capability.name,
        operationId: prepared.operationId,
      }),
      key,
      serviceId: prepared.snapshot.approvalDescriptor.serviceId,
      origin: prepared.snapshot.approvalDescriptor.origin,
      pageBinding: prepared.snapshot.pageBinding,
      contextBinding: prepared.snapshot.contextBinding,
      capability: prepared.snapshot.capability.name,
      operationId: prepared.operationId,
      argsHash: prepared.argsHash,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      promise: duplicatePromise,
      resolveDuplicate,
      rejectDuplicate,
    };
    this.operationLedger.set(key, record);
    try {
      await this.persistOperations();
    } catch (error) {
      this.operationLedger.delete(key);
      rejectDuplicate(error);
      throw new Error('Could not persist the mutation operation before dispatch');
    }
    return { record, duplicate: false, outcome: null };
  }

  listOperations() {
    this.pruneOperationLedger();
    return [...this.operationLedger.values()].map((record) => ({
      id: record.id,
      serviceId: record.serviceId,
      sessionKey: hash([record.pageBinding, record.contextBinding]).slice(0, 12),
      capability: record.capability,
      operationId: record.operationId,
      argumentsHash: record.argsHash.slice(0, 12),
      status: record.status,
      lateOutcome: record.lateOutcome ?? null,
      reason: record.reason ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  getOperation(id) {
    const operation = this.listOperations().find((record) => record.id === id);
    if (!operation) throw new Error('Operation record not found');
    return operation;
  }

  async reconcileOperation(id, decision) {
    if (!['confirmed_applied', 'confirmed_not_applied'].includes(decision)) throw new Error('Invalid operation reconciliation decision');
    const entry = [...this.operationLedger.entries()].find(([, record]) => record.id === id);
    if (!entry || entry[1].status !== 'ambiguous') throw new Error('Ambiguous operation not found');
    const [key, record] = entry;
    if (typeof record.reconcileTarget === 'function') {
      try { record.reconcileTarget(); } catch {}
      delete record.reconcileTarget;
    }
    for (const pending of this.pending.values()) {
      if (pending.operation !== record) continue;
      this.dropConnectionPending(pending.connection, 'Operation reconciliation requires connector reconnect');
      pending.connection.close(4002, 'operation reconciled; reconnect required');
      break;
    }
    if (decision === 'confirmed_not_applied') {
      this.operationLedger.delete(key);
    } else {
      record.status = 'confirmed_applied';
      record.updatedAt = new Date().toISOString();
    }
    await this.persistOperations();
    await this.audit.append({
      category: 'connector', action: 'operation.reconcile', serviceId: record.serviceId,
      capability: record.capability, operationKey: record.id, decision,
    });
    return { operations: this.listOperations() };
  }

  requestConnectedClient(session, prepared, operation) {
    const capability = prepared.snapshot.capability;
    const busyKey = this.reserve(session, capability);
    const id = randomId('connector_request_');
    let resolveRequest;
    let rejectRequest;
    const result = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending || pending.settled) return;
      pending.settled = true;
      this.markAmbiguous(operation, 'timeout');
      rejectRequest(new Error('Connector action timed out'));
      // Keep the request as a tombstone until its late response or connection close.
    }, capability.timeoutMs ?? this.config.connectors.requestTimeoutMs);
    timer.unref?.();
    this.pending.set(id, {
      sessionId: session.id,
      connection: session.connection,
      capability,
      operation,
      busyKey,
      resolve: resolveRequest,
      reject: rejectRequest,
      timer,
      settled: false,
    });
    try {
      session.connection.sendJson({
        type: 'request', id, action: capability.name, parameters: prepared.input,
        timeoutMs: capability.timeoutMs ?? this.config.connectors.requestTimeoutMs,
        contextGuard: prepared.snapshot.contextGuard,
        ...(prepared.operationId ? { operationId: prepared.operationId } : {}),
      });
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      this.release(busyKey);
      this.markAmbiguous(operation, 'send-failed');
      rejectRequest(error);
    }
    return result;
  }

  async requestHttp(session, prepared) {
    const capability = prepared.snapshot.capability;
    if (typeof this.fetch !== 'function') throw new Error('HTTP connector transport is unavailable');
    const endpoint = new URL(capability.http.url);
    const headers = { accept: 'application/json' };
    const options = { method: capability.http.method, headers, redirect: 'manual' };
    if (capability.http.auth) {
      const secret = capability.http.auth.value ?? this.environment[capability.http.auth.env];
      if (!secret) throw new Error('Connector API credential is not loaded');
      headers[capability.http.auth.header] = secret;
    }
    if (prepared.operationId) headers['idempotency-key'] = prepared.operationId;
    if (capability.http.method === 'GET') appendGetParameters(endpoint, prepared.input);
    else {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(prepared.input);
    }
    const controller = new AbortController();
    options.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), capability.http.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(endpoint, options);
      if (response.status < 200 || response.status >= 300) {
        await readBoundedResponse(response, Math.min(this.config.connectors.maxResultBytes, 4096)).catch(() => Buffer.alloc(0));
        throw new Error(`Connector API returned HTTP ${response.status}`);
      }
      const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('application/json') && !contentType.includes('+json')) throw new Error('Connector API must return JSON');
      const payload = await readBoundedResponse(response, this.config.connectors.maxResultBytes);
      let result;
      try {
        result = JSON.parse(payload.toString('utf8'));
      } catch {
        throw new Error('Connector API returned invalid JSON');
      }
      const bounded = boundedJson(result, this.config.connectors.maxResultBytes, 'connector result');
      validateJsonSchema(capability.outputSchema, bounded, { maxNodes: MAX_JSON_NODES, maxDepth: MAX_JSON_DEPTH });
      await this.audit.append({
        category: 'connector', action: 'data-plane.http', serviceId: session.service.id,
        capability: capability.name, sessionKey: publicSession(session).sessionKey, status: response.status,
      });
      return bounded;
    } catch (error) {
      if (error?.message?.startsWith('Connector API returned HTTP ')) throw error;
      if (error?.message === 'Connector API must return JSON' || error?.message === 'Connector API returned invalid JSON'
        || error?.message?.startsWith('Connector API response exceeds')) throw error;
      throw new Error('Connector API request failed or timed out');
    } finally {
      clearTimeout(timer);
    }
  }

  async executePrepared(prepared) {
    const session = this.assertSnapshot(prepared.snapshot);
    const capability = prepared.snapshot.capability;
    let operation = null;
    if (capability.effect !== 'read') {
      const begun = await this.beginOperation(prepared);
      if (begun.duplicate) return await begun.outcome;
      operation = begun.record;
    }
    if (capability.transport === 'browser') {
      let outcome;
      try {
        // beginOperation persists to disk and yields the event loop. Revalidate
        // immediately before the synchronous WebSocket dispatch so a context
        // update cannot consume an approval for a stale resource.
        const dispatchSession = this.assertSnapshot(prepared.snapshot);
        outcome = this.requestConnectedClient(dispatchSession, prepared, operation);
      } catch (error) {
        if (operation?.status === 'pending') {
          this.operationLedger.delete(operation.key);
          operation.rejectDuplicate(error);
          await this.persistOperations().catch(() => this.queuePersist());
        }
        throw error;
      }
      if (operation) outcome.then(operation.resolveDuplicate, operation.rejectDuplicate);
      return await outcome;
    }
    let busyKey;
    try {
      busyKey = this.reserve(session, capability);
    } catch (error) {
      if (operation?.status === 'pending') {
        this.operationLedger.delete(operation.key);
        operation.rejectDuplicate(error);
        this.queuePersist();
      }
      throw error;
    }
    const outcome = (async () => {
      try {
        this.assertSnapshot(prepared.snapshot);
        const result = await this.requestHttp(session, prepared);
        if (operation) {
          this.storeCompleted(operation, result);
        }
        return result;
      } catch (error) {
        this.markAmbiguous(operation, 'http-outcome-unknown');
        throw error;
      } finally {
        this.release(busyKey);
      }
    })();
    if (operation) outcome.then(operation.resolveDuplicate, operation.rejectDuplicate);
    return await outcome;
  }

  async execute(sessionId, action, parameters = {}, options = {}) {
    return this.executePrepared(this.prepareExecution(sessionId, action, parameters, options));
  }

  ping() {
    const now = Date.now();
    for (const session of this.sessions.values()) this.touchResumeRecord(session);
    this.pruneResumeRecords(now);
    this.pruneOperationLedger();
    for (const session of this.sessions.values()) {
      if (now - Date.parse(session.lastSeenAt) > 60_000) session.connection.close(4000, 'heartbeat timeout');
      else {
        session.connection.ping(String(now));
        session.connection.sendJson({ type: 'ping', nonce: String(now) });
      }
    }
  }

  async shutdown() {
    clearInterval(this.pingTimer);
    for (const connection of this.connections) connection.close(1001, 'server shutdown');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.markAmbiguous(pending.operation, 'server-shutdown');
      if (!pending.settled) pending.reject(new Error('Connector broker is shutting down'));
    }
    this.pending.clear();
    this.busy.clear();
    await this.persistOperations().catch(() => {});
  }
}
