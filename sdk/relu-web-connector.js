const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:5746/relu/ws';
const PROTOCOL_VERSION = '1.0';
const HANDSHAKE_TIMEOUT_MS = 5_000;
const RESET_RECONNECT_DELAY_MS = 100;
const MAX_RESET_RECONNECTS = 1;
const MAX_INBOUND_MESSAGE_CHARS = 1_048_576;
const SESSION_ID = /^[a-zA-Z0-9_-]{3,128}$/u;
const RESUME_SECRET = /^[a-zA-Z0-9_-]{24,256}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const AUTH_NONCE = /^[a-f0-9]{64}$/u;
const AUTH_PROOF = /^[a-f0-9]{64}$/u;
const AUTH_AUDIENCE = 'relu-ai-bridge://loopback/relu/ws';
const UTF8 = new TextEncoder();

function assertBridgeUrl(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'ws:' || !loopback || url.pathname !== '/relu/ws' || url.username || url.password || url.search || url.hash) {
    throw new Error('bridgeUrl must be an exact loopback ws:// URL ending in /relu/ws');
  }
  return url.toString();
}

function randomClientId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `browser_${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function randomNonce() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function assertPageOrigin(explicitOrigin) {
  const runtimeOrigin = typeof globalThis.location?.origin === 'string' && globalThis.location.origin !== 'null'
    ? globalThis.location.origin
    : null;
  if (runtimeOrigin && explicitOrigin !== undefined && explicitOrigin !== runtimeOrigin) {
    throw new Error('Configured origin must exactly match the current page Origin');
  }
  const value = runtimeOrigin ?? explicitOrigin;
  if (typeof value !== 'string') throw new Error('A browser page Origin is required');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
    throw new Error('origin must be an exact HTTP(S) Origin');
  }
  return value;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateJsonTree(value, name) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > 20_000 || current.depth > 16) throw new Error(`${name} is too large or deeply nested`);
    const item = current.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number' && Number.isFinite(item)) continue;
    if (Array.isArray(item)) {
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(item)) throw new Error(`${name} must contain JSON values only`);
    for (const child of Object.values(item)) stack.push({ value: child, depth: current.depth + 1 });
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function authPayload(role, serviceId, origin, clientNonce, serverNonce, registrationDigest = '') {
  return stableJson([
    'RELU_GENERIC_CONNECTOR_AUTH', PROTOCOL_VERSION, AUTH_AUDIENCE, role,
    serviceId, origin, clientNonce, serverNonce, registrationDigest,
  ]);
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', UTF8.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(token, value) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', UTF8.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, UTF8.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

function assertKnownKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name} contains an unsupported field: ${key}`);
  }
}

function parseJsonMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_INBOUND_MESSAGE_CHARS) {
    throw new Error('Bridge messages must be bounded text JSON');
  }
  const message = JSON.parse(raw);
  if (!isRecord(message) || typeof message.type !== 'string') throw new Error('Bridge message must be a JSON object with a type');
  return message;
}

function parseHelloAck(message) {
  if (message.type !== 'hello_ack') throw new Error('Only hello_ack is allowed before authentication');
  if (message.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported bridge protocol version');
  if (typeof message.accepted !== 'boolean') throw new Error('hello_ack.accepted must be a boolean');

  if (message.accepted) {
    assertKnownKeys(message, new Set([
      'type', 'protocolVersion', 'accepted', 'sessionId', 'resumeSecret', 'heartbeatMs',
    ]), 'accepted hello_ack');
    if (typeof message.sessionId !== 'string' || !SESSION_ID.test(message.sessionId)) {
      throw new Error('hello_ack.sessionId is invalid');
    }
    if (typeof message.resumeSecret !== 'string' || !RESUME_SECRET.test(message.resumeSecret)) {
      throw new Error('hello_ack.resumeSecret is invalid');
    }
    if (message.heartbeatMs !== undefined && (
      !Number.isSafeInteger(message.heartbeatMs) || message.heartbeatMs < 1_000 || message.heartbeatMs > 300_000
    )) {
      throw new Error('hello_ack.heartbeatMs is invalid');
    }
    return {
      type: 'hello_ack',
      protocolVersion: PROTOCOL_VERSION,
      accepted: true,
      sessionId: message.sessionId,
      resumeSecret: message.resumeSecret,
      heartbeatMs: message.heartbeatMs,
    };
  }

  assertKnownKeys(message, new Set([
    'type', 'protocolVersion', 'accepted', 'errorCode', 'error',
  ]), 'rejected hello_ack');
  if (message.errorCode !== undefined && (
    typeof message.errorCode !== 'string' || !ERROR_CODE.test(message.errorCode)
  )) {
    throw new Error('hello_ack.errorCode is invalid');
  }
  if (message.error !== undefined && (
    typeof message.error !== 'string' || message.error.length === 0 || message.error.length > 1_000
  )) {
    throw new Error('hello_ack.error is invalid');
  }
  return {
    type: 'hello_ack',
    protocolVersion: PROTOCOL_VERSION,
    accepted: false,
    errorCode: message.errorCode,
    error: message.error,
  };
}

function parseAuthChallenge(message, expected) {
  if (message.type !== 'auth_challenge') throw new Error('Only auth_challenge is allowed before server authentication');
  assertKnownKeys(message, new Set([
    'type', 'protocolVersion', 'serviceId', 'origin', 'clientNonce', 'serverNonce', 'proof',
  ]), 'auth_challenge');
  if (message.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported bridge protocol version');
  if (message.serviceId !== expected.serviceId || message.origin !== expected.origin
    || message.clientNonce !== expected.clientNonce) {
    throw new Error('auth_challenge audience binding is invalid');
  }
  if (typeof message.serverNonce !== 'string' || !AUTH_NONCE.test(message.serverNonce)) {
    throw new Error('auth_challenge.serverNonce is invalid');
  }
  if (typeof message.proof !== 'string' || !AUTH_PROOF.test(message.proof)) {
    throw new Error('auth_challenge.proof is invalid');
  }
  return message;
}

function parseConnectedMessage(message) {
  if (message.type === 'ping') {
    assertKnownKeys(message, new Set(['type', 'nonce']), 'ping');
    if (typeof message.nonce !== 'string' || message.nonce.length === 0 || message.nonce.length > 256) {
      throw new Error('ping.nonce is invalid');
    }
    return message;
  }
  if (message.type !== 'request') throw new Error('Unsupported bridge message');
  assertKnownKeys(message, new Set([
    'type', 'id', 'action', 'parameters', 'timeoutMs', 'operationId', 'contextGuard',
  ]), 'request');
  if (typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 128) {
    throw new Error('request.id is invalid');
  }
  if (typeof message.action !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(message.action)) {
    throw new Error('request.action is invalid');
  }
  if (message.parameters !== undefined && !isRecord(message.parameters)) {
    throw new Error('request.parameters must be an object');
  }
  if (message.timeoutMs !== undefined && (
    !Number.isSafeInteger(message.timeoutMs) || message.timeoutMs < 1 || message.timeoutMs > 60_000
  )) {
    throw new Error('request.timeoutMs is invalid');
  }
  if (message.operationId !== undefined && (
    typeof message.operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(message.operationId)
  )) {
    throw new Error('request.operationId is invalid');
  }
  if (!isRecord(message.contextGuard)) throw new Error('request.contextGuard is required');
  assertKnownKeys(message.contextGuard, new Set(['fields', 'projection', 'binding']), 'request.contextGuard');
  const { fields, projection, binding } = message.contextGuard;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 8
    || fields.some((field) => typeof field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(field))
    || new Set(fields).size !== fields.length) throw new Error('request.contextGuard.fields is invalid');
  if (!isRecord(projection) || Object.keys(projection).length !== fields.length
    || fields.some((field) => !Object.hasOwn(projection, field))) {
    throw new Error('request.contextGuard.projection is invalid');
  }
  if (typeof binding !== 'string' || !/^[a-f0-9]{64}$/u.test(binding)) {
    throw new Error('request.contextGuard.binding is invalid');
  }
  validateJsonTree(projection, 'request.contextGuard.projection');
  return message;
}

export class ReluWebConnector {
  constructor(options) {
    if (!options || typeof options !== 'object') throw new Error('Connector options are required');
    if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(options.serviceId ?? '')) throw new Error('serviceId is invalid');
    if (typeof options.token !== 'string' || options.token.length < 24) throw new Error('A service-specific connector token is required');
    if (typeof options.getContext !== 'function') throw new Error('getContext must be a function');
    if (!options.capabilities || typeof options.capabilities !== 'object' || Array.isArray(options.capabilities)) {
      throw new Error('capabilities must map allowlisted action names to handlers');
    }
    this.serviceId = options.serviceId;
    this.token = options.token;
    if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
      throw new Error('Web Crypto is required for connector authentication');
    }
    this.origin = assertPageOrigin(options.origin);
    this.connectorVersion = String(options.connectorVersion ?? '0.3.0');
    this.getContext = options.getContext;
    this.capabilities = new Map(Object.entries(options.capabilities));
    for (const [name, handler] of this.capabilities) {
      if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(name) || typeof handler !== 'function') throw new Error(`Invalid capability handler: ${name}`);
    }
    this.bridgeUrl = assertBridgeUrl(options.bridgeUrl ?? DEFAULT_BRIDGE_URL);
    this.clientId = randomClientId();
    this.sessionId = null;
    this.state = 'stopped';
    this.socket = null;
    this.stopped = true;
    this.authRejected = false;
    this.reconnectAttempt = 0;
    this.resetReconnects = 0;
    this.resetReconnectPending = false;
    this.resumeSecret = null;
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    this.contextTimer = null;
    this.handshake = null;
    this.listenersInstalled = false;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.boundActive = () => this.markActive(document.visibilityState === 'visible' && document.hasFocus());
    this.boundContext = () => this.scheduleContextUpdate();
  }

  transition(state, details = {}) {
    this.state = state;
    try {
      this.onStatus({ state, ...details });
    } catch {
      // A consumer callback must not break the connector authentication state machine.
    }
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.authRejected = false;
    this.resetReconnects = 0;
    this.resetReconnectPending = false;
    this.installListeners();
    await this.connect();
  }

  stop() {
    this.stopped = true;
    this.authRejected = false;
    this.resetReconnectPending = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.contextTimer);
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.sessionId = null;
    this.handshake = null;
    socket?.close(1000, 'connector stopped');
    this.removeListeners();
    this.transition('stopped');
  }

  installListeners() {
    if (this.listenersInstalled || typeof document === 'undefined') return;
    this.listenersInstalled = true;
    window.addEventListener('focus', this.boundActive);
    window.addEventListener('blur', this.boundActive);
    document.addEventListener('visibilitychange', this.boundActive);
    window.addEventListener('hashchange', this.boundContext);
    window.addEventListener('popstate', this.boundContext);
  }

  removeListeners() {
    if (!this.listenersInstalled || typeof document === 'undefined') return;
    this.listenersInstalled = false;
    window.removeEventListener('focus', this.boundActive);
    window.removeEventListener('blur', this.boundActive);
    document.removeEventListener('visibilitychange', this.boundActive);
    window.removeEventListener('hashchange', this.boundContext);
    window.removeEventListener('popstate', this.boundContext);
  }

  async connect() {
    if (this.stopped || this.authRejected) return;
    this.transition('connecting');
    let context;
    try {
      context = jsonClone(await this.getContext());
    } catch (error) {
      if (this.stopped) return;
      this.transition('disconnected', { detail: String(error?.message ?? error).slice(0, 1_000) });
      this.scheduleReconnect();
      return;
    }
    if (this.stopped || this.authRejected) return;

    let socket;
    try {
      socket = new WebSocket(this.bridgeUrl);
    } catch (error) {
      this.transition('disconnected', { detail: String(error?.message ?? error).slice(0, 1_000) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (socket !== this.socket || this.stopped || this.state !== 'connecting') return;
      this.transition('authenticating');
      const clientNonce = randomNonce();
      this.handshake = {
        stage: 'await_challenge', clientNonce, serviceId: this.serviceId, origin: this.origin, context,
      };
      this.sendRaw({
        type: 'auth_init',
        protocolVersion: PROTOCOL_VERSION,
        serviceId: this.serviceId,
        clientNonce,
      }, socket);
      this.handshakeTimer = setTimeout(() => {
        if (socket === this.socket && this.state === 'authenticating') socket.close(4000, 'authentication timeout');
      }, HANDSHAKE_TIMEOUT_MS);
      this.handshakeTimer.unref?.();
    });

    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) return;
      void this.handleMessage(event.data, socket).catch((error) => this.rejectProtocolMessage(socket, error));
    });

    socket.addEventListener('close', (event) => {
      if (socket !== this.socket) return;
      const previousState = this.state;
      this.socket = null;
      this.sessionId = null;
      this.handshake = null;
      this.clearHandshakeTimer();

      if (this.stopped) return;
      if (this.resetReconnectPending) {
        this.resetReconnectPending = false;
        this.scheduleReconnect(RESET_RECONNECT_DELAY_MS);
        return;
      }
      if (this.authRejected || previousState === 'rejected') {
        if (this.state !== 'rejected') this.transition('rejected');
        return;
      }
      if (previousState === 'authenticating' && (event.code === 1008 || event.code === 4003)) {
        this.authRejected = true;
        this.transition('rejected', { detail: event.reason || 'Authentication rejected' });
        return;
      }
      this.transition('disconnected', { detail: event.reason || undefined });
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (socket === this.socket) {
        try {
          this.onStatus({ state: this.state, detail: 'WebSocket error' });
        } catch {}
      }
    });
  }

  async handleMessage(raw, socket = this.socket) {
    if (!socket || socket !== this.socket) return;
    const message = parseJsonMessage(raw);

    if (this.state === 'authenticating') {
      if (this.handshake?.stage === 'await_challenge') {
        await this.handleAuthChallenge(parseAuthChallenge(message, this.handshake), socket);
        return;
      }
      if (this.handshake?.stage !== 'await_ack') throw new Error('Authentication message is out of order');
      this.handleHelloAck(parseHelloAck(message), socket);
      return;
    }
    if (this.state !== 'connected') throw new Error(`Bridge message is not allowed while ${this.state}`);

    const connectedMessage = parseConnectedMessage(message);
    if (connectedMessage.type === 'ping') {
      this.send({ type: 'pong', nonce: connectedMessage.nonce }, socket);
      return;
    }
    await this.handleRequest(connectedMessage, socket);
  }

  async handleAuthChallenge(message, socket) {
    const handshake = this.handshake;
    if (socket !== this.socket || this.state !== 'authenticating' || handshake?.stage !== 'await_challenge') {
      throw new Error('Unexpected auth_challenge');
    }
    const expectedServerProof = await hmacHex(this.token, authPayload(
      'server', this.serviceId, this.origin, handshake.clientNonce, message.serverNonce,
    ));
    if (socket !== this.socket || handshake !== this.handshake || this.state !== 'authenticating'
      || handshake.stage !== 'await_challenge') return;
    if (!constantTimeHexEqual(message.proof, expectedServerProof)) {
      throw new Error('Bridge server authentication proof is invalid');
    }

    const registration = {
      client: {
        clientId: this.clientId,
        serviceId: this.serviceId,
        connectorVersion: this.connectorVersion,
        capabilities: [...this.capabilities.keys()],
        ...(this.resumeSecret ? { resumeSecret: this.resumeSecret } : {}),
      },
      context: handshake.context,
      active: typeof document === 'undefined' ? false : document.visibilityState === 'visible' && document.hasFocus(),
    };
    const registrationDigest = await sha256Hex(stableJson(registration));
    const proof = await hmacHex(this.token, authPayload(
      'client', this.serviceId, this.origin, handshake.clientNonce, message.serverNonce, registrationDigest,
    ));
    if (socket !== this.socket || handshake !== this.handshake || this.state !== 'authenticating'
      || handshake.stage !== 'await_challenge') return;
    handshake.stage = 'await_ack';
    handshake.serverNonce = message.serverNonce;
    delete handshake.context;
    this.sendRaw({
      type: 'auth_response',
      protocolVersion: PROTOCOL_VERSION,
      serviceId: this.serviceId,
      clientNonce: handshake.clientNonce,
      serverNonce: message.serverNonce,
      registration,
      proof,
    }, socket);
  }

  handleHelloAck(message, socket) {
    if (socket !== this.socket || this.state !== 'authenticating' || this.handshake?.stage !== 'await_ack') {
      throw new Error('Unexpected hello_ack');
    }
    this.clearHandshakeTimer();

    if (message.accepted) {
      this.authRejected = false;
      this.resetReconnects = 0;
      this.reconnectAttempt = 0;
      this.sessionId = message.sessionId;
      this.resumeSecret = message.resumeSecret;
      this.handshake = null;
      this.transition('connected', { sessionId: message.sessionId });
      return;
    }

    if (message.errorCode === 'RESET_REQUIRED') {
      if (this.resetReconnects >= MAX_RESET_RECONNECTS) {
        this.rejectAuthentication(socket, 'RESET_LIMIT_REACHED', 'Repeated RESET_REQUIRED was rejected');
        return;
      }
      this.resetReconnects += 1;
      this.resumeSecret = null;
      this.sessionId = null;
      this.handshake = null;
      this.clientId = randomClientId();
      this.resetReconnectPending = true;
      this.transition('resetting', { errorCode: 'RESET_REQUIRED', detail: message.error });
      socket.close(4004, 'reset required');
      return;
    }

    this.rejectAuthentication(
      socket,
      message.errorCode ?? 'AUTHENTICATION_REJECTED',
      message.error ?? 'Authentication or registration rejected',
    );
  }

  rejectAuthentication(socket, errorCode, detail) {
    this.authRejected = true;
    this.resetReconnectPending = false;
    this.sessionId = null;
    this.handshake = null;
    this.transition('rejected', { errorCode, detail });
    socket.close(1008, 'registration rejected');
  }

  rejectProtocolMessage(socket, error) {
    if (socket !== this.socket) return;
    this.authRejected = true;
    this.resetReconnectPending = false;
    this.sessionId = null;
    this.handshake = null;
    this.clearHandshakeTimer();
    this.transition('rejected', {
      errorCode: 'PROTOCOL_ERROR',
      detail: String(error?.message ?? error).slice(0, 1_000),
    });
    socket.close(1008, 'invalid bridge message');
  }

  async handleRequest(message, socket) {
    const handler = this.capabilities.get(message.action);
    if (!handler) {
      this.send({ type: 'response', id: message.id, ok: false, error: 'Capability is not implemented by this connector' }, socket);
      return;
    }
    const timeoutMs = message.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const liveContext = jsonClone(await this.getContext());
      if (socket !== this.socket || this.state !== 'connected') return;
      if (!isRecord(liveContext)) throw new Error('Live connector context must be an object');
      const liveProjection = {};
      for (const field of message.contextGuard.fields) {
        if (!Object.hasOwn(liveContext, field)) {
          this.send({
            type: 'response', id: message.id, ok: false, errorCode: 'CONTEXT_CHANGED',
            error: 'Connector context changed before capability execution',
          }, socket);
          return;
        }
        liveProjection[field] = liveContext[field];
      }
      validateJsonTree(liveProjection, 'live connector context projection');
      if (stableJson(liveProjection) !== stableJson(message.contextGuard.projection)) {
        this.send({
          type: 'response', id: message.id, ok: false, errorCode: 'CONTEXT_CHANGED',
          error: 'Connector context changed before capability execution',
        }, socket);
        return;
      }
      const result = await handler(jsonClone(message.parameters ?? {}), {
        signal: controller.signal,
        operationId: message.operationId ?? null,
        contextGuard: jsonClone(message.contextGuard),
      });
      if (controller.signal.aborted) throw new Error('Capability execution timed out');
      this.send({ type: 'response', id: message.id, ok: true, result: jsonClone(result) }, socket);
    } catch (error) {
      if (socket === this.socket && this.state === 'connected') {
        this.send({
          type: 'response', id: message.id, ok: false,
          error: controller.signal.aborted ? 'Capability execution timed out' : String(error?.message ?? error).slice(0, 1_000),
        }, socket);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  sendRaw(value, socket = this.socket) {
    if (!socket || socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('RELU AI Bridge socket is not open');
    }
    socket.send(JSON.stringify(value));
  }

  send(value, socket = this.socket) {
    if (this.state !== 'connected') throw new Error('RELU AI Bridge is not authenticated');
    this.sendRaw(value, socket);
  }

  scheduleReconnect(delayOverride = undefined) {
    if (this.stopped || this.authRejected || this.reconnectTimer) return;
    const delay = delayOverride ?? Math.min(500 * (2 ** this.reconnectAttempt), 30_000);
    this.reconnectAttempt += 1;
    this.transition('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  clearHandshakeTimer() {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  scheduleContextUpdate() {
    clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => void this.updateContext(), 100);
  }

  async updateContext(context = undefined) {
    const socket = this.socket;
    if (this.state !== 'connected' || socket?.readyState !== WebSocket.OPEN) return false;
    const next = jsonClone(context === undefined ? await this.getContext() : context);
    if (this.state !== 'connected' || socket !== this.socket) return false;
    this.send({
      type: 'event', event: 'context.update', context: next,
      active: typeof document === 'undefined' ? false : document.visibilityState === 'visible' && document.hasFocus(),
    }, socket);
    return true;
  }

  markActive(active = true) {
    const socket = this.socket;
    if (this.state !== 'connected' || socket?.readyState !== WebSocket.OPEN) return false;
    this.send({ type: 'event', event: 'session.active', active: Boolean(active) }, socket);
    return true;
  }
}
