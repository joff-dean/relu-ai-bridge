import crypto from 'node:crypto';
import { AsyncMutex, errorMessage, randomId, secureEqual, truncateUtf8 } from './utils.mjs';

const CLIENT_ID = /^[a-zA-Z0-9_-]{3,128}$/;
const PROTOCOL_VERSION = '1.0';
const AUTH_NONCE = /^[a-f0-9]{64}$/;
const AUTH_PROOF = /^[a-f0-9]{64}$/;
const SERVER_PROOF_DOMAIN = 'RELU-AI-BRIDGE-PERFETTO-SERVER-PROOF-V1';
const CLIENT_PROOF_DOMAIN = 'RELU-AI-BRIDGE-PERFETTO-CLIENT-PROOF-V1';
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const INTEGER = /^-?\d+$/;
const MAX_REMOTE_ERROR_BYTES = 4096;
const SAFE_CLIENT_ERROR_CODES = new Set(['NOT_AUTHENTICATED', 'REQUEST_FAILED']);
const METHODS = new Set([
  'trace.getInfo',
  'selection.getArea',
  'trace.query',
  'selection.selectMappedArea',
  'session.attach',
]);

function publicClient(client) {
  return {
    id: client.id,
    traceKey: client.traceBinding.slice(0, 12),
    plugin: client.plugin,
    connectedAt: client.connectedAt,
    lastSeenAt: client.lastSeenAt,
    sessionId: client.sessionId,
    role: client.role,
  };
}

function boundedError(error) {
  return truncateUtf8(errorMessage(error), MAX_REMOTE_ERROR_BYTES).text;
}

function requireBoundedString(value, name, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Buffer.byteLength(value) > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validateTraceDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('trace descriptor is required');
  const traceId = requireBoundedString(value.traceId, 'trace.traceId', 512);
  const title = requireBoundedString(value.title ?? 'Untitled trace', 'trace.title', 1024);
  const sourceUrl = requireBoundedString(value.sourceUrl ?? '', 'trace.sourceUrl', 2048, { allowEmpty: true });
  const startNs = requireBoundedString(value.startNs, 'trace.startNs', 128);
  const endNs = requireBoundedString(value.endNs, 'trace.endNs', 128);
  if (!INTEGER.test(startNs) || !INTEGER.test(endNs) || BigInt(startNs) >= BigInt(endNs)) {
    throw new Error('trace timestamp range is invalid');
  }
  const traceTypes = Array.isArray(value.traceTypes) ? value.traceTypes : [];
  if (traceTypes.length > 64 || traceTypes.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 128)) {
    throw new Error('trace.traceTypes is invalid');
  }
  return {
    traceId,
    title,
    sourceUrl,
    startNs,
    endNs,
    traceTypes: [...traceTypes],
    hasFtrace: Boolean(value.hasFtrace),
    importErrors: Number.isSafeInteger(value.importErrors) && value.importErrors >= 0 ? value.importErrors : 0,
  };
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function authTranscript(domain, fields) {
  return JSON.stringify([domain, PROTOCOL_VERSION, ...fields]);
}

export function computePerfettoServerProof(token, input) {
  return crypto.createHmac('sha256', token).update(authTranscript(SERVER_PROOF_DOMAIN, [
    input.origin,
    input.pluginId,
    input.clientNonce,
    input.serverNonce,
  ])).digest('hex');
}

export function computePerfettoClientProof(token, input) {
  return crypto.createHmac('sha256', token).update(authTranscript(CLIENT_PROOF_DOMAIN, [
    input.origin,
    input.pluginId,
    input.clientNonce,
    input.serverNonce,
    input.client.clientId,
    input.client.pluginId,
    input.client.pluginVersion,
    input.trace.traceId,
    input.trace.title,
    input.trace.sourceUrl,
    input.trace.startNs,
    input.trace.endNs,
    input.trace.traceTypes,
    input.trace.hasFtrace,
    input.trace.importErrors,
  ])).digest('hex');
}

function validateAuthAudience(value, expectedOrigin, allowedPluginIds) {
  if (!isRecord(value) || !hasExactKeys(value, ['origin', 'pluginId'])) {
    throw new Error('Perfetto authentication audience is invalid');
  }
  const origin = requireBoundedString(value.origin, 'audience.origin', 2_048);
  const pluginId = requireBoundedString(value.pluginId, 'audience.pluginId', 200);
  if (origin !== expectedOrigin || !allowedPluginIds.includes(pluginId)) {
    throw new Error('Perfetto authentication audience is not allowed');
  }
  return { origin, pluginId };
}

function validateAuthNonce(value, name) {
  if (typeof value !== 'string' || !AUTH_NONCE.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function validateTraceInfoResult(value, client) {
  if (!isRecord(value)
    || !hasExactKeys(value, ['traceId', 'title', 'sourceUrl', 'startNs', 'endNs', 'traceTypes', 'hasFtrace', 'importErrors'])
    || typeof value.hasFtrace !== 'boolean'
    || !Number.isSafeInteger(value.importErrors)
    || value.importErrors < 0) {
    throw new Error('invalid trace info result');
  }
  const result = validateTraceDescriptor(value);
  if (result.traceId !== client.trace.traceId) throw new Error('trace identity changed');
  return result;
}

function validateAreaResult(value, client, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (!isRecord(value) || !hasExactKeys(value, ['startNs', 'endNs', 'trackUris'])) {
    throw new Error('invalid area selection result');
  }
  const startNs = requireBoundedString(value.startNs, 'selection.startNs', 128);
  const endNs = requireBoundedString(value.endNs, 'selection.endNs', 128);
  if (!INTEGER.test(startNs) || !INTEGER.test(endNs)) throw new Error('invalid area timestamp');
  const start = BigInt(startNs);
  const end = BigInt(endNs);
  if (start >= end || start < BigInt(client.trace.startNs) || end > BigInt(client.trace.endNs)) {
    throw new Error('area selection is outside the trace');
  }
  if (!Array.isArray(value.trackUris) || value.trackUris.length > 1_024
    || value.trackUris.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 2_048)) {
    throw new Error('invalid area track URIs');
  }
  return { startNs, endNs, trackUris: [...value.trackUris] };
}

function validateQueryCell(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid numeric query cell');
    return value;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 384 * 1024) throw new Error('query cell is too large');
    return value;
  }
  if (!isRecord(value)) throw new Error('invalid query cell');
  if (value.type === 'bigint' && hasExactKeys(value, ['type', 'value'])
    && typeof value.value === 'string' && value.value.length <= 128 && INTEGER.test(value.value)) {
    return { type: 'bigint', value: value.value };
  }
  if (value.type === 'blob' && hasExactKeys(value, ['type', 'base64'])
    && typeof value.base64 === 'string' && value.base64.length <= 512 * 1024
    && value.base64.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.base64)) {
    const decoded = Buffer.from(value.base64, 'base64');
    if (decoded.length <= 384 * 1024 && decoded.toString('base64') === value.base64) {
      return { type: 'blob', base64: value.base64 };
    }
  }
  throw new Error('invalid tagged query cell');
}

function validateQueryResult(value, requestedMaxRows, configuredMaxRows) {
  const keys = ['columns', 'rows', 'truncated', 'elapsedTimeMs', 'statementCount', 'statementWithOutputCount'];
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || !Array.isArray(value.columns) || value.columns.length > 256
    || value.columns.some((column) => typeof column !== 'string' || Buffer.byteLength(column) > 512)
    || new Set(value.columns).size !== value.columns.length
    || !Array.isArray(value.rows)
    || value.rows.length > Math.min(Number(requestedMaxRows ?? configuredMaxRows), configuredMaxRows)
    || typeof value.truncated !== 'boolean'
    || typeof value.elapsedTimeMs !== 'number' || !Number.isFinite(value.elapsedTimeMs) || value.elapsedTimeMs < 0
    || !Number.isSafeInteger(value.statementCount) || value.statementCount < 0 || value.statementCount > 1_000
    || !Number.isSafeInteger(value.statementWithOutputCount) || value.statementWithOutputCount < 0
    || value.statementWithOutputCount > value.statementCount) {
    throw new Error('invalid query result');
  }
  const columnSet = new Set(value.columns);
  const rows = value.rows.map((row) => {
    if (!isRecord(row) || Object.keys(row).length !== value.columns.length
      || Object.keys(row).some((key) => !columnSet.has(key))) throw new Error('invalid query row');
    return Object.fromEntries(value.columns.map((column) => [column, validateQueryCell(row[column])]));
  });
  return {
    columns: [...value.columns],
    rows,
    truncated: value.truncated,
    elapsedTimeMs: value.elapsedTimeMs,
    statementCount: value.statementCount,
    statementWithOutputCount: value.statementWithOutputCount,
  };
}

function validatePerfettoResult(method, value, pending, client, config) {
  if (method === 'trace.getInfo') return validateTraceInfoResult(value, client);
  if (method === 'selection.getArea') return validateAreaResult(value, client, { allowNull: true });
  if (method === 'trace.query') {
    return validateQueryResult(value, pending.params.maxRows, config.perfetto.maxQueryRows);
  }
  if (method === 'selection.selectMappedArea') {
    const result = validateAreaResult(value, client);
    if (result.startNs !== pending.params.startNs || result.endNs !== pending.params.endNs) {
      throw new Error('mapped area response does not match request');
    }
    return result;
  }
  if (method === 'session.attach') {
    if (!isRecord(value)
      || !hasExactKeys(value, ['attached', 'sessionId', 'role', 'traceId'])
      || value.attached !== true
      || value.sessionId !== pending.params.sessionId
      || value.role !== pending.params.role
      || value.traceId !== client.trace.traceId) throw new Error('invalid session attach result');
    return {
      attached: true,
      sessionId: value.sessionId,
      role: value.role,
      traceId: value.traceId,
    };
  }
  throw new Error('unsupported response method');
}

export function computeTraceBinding(metadata) {
  return crypto.createHash('sha256').update(JSON.stringify([
    metadata.origin,
    metadata.pluginId,
    metadata.clientId,
    metadata.traceId,
  ])).digest('hex').slice(0, 32);
}

function computeTraceResourceBinding(metadata) {
  return crypto.createHash('sha256').update(JSON.stringify([
    metadata.origin,
    metadata.pluginId,
    metadata.traceId,
  ])).digest('hex');
}

export class PerfettoBroker {
  constructor(config, store, audit, approvals, options = {}) {
    this.config = config;
    this.store = store;
    this.audit = audit;
    this.approvals = approvals;
    this.clients = new Map();
    this.pending = new Map();
    this.connections = new Set();
    this.assignmentMutex = new AsyncMutex();
    const requestedAuthTimeoutMs = Number(options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
    this.authTimeoutMs = Number.isSafeInteger(requestedAuthTimeoutMs) && requestedAuthTimeoutMs > 0
      ? Math.min(DEFAULT_AUTH_TIMEOUT_MS, requestedAuthTimeoutMs)
      : DEFAULT_AUTH_TIMEOUT_MS;
    this.pingTimer = setInterval(() => this.ping(), 20_000);
    this.pingTimer.unref?.();
  }

  accept(connection, metadata = {}) {
    if (this.connections.size >= this.config.perfetto.maxClients * 2) {
      connection.close(1013, 'connection limit reached');
      return;
    }
    this.connections.add(connection);
    let client = null;
    let handshake = { phase: 'await_challenge' };
    let messageChain = null;
    const authTimer = setTimeout(() => {
      connection.close(1008, 'authentication timeout');
      void this.audit.append({
        category: 'perfetto', action: 'client.auth_timeout', origin: metadata.origin,
      }).catch(() => {});
    }, this.authTimeoutMs);
    authTimer.unref?.();
    connection.on('message', (text) => {
      const processMessage = async () => {
        const message = JSON.parse(text);
        if (!client) {
          const expectedOrigin = requireBoundedString(metadata.origin, 'origin', 2_048);
          if (!this.config.perfetto.allowedOrigins.includes(expectedOrigin)) {
            throw new Error('Perfetto origin is not allowed');
          }
          if (handshake.phase === 'await_challenge') {
            if (!isRecord(message)
              || !hasExactKeys(message, ['type', 'protocolVersion', 'clientNonce', 'audience'])
              || message.type !== 'auth_challenge'
              || message.protocolVersion !== PROTOCOL_VERSION) {
              throw new Error('First message must be a valid authentication challenge');
            }
            const audience = validateAuthAudience(
              message.audience,
              expectedOrigin,
              this.config.perfetto.allowedPluginIds ?? ['io.company.RELUPerfettoBridge'],
            );
            const clientNonce = validateAuthNonce(message.clientNonce, 'clientNonce');
            const serverNonce = crypto.randomBytes(32).toString('hex');
            handshake = { phase: 'await_response', audience, clientNonce, serverNonce };
            connection.sendJson({
              type: 'auth_challenge_ack',
              protocolVersion: PROTOCOL_VERSION,
              clientNonce,
              serverNonce,
              audience,
              serverProof: computePerfettoServerProof(this.config.perfetto.token, {
                ...audience, clientNonce, serverNonce,
              }),
            });
            return;
          }
          if (!isRecord(message)
            || !hasExactKeys(message, [
              'type', 'protocolVersion', 'clientNonce', 'serverNonce', 'audience',
              'clientProof', 'client', 'trace',
            ])
            || message.type !== 'auth_response'
            || message.protocolVersion !== PROTOCOL_VERSION) {
            throw new Error('Second message must be a valid authentication response');
          }
          const audience = validateAuthAudience(
            message.audience,
            expectedOrigin,
            this.config.perfetto.allowedPluginIds ?? ['io.company.RELUPerfettoBridge'],
          );
          const clientNonce = validateAuthNonce(message.clientNonce, 'clientNonce');
          const serverNonce = validateAuthNonce(message.serverNonce, 'serverNonce');
          if (!secureEqual(clientNonce, handshake.clientNonce)
            || !secureEqual(serverNonce, handshake.serverNonce)
            || audience.origin !== handshake.audience.origin
            || audience.pluginId !== handshake.audience.pluginId) {
            throw new Error('Perfetto authentication transcript changed');
          }
          if (!isRecord(message.client)
            || !hasExactKeys(message.client, ['clientId', 'pluginId', 'pluginVersion'])) {
            throw new Error('Perfetto client identity is invalid');
          }
          const id = requireBoundedString(message.client?.clientId, 'client.clientId', 128);
          if (!CLIENT_ID.test(id)) throw new Error('client.clientId is invalid');
          const pluginId = requireBoundedString(message.client?.pluginId, 'client.pluginId', 200);
          if (pluginId !== audience.pluginId) throw new Error('Perfetto plugin audience changed');
          const pluginVersion = requireBoundedString(message.client?.pluginVersion, 'client.pluginVersion', 100);
          const trace = validateTraceDescriptor(message.trace);
          if (typeof message.clientProof !== 'string' || !AUTH_PROOF.test(message.clientProof)
            || !secureEqual(message.clientProof, computePerfettoClientProof(this.config.perfetto.token, {
              ...audience,
              clientNonce,
              serverNonce,
              client: { clientId: id, pluginId, pluginVersion },
              trace,
            }))) {
            throw new Error('Perfetto client proof is invalid');
          }
          const binding = computeTraceBinding({
            origin: metadata.origin ?? '',
            pluginId,
            clientId: id,
            traceId: trace.traceId,
          });
          const resourceBinding = computeTraceResourceBinding({
            origin: metadata.origin ?? '',
            pluginId,
            traceId: trace.traceId,
          });
          if (!this.clients.has(id) && this.clients.size >= this.config.perfetto.maxClients) {
            throw new Error('Perfetto client limit reached');
          }
          const previous = this.clients.get(id);
          if (previous) previous.connection.close(4001, 'replaced by reconnect');
          const attachment = this.store.list().find((item) => (
            item.refClientId === id && item.refTraceBinding === binding
          ) || (
            item.dutClientId === id && item.dutTraceBinding === binding
          ));
          client = {
            id,
            connection,
            traceTitle: trace.title,
            trace,
            traceBinding: binding,
            traceResourceBinding: resourceBinding,
            plugin: {
              id: pluginId,
              version: pluginVersion,
            },
            capabilities: [...METHODS],
            connectedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            sessionId: attachment?.id ?? null,
            role: attachment?.refClientId === id ? 'ref' : attachment?.dutClientId === id ? 'dut' : null,
            origin: metadata.origin ?? null,
            queryRequestId: null,
          };
          handshake = { phase: 'authenticated' };
          this.clients.set(id, client);
          clearTimeout(authTimer);
          await this.audit.append({ category: 'perfetto', action: 'client.connect', clientId: id, origin: metadata.origin });
          connection.sendJson({
            type: 'hello_ack',
            protocolVersion: PROTOCOL_VERSION,
            accepted: true,
            connectionId: id,
            heartbeatMs: 20_000,
          });
          if (attachment) {
            const role = attachment.refClientId === id ? 'ref' : 'dut';
            queueMicrotask(() => {
              void this.request(id, 'session.attach', {
                sessionId: attachment.id,
                role: role.toUpperCase(),
                displayName: client.traceTitle,
              }).catch((error) => {
                void this.audit.append({
                  category: 'perfetto',
                  action: 'session.restore',
                  clientId: id,
                  sessionId: attachment.id,
                  error: boundedError(error),
                }).catch(() => {});
              });
            });
          }
          return;
        }
        client.lastSeenAt = new Date().toISOString();
        if (message.type === 'response') return this.handleResponse(client, message);
        if (message.type === 'event') return this.handleEvent(client, message);
        throw new Error(`Unsupported bridge message type: ${message.type}`);
      };
      const pendingMessage = messageChain ? messageChain.then(processMessage) : processMessage();
      messageChain = pendingMessage.catch(async (error) => {
        if (!client) {
          try {
            connection.sendJson({
              type: 'hello_ack',
              protocolVersion: PROTOCOL_VERSION,
              accepted: false,
              error: 'Perfetto mutual authentication failed',
            });
          } catch {}
          connection.close(1008, 'authentication failed');
        } else if (error?.code !== 'APPROVAL_REQUIRED') {
          connection.close(1008, 'invalid Perfetto message');
        }
        try {
          await this.audit.append({
            category: 'perfetto',
            action: 'client.message',
            clientId: client?.id,
            error: client ? boundedError(error) : 'Perfetto mutual authentication failed',
          });
        } catch {}
      });
    });
    connection.on('error', (error) => {
      void this.audit.append({ category: 'perfetto', action: 'client.socket', clientId: client?.id, error: boundedError(error) }).catch(() => {});
    });
    connection.on('close', () => {
      clearTimeout(authTimer);
      this.connections.delete(connection);
      if (!client || this.clients.get(client.id)?.connection !== connection) return;
      this.clients.delete(client.id);
      for (const [requestId, pending] of this.pending) {
        if (pending.clientId !== client.id || pending.connection !== connection) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error(`Perfetto client disconnected: ${client.id}`));
        this.pending.delete(requestId);
      }
      void this.audit.append({ category: 'perfetto', action: 'client.disconnect', clientId: client.id }).catch(() => {});
    });
  }

  handleResponse(client, message) {
    const pending = this.pending.get(message.id);
    if (!pending || pending.clientId !== client.id || pending.connection !== client.connection) {
      if (client.queryRequestId === message.id) client.queryRequestId = null;
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (client.queryRequestId === message.id) client.queryRequestId = null;
    if (typeof message.ok !== 'boolean') {
      pending.reject(new Error('Perfetto client returned an invalid response'));
      client.connection.close(1002, 'invalid response');
      return;
    }
    if (message.ok === false) {
      const suppliedCode = typeof message.error?.code === 'string' ? message.error.code : '';
      const code = SAFE_CLIENT_ERROR_CODES.has(suppliedCode) ? suppliedCode : 'CLIENT_ERROR';
      pending.reject(new Error(`Perfetto client request failed (${code})`));
      return;
    }
    try {
      pending.resolve(validatePerfettoResult(pending.method, message.result, pending, client, this.config));
    } catch {
      pending.reject(new Error('Perfetto client returned an invalid response'));
      client.connection.close(1002, 'invalid response');
    }
  }

  async handleEvent(client, message) {
    if (message.name === 'bridge.pong') return;
    if (message.name === 'session.attach_requested') {
      const sessionId = String(message.payload?.sessionId ?? '');
      const role = message.payload?.role === 'REF' ? 'ref' : message.payload?.role === 'DUT' ? 'dut' : null;
      if (!role) throw new Error('Session attach role must be REF or DUT');
      await this.requestAttach(sessionId, role, client.id, 'plugin');
      return;
    }
    throw new Error('Unsupported Perfetto event');
  }

  listClients() {
    return [...this.clients.values()].map(publicClient);
  }

  getClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Perfetto client is not connected: ${clientId}`);
    return client;
  }

  createSnapshot(clientOrId, selector = {}) {
    const client = typeof clientOrId === 'string' ? this.getClient(clientOrId) : clientOrId;
    if (!client || this.clients.get(client.id) !== client) throw new Error('Perfetto client is not connected');
    return Object.freeze({
      clientId: client.id,
      traceBinding: client.traceBinding,
      traceResourceBinding: client.traceResourceBinding,
      connection: client.connection,
      pluginVersion: client.plugin.version,
      origin: client.origin ?? '',
      sessionId: selector.sessionId ?? null,
      role: selector.role ?? null,
    });
  }

  assertSnapshot(snapshot) {
    const client = this.clients.get(snapshot.clientId);
    if (!client || client.traceBinding !== snapshot.traceBinding
      || client.traceResourceBinding !== snapshot.traceResourceBinding
      || client.connection !== snapshot.connection || client.plugin.version !== snapshot.pluginVersion) {
      throw new Error('Perfetto target changed after approval; retry against the current trace');
    }
    if (snapshot.sessionId || snapshot.role) {
      if (!snapshot.sessionId || !snapshot.role) throw new Error('Perfetto target snapshot is invalid');
      const assigned = this.resolveSessionClient(snapshot.sessionId, snapshot.role);
      if (assigned !== client) throw new Error('Perfetto target changed after approval; retry against the current trace');
    }
    return client;
  }

  requestSnapshot(snapshot, method, params = {}, options = {}) {
    this.assertSnapshot(snapshot);
    return this.request(snapshot.clientId, method, params, options);
  }

  async request(clientId, method, params = {}, options = {}) {
    const client = this.getClient(clientId);
    if (!METHODS.has(method)) throw new Error(`Unsupported Perfetto bridge method: ${method}`);
    if (method === 'trace.query' && client.queryRequestId) {
      throw new Error('A previous trace query is still running in this Perfetto client');
    }
    if (this.pending.size >= this.config.perfetto.maxConcurrentRequests) throw new Error('Too many concurrent Perfetto requests');
    const id = randomId('request_');
    const timeoutMs = Math.min(
      Number(options.timeoutMs ?? this.config.perfetto.requestTimeoutMs),
      this.config.perfetto.requestTimeoutMs,
    );
    const requestParams = structuredClone(params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Perfetto v57.2 exposes no supported query cancellation API. Keep this
        // client query-locked until its late response arrives or it reconnects.
        reject(new Error(`Perfetto request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        clientId,
        connection: client.connection,
        method,
        params: requestParams,
        resolve,
        reject,
        timer,
      });
      if (method === 'trace.query') client.queryRequestId = id;
      try {
        client.connection.sendJson({ type: 'request', id, method, params: requestParams });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (client.queryRequestId === id) client.queryRequestId = null;
        reject(error);
      }
    });
  }

  approvalBinding(clientOrId) {
    const client = typeof clientOrId === 'string' ? this.getClient(clientOrId) : clientOrId;
    return client.traceBinding;
  }

  attachApproval(sessionOrId, role, clientOrSnapshot, source = 'mcp', approvalSessionId = null) {
    const session = typeof sessionOrId === 'string' ? this.store.get(sessionOrId) : sessionOrId;
    const snapshot = typeof clientOrSnapshot === 'string'
      ? this.createSnapshot(clientOrSnapshot)
      : clientOrSnapshot;
    const client = this.assertSnapshot(snapshot);
    if (!['ref', 'dut'].includes(role)) throw new Error('role must be ref or dut');
    return {
      scope: `perfetto.session.attach:${session.id}:${session.instanceId}:${role}:${client.traceBinding}`,
      summary: `Attach trace ${client.traceBinding.slice(0, 12)} as ${role.toUpperCase()} in session ${session.id}`,
      details: {
        source, clientId: client.id, traceBinding: client.traceBinding, instanceId: session.instanceId,
      },
      displayDetails: {
        source,
        sessionId: session.id,
        instanceKey: session.instanceId.slice(-12),
        role,
        traceKey: client.traceBinding.slice(0, 12),
      },
      sessionId: approvalSessionId,
      allowedDecisions: approvalSessionId
        ? ['once', 'session', 'always', 'deny']
        : ['once', 'always', 'deny'],
    };
  }

  async requestAttach(sessionId, role, clientId, source = 'mcp', approvalSessionId = null) {
    if (!this.approvals) throw new Error('Approval service is unavailable');
    const session = this.store.get(sessionId);
    const snapshot = this.createSnapshot(clientId);
    await this.approvals.require(this.attachApproval(session, role, snapshot, source, approvalSessionId));
    return this.assignmentMutex.runExclusive(() => (
      this.attachAuthorized(sessionId, role, snapshot, session.instanceId)
    ));
  }

  async attachAuthorized(sessionId, role, snapshot, expectedInstanceId) {
    let client = this.assertSnapshot(snapshot);
    const previousSession = this.store.get(sessionId);
    if (previousSession.instanceId !== expectedInstanceId) {
      throw new Error('Perfetto session changed after approval; retry against the current session');
    }
    const displacedClientId = role === 'ref' ? previousSession.refClientId : previousSession.dutClientId;
    await this.requestSnapshot(snapshot, 'session.attach', {
      sessionId,
      role: role.toUpperCase(),
      displayName: client.traceTitle,
    });
    client = this.assertSnapshot(snapshot);
    let session;
    try {
      session = await this.store.attach(
        sessionId, role, client.id, snapshot.traceBinding, expectedInstanceId,
      );
      client = this.assertSnapshot(snapshot);
    } catch (error) {
      snapshot.connection.close(1011, 'assignment persistence or target validation failed');
      throw error;
    }
    this.synchronizeAssignments();
    if (displacedClientId && displacedClientId !== client.id) {
      this.clients.get(displacedClientId)?.connection.close(4002, 'assignment changed');
    }
    return { session, client: publicClient(client) };
  }

  synchronizeAssignments() {
    const sessions = this.store.list();
    for (const client of this.clients.values()) {
      const attachment = sessions.find((item) => (
        item.refClientId === client.id && item.refTraceBinding === client.traceBinding
      ) || (
        item.dutClientId === client.id && item.dutTraceBinding === client.traceBinding
      ));
      const refMatches = attachment?.refClientId === client.id && attachment.refTraceBinding === client.traceBinding;
      const dutMatches = attachment?.dutClientId === client.id && attachment.dutTraceBinding === client.traceBinding;
      client.sessionId = refMatches || dutMatches ? attachment.id : null;
      client.role = refMatches ? 'ref' : dutMatches ? 'dut' : null;
    }
  }

  assertSessionInstance(sessionId, expectedInstanceId) {
    const session = this.store.get(sessionId);
    if (session.instanceId !== expectedInstanceId) {
      throw new Error('Perfetto session changed after approval; retry against the current session');
    }
    return session;
  }

  async withSessionInstance(sessionId, expectedInstanceId, callback) {
    return this.assignmentMutex.runExclusive(async () => {
      const session = this.assertSessionInstance(sessionId, expectedInstanceId);
      return callback(session);
    });
  }

  async detach(sessionId, role, snapshot = null, expectedInstanceId = null) {
    return this.assignmentMutex.runExclusive(async () => {
      const approvedClient = snapshot ? this.assertSnapshot(snapshot) : null;
      const before = this.store.get(sessionId);
      if (expectedInstanceId !== null && before.instanceId !== expectedInstanceId) {
        throw new Error('Perfetto session changed after approval; retry against the current session');
      }
      const clientId = role === 'ref' ? before.refClientId : before.dutClientId;
      const traceBinding = role === 'ref' ? before.refTraceBinding : before.dutTraceBinding;
      if (snapshot && (clientId !== approvedClient.id || traceBinding !== snapshot.traceBinding)) {
        throw new Error('Perfetto target changed after approval; retry against the current trace');
      }
      const session = await this.store.detach(sessionId, role, snapshot ? {
        instanceId: expectedInstanceId,
        clientId: approvedClient.id,
        traceBinding: snapshot.traceBinding,
      } : null);
      this.synchronizeAssignments();
      if (snapshot) snapshot.connection.close(4002, 'assignment detached');
      else if (clientId) this.clients.get(clientId)?.connection.close(4002, 'assignment detached');
      return session;
    });
  }

  async removeSession(sessionId, expectedInstanceId = null) {
    return this.assignmentMutex.runExclusive(async () => {
      const before = this.store.get(sessionId);
      const result = await this.store.remove(sessionId, expectedInstanceId);
      this.synchronizeAssignments();
      for (const clientId of [before.refClientId, before.dutClientId]) {
        if (clientId) this.clients.get(clientId)?.connection.close(4002, 'session removed');
      }
      return result;
    });
  }

  resolveSessionClient(sessionId, role) {
    const session = this.store.get(sessionId);
    const clientId = role === 'ref' ? session.refClientId : session.dutClientId;
    if (!clientId) throw new Error(`Session ${sessionId} has no ${role.toUpperCase()} client`);
    const client = this.getClient(clientId);
    const expectedBinding = role === 'ref' ? session.refTraceBinding : session.dutTraceBinding;
    if (!expectedBinding || expectedBinding !== client.traceBinding) {
      throw new Error(`Session ${sessionId} has a stale ${role.toUpperCase()} trace assignment`);
    }
    return client;
  }

  ping() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      if (now - Date.parse(client.lastSeenAt) > 60_000) {
        client.connection.close(4000, 'heartbeat timeout');
      } else {
        client.connection.ping(String(now));
        client.connection.sendJson({ type: 'ping', nonce: String(now) });
      }
    }
  }

  shutdown() {
    clearInterval(this.pingTimer);
    for (const connection of this.connections) connection.close(1001, 'server shutdown');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Perfetto broker is shutting down'));
    }
    this.pending.clear();
  }
}
