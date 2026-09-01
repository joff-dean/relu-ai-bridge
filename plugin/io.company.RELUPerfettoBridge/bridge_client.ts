// Copyright (c) 2026. All rights reserved.

import type {PerfettoV57Adapter} from '../../perfetto_adapter/v57';
import {
  PERFETTO_AUTH_NONCE_HEX_LENGTH,
  PERFETTO_AUTH_PROOF_HEX_LENGTH,
  PERFETTO_BRIDGE_PROTOCOL_VERSION,
  isBridgeMethod,
  isRecord,
  perfettoClientProofTranscript,
  perfettoServerProofTranscript,
  validateLoopbackBridgeUrl,
  type BridgeAuthChallengeAck,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
  type JsonValue,
  type PerfettoAuthClient,
  type SelectMappedAreaParams,
  type ServerMessage,
  type SessionAttachParams,
  type TraceQueryParams,
  type TraceRole,
} from '../../perfetto_adapter/protocol';

const MAX_INBOUND_MESSAGE_CHARS = 1_048_576;
const HANDSHAKE_TIMEOUT_MS = 5_500;
const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const SOCKET_OPEN = 1;
const AUTH_NONCE_PATTERN = /^[a-f0-9]{64}$/;
const AUTH_PROOF_PATTERN = /^[a-f0-9]{64}$/;

export type BridgeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'auth_failed';

export interface BridgeConnectionStatus {
  readonly state: BridgeConnectionState;
  readonly detail?: string;
  readonly connectionId?: string;
  readonly reconnectAttempt: number;
}

interface BridgeSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PerfettoBridgeClientOptions {
  readonly endpoint: string;
  readonly token: string;
  /** WebSocket Origin header와 같아야 하는 exact Perfetto page origin. */
  readonly origin: string;
  readonly clientId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly adapter: PerfettoV57Adapter;
  readonly onStatus?: (status: BridgeConnectionStatus) => void;
  readonly socketFactory?: (url: string) => BridgeSocket;
  /** Deterministic unit-test seam. Production plugin은 기본 Web Crypto만 사용한다. */
  readonly authCrypto?: PerfettoAuthCrypto;
}

export interface PerfettoAuthCrypto {
  randomNonce(): string;
  createProof(token: string, transcript: string): Promise<string>;
  verifyProof(
    token: string,
    transcript: string,
    proof: string,
  ): Promise<boolean>;
}

type HandshakeState =
  | {readonly phase: 'idle'}
  | {readonly phase: 'await_server_proof'; readonly clientNonce: string}
  | {
      readonly phase: 'await_hello_ack';
      readonly clientNonce: string;
      readonly serverNonce: string;
    }
  | {readonly phase: 'authenticated'};

export class PerfettoBridgeClient {
  private socket?: BridgeSocket;
  private reconnectTimer?: number;
  private handshakeTimer?: number;
  private reconnectAttempt = 0;
  private shouldReconnect = false;
  private authenticated = false;
  private handshake: HandshakeState = {phase: 'idle'};
  private readonly authCrypto: PerfettoAuthCrypto;
  private attachment?: SessionAttachParams;
  private status: BridgeConnectionStatus = {
    state: 'disconnected',
    reconnectAttempt: 0,
  };

  constructor(private readonly options: PerfettoBridgeClientOptions) {
    this.authCrypto = options.authCrypto ?? WEB_CRYPTO_AUTH;
  }

  getStatus(): BridgeConnectionStatus {
    return this.status;
  }

  getSessionAttachment(): SessionAttachParams | undefined {
    return this.attachment;
  }

  connect(): void {
    validateLoopbackBridgeUrl(this.options.endpoint);
    validateToken(this.options.token);
    validateExactHttpOrigin(this.options.origin);
    this.shouldReconnect = true;
    this.clearReconnectTimer();
    this.openSocket(false);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.authenticated = false;
    this.handshake = {phase: 'idle'};
    this.clearTimers();
    this.socket?.close(1000, 'user disconnect');
    this.socket = undefined;
    this.updateStatus('disconnected');
  }

  dispose(): void {
    if (this.authenticated) {
      this.sendEvent('trace.closing', {
        traceId: this.options.adapter.getTraceInfo().traceId,
      });
    }
    this.disconnect();
  }

  requestSessionAttach(
    sessionId: string,
    role: TraceRole,
    displayName?: string,
  ): void {
    const params = validateSessionAttachParams({
      sessionId,
      role,
      displayName,
    });
    if (!this.authenticated) {
      throw new Error('브리지 인증 연결 후 세션에 연결할 수 있습니다.');
    }
    this.sendEvent('session.attach_requested', params as unknown as JsonValue);
  }

  private openSocket(isReconnect: boolean): void {
    if (this.socket && this.socket.readyState <= SOCKET_OPEN) return;

    this.authenticated = false;
    this.handshake = {phase: 'idle'};
    this.updateStatus(isReconnect ? 'reconnecting' : 'connecting');
    const socketFactory =
      this.options.socketFactory ??
      ((url: string) => new WebSocket(url) as unknown as BridgeSocket);

    let socket: BridgeSocket;
    try {
      socket = socketFactory(
        validateLoopbackBridgeUrl(this.options.endpoint).toString(),
      );
    } catch (error) {
      this.updateStatus('disconnected', errorMessage(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.updateStatus('authenticating');
      try {
        const clientNonce = this.authCrypto.randomNonce();
        validateAuthNonce(clientNonce, 'client nonce');
        this.handshake = {phase: 'await_server_proof', clientNonce};
        // The first frame deliberately contains neither the token nor trace
        // context. A process squatting on the loopback port must prove the
        // configured secret before it learns either.
        this.sendRaw({
          type: 'auth_challenge',
          protocolVersion: PERFETTO_BRIDGE_PROTOCOL_VERSION,
          clientNonce,
          audience: this.authAudience(),
        });
      } catch {
        this.failAuthentication('브리지 인증 challenge 생성 실패');
        return;
      }
      this.handshakeTimer = window.setTimeout(() => {
        if (socket === this.socket && !this.authenticated) {
          this.failAuthentication('브리지 상호 인증 시간 초과');
        }
      }, HANDSHAKE_TIMEOUT_MS);
    };

    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      void this.handleMessage(event.data).catch(() => {
        if (socket !== this.socket) return;
        if (this.authenticated) socket.close(1002, 'invalid bridge message');
        else this.failAuthentication('브리지 상호 인증 실패');
      });
    };

    socket.onerror = () => {
      if (socket === this.socket) {
        this.updateStatus(this.status.state, 'WebSocket 연결 오류');
      }
    };

    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      const wasAuthenticating = this.status.state === 'authenticating';
      this.socket = undefined;
      this.authenticated = false;
      this.handshake = {phase: 'idle'};
      this.attachment = undefined;
      this.clearHandshakeTimer();
      if (wasAuthenticating && (event.code === 1008 || event.code === 4003)) {
        this.shouldReconnect = false;
        this.updateStatus('auth_failed', event.reason || '브리지 인증 실패');
        return;
      }
      if (!this.shouldReconnect) {
        if (this.status.state !== 'auth_failed') {
          this.updateStatus('disconnected', event.reason || undefined);
        }
        return;
      }
      this.updateStatus('reconnecting', event.reason || undefined);
      this.scheduleReconnect();
    };
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message: ServerMessage = parseServerMessage(raw);

    switch (message.type) {
      case 'auth_challenge_ack':
        await this.handleAuthChallengeAck(message);
        return;
      case 'hello_ack':
        this.handleHelloAck(message);
        return;
      case 'ping':
        if (!this.authenticated) {
          throw new Error('인증 전에 ping을 받을 수 없습니다.');
        }
        this.sendEvent('bridge.pong', {nonce: message.nonce});
        return;
      case 'request':
        if (!this.authenticated) {
          throw new Error('인증 전에 request를 받을 수 없습니다.');
        }
        await this.handleRequest(message);
        return;
    }
  }

  private async handleAuthChallengeAck(
    message: BridgeAuthChallengeAck,
  ): Promise<void> {
    const handshake = this.handshake;
    if (handshake.phase !== 'await_server_proof') {
      throw new Error('인증 challenge 응답 순서가 올바르지 않습니다.');
    }
    if (
      message.protocolVersion !== PERFETTO_BRIDGE_PROTOCOL_VERSION ||
      message.clientNonce !== handshake.clientNonce ||
      message.audience.origin !== this.options.origin ||
      message.audience.pluginId !== this.options.pluginId
    ) {
      throw new Error('인증 challenge transcript가 변경되었습니다.');
    }
    validateAuthNonce(message.serverNonce, 'server nonce');
    validateAuthProof(message.serverProof, 'server proof');
    const serverAuthenticated = await this.authCrypto.verifyProof(
      this.options.token,
      perfettoServerProofTranscript({
        ...message.audience,
        clientNonce: handshake.clientNonce,
        serverNonce: message.serverNonce,
      }),
      message.serverProof,
    );
    if (!serverAuthenticated || this.handshake !== handshake) {
      throw new Error('브리지가 server proof를 증명하지 못했습니다.');
    }

    const client: PerfettoAuthClient = {
      clientId: this.options.clientId,
      pluginId: this.options.pluginId,
      pluginVersion: this.options.pluginVersion,
    };
    const trace = this.options.adapter.getTraceInfo();
    const clientProof = await this.authCrypto.createProof(
      this.options.token,
      perfettoClientProofTranscript({
        ...message.audience,
        clientNonce: handshake.clientNonce,
        serverNonce: message.serverNonce,
        client,
        trace,
      }),
    );
    validateAuthProof(clientProof, 'client proof');
    if (this.handshake !== handshake) {
      throw new Error('인증 중 socket 상태가 변경되었습니다.');
    }
    this.handshake = {
      phase: 'await_hello_ack',
      clientNonce: handshake.clientNonce,
      serverNonce: message.serverNonce,
    };
    this.sendRaw({
      type: 'auth_response',
      protocolVersion: PERFETTO_BRIDGE_PROTOCOL_VERSION,
      clientNonce: handshake.clientNonce,
      serverNonce: message.serverNonce,
      audience: message.audience,
      clientProof,
      client,
      trace,
    });
  }

  private handleHelloAck(message: Extract<ServerMessage, {type: 'hello_ack'}>) {
    if (message.protocolVersion !== PERFETTO_BRIDGE_PROTOCOL_VERSION) {
      this.shouldReconnect = false;
      this.updateStatus('auth_failed', '브리지 protocol version 불일치');
      this.socket?.close(4002, 'protocol mismatch');
      return;
    }
    if (!message.accepted) {
      this.failAuthentication('브리지 상호 인증 거부');
      return;
    }
    if (this.handshake.phase !== 'await_hello_ack') {
      this.failAuthentication('브리지 인증 응답 순서 오류');
      return;
    }
    this.clearHandshakeTimer();
    this.authenticated = true;
    this.handshake = {phase: 'authenticated'};
    // Server-side durable assignment is authoritative. A reconnect receives a
    // fresh session.attach request only when the exact live trace is assigned.
    this.attachment = undefined;
    this.reconnectAttempt = 0;
    this.updateStatus('connected', undefined, message.connectionId);
  }

  private authAudience() {
    return {origin: this.options.origin, pluginId: this.options.pluginId};
  }

  private failAuthentication(detail: string): void {
    this.shouldReconnect = false;
    this.authenticated = false;
    this.handshake = {phase: 'idle'};
    this.clearHandshakeTimer();
    this.updateStatus('auth_failed', detail);
    this.socket?.close(4003, 'mutual authentication failed');
  }

  private async handleRequest(request: BridgeRequest): Promise<void> {
    if (!this.authenticated) {
      this.sendError(
        request.id,
        'NOT_AUTHENTICATED',
        '상호 인증이 필요합니다.',
      );
      return;
    }

    try {
      const result = await this.dispatch(request);
      this.sendResponse({
        type: 'response',
        id: request.id,
        ok: true,
        result: result as JsonValue,
      });
    } catch (error) {
      this.sendError(request.id, 'REQUEST_FAILED', errorMessage(error));
    }
  }

  private async dispatch(request: BridgeRequest): Promise<unknown> {
    switch (request.method) {
      case 'trace.getInfo':
        requireNoParams(request.params);
        return this.options.adapter.getTraceInfo();
      case 'selection.getArea':
        requireNoParams(request.params);
        return this.options.adapter.getAreaSelection();
      case 'trace.query': {
        const params = validateTraceQueryParams(request.params);
        return this.options.adapter.executeQuery(params.sql, params.maxRows);
      }
      case 'selection.selectMappedArea': {
        const params = validateMappedAreaParams(request.params);
        return this.options.adapter.selectMappedArea(params);
      }
      case 'session.attach': {
        const params = validateSessionAttachParams(request.params);
        this.attachment = params;
        this.sendEvent('session.attached', {
          sessionId: params.sessionId,
          role: params.role,
          traceId: this.options.adapter.getTraceInfo().traceId,
        });
        return {
          attached: true,
          sessionId: params.sessionId,
          role: params.role,
          traceId: this.options.adapter.getTraceInfo().traceId,
        };
      }
    }
  }

  private sendError(id: string, code: string, message: string): void {
    this.sendResponse({
      type: 'response',
      id,
      ok: false,
      error: {code, message},
    });
  }

  private sendResponse(response: BridgeResponse): void {
    this.sendRaw(response);
  }

  private sendEvent(name: BridgeEvent['name'], payload?: JsonValue): void {
    this.sendRaw({type: 'event', name, payload});
  }

  private sendRaw(message: object): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
      throw new Error('WebSocket이 연결되어 있지 않습니다.');
    }
    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer !== undefined) return;
    const baseDelay = Math.min(
      MAX_RECONNECT_MS,
      INITIAL_RECONNECT_MS * 2 ** this.reconnectAttempt,
    );
    const jitter = Math.floor(baseDelay * 0.2 * Math.random());
    this.reconnectAttempt += 1;
    this.updateStatus('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket(true);
    }, baseDelay + jitter);
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearHandshakeTimer();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      window.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private updateStatus(
    state: BridgeConnectionState,
    detail?: string,
    connectionId = this.status.connectionId,
  ): void {
    this.status = {
      state,
      detail,
      connectionId,
      reconnectAttempt: this.reconnectAttempt,
    };
    this.options.onStatus?.(this.status);
  }
}

function parseServerMessage(raw: unknown): ServerMessage {
  if (typeof raw !== 'string') {
    throw new Error('브리지는 text JSON frame만 보낼 수 있습니다.');
  }
  if (raw.length > MAX_INBOUND_MESSAGE_CHARS) {
    throw new Error('브리지 메시지가 허용 크기를 초과했습니다.');
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new Error('브리지 메시지 형식이 올바르지 않습니다.');
  }
  if (parsed.type === 'auth_challenge_ack') {
    if (
      !hasExactKeys(parsed, [
        'type',
        'protocolVersion',
        'clientNonce',
        'serverNonce',
        'audience',
        'serverProof',
      ]) ||
      parsed.protocolVersion !== PERFETTO_BRIDGE_PROTOCOL_VERSION ||
      !isRecord(parsed.audience) ||
      !hasExactKeys(parsed.audience, ['origin', 'pluginId']) ||
      typeof parsed.audience.origin !== 'string' ||
      typeof parsed.audience.pluginId !== 'string'
    ) {
      throw new Error('auth_challenge_ack 형식이 올바르지 않습니다.');
    }
    validateAuthNonce(parsed.clientNonce, 'client nonce');
    validateAuthNonce(parsed.serverNonce, 'server nonce');
    validateAuthProof(parsed.serverProof, 'server proof');
    return parsed as unknown as ServerMessage;
  }
  if (parsed.type === 'hello_ack') {
    if (
      typeof parsed.protocolVersion !== 'string' ||
      typeof parsed.accepted !== 'boolean'
    ) {
      throw new Error('hello_ack 형식이 올바르지 않습니다.');
    }
    return parsed as unknown as ServerMessage;
  }
  if (parsed.type === 'ping') {
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length > 256) {
      throw new Error('ping nonce 형식이 올바르지 않습니다.');
    }
    return parsed as unknown as ServerMessage;
  }
  if (parsed.type === 'request') {
    if (
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0 ||
      parsed.id.length > 256 ||
      !isBridgeMethod(parsed.method)
    ) {
      throw new Error('request 형식이 올바르지 않습니다.');
    }
    return parsed as unknown as ServerMessage;
  }
  throw new Error('지원하지 않는 브리지 메시지 type입니다.');
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validateExactHttpOrigin(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Perfetto page origin 형식이 올바르지 않습니다.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== value
  ) {
    throw new Error('Perfetto page origin은 exact HTTP(S) origin이어야 합니다.');
  }
}

function validateAuthNonce(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length !== PERFETTO_AUTH_NONCE_HEX_LENGTH ||
    !AUTH_NONCE_PATTERN.test(value)
  ) {
    throw new Error(`${name} 형식이 올바르지 않습니다.`);
  }
}

function validateAuthProof(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length !== PERFETTO_AUTH_PROOF_HEX_LENGTH ||
    !AUTH_PROOF_PATTERN.test(value)
  ) {
    throw new Error(`${name} 형식이 올바르지 않습니다.`);
  }
}

function authCrypto(): Crypto {
  const provider = globalThis.crypto;
  if (!provider?.subtle) {
    throw new Error('Web Crypto를 사용할 수 없어 안전하게 인증할 수 없습니다.');
  }
  return provider;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function hexToBuffer(value: string): ArrayBuffer {
  validateAuthProof(value, 'HMAC proof');
  const buffer = new ArrayBuffer(value.length / 2);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return buffer;
}

async function importAuthKey(token: string, usage: KeyUsage): Promise<CryptoKey> {
  return authCrypto().subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    [usage],
  );
}

export async function createPerfettoAuthProof(
  token: string,
  transcript: string,
): Promise<string> {
  validateToken(token);
  const signature = await authCrypto().subtle.sign(
    'HMAC',
    await importAuthKey(token, 'sign'),
    new TextEncoder().encode(transcript),
  );
  return bytesToHex(new Uint8Array(signature));
}

async function verifyPerfettoAuthProof(
  token: string,
  transcript: string,
  proof: string,
): Promise<boolean> {
  validateToken(token);
  validateAuthProof(proof, 'HMAC proof');
  return authCrypto().subtle.verify(
    'HMAC',
    await importAuthKey(token, 'verify'),
    hexToBuffer(proof),
    new TextEncoder().encode(transcript),
  );
}

const WEB_CRYPTO_AUTH: PerfettoAuthCrypto = {
  randomNonce(): string {
    const bytes = new Uint8Array(PERFETTO_AUTH_NONCE_HEX_LENGTH / 2);
    authCrypto().getRandomValues(bytes);
    return bytesToHex(bytes);
  },
  createProof: createPerfettoAuthProof,
  verifyProof: verifyPerfettoAuthProof,
};

function validateToken(value: string): void {
  if (typeof value !== 'string' || value.length < 24 || value.length > 4_096) {
    throw new Error('Perfetto connector token은 24자 이상이어야 합니다.');
  }
}

function validateTraceQueryParams(value: unknown): TraceQueryParams {
  if (!isRecord(value) || typeof value.sql !== 'string') {
    throw new Error('trace.query params 형식이 올바르지 않습니다.');
  }
  if (
    value.maxRows !== undefined &&
    (typeof value.maxRows !== 'number' || !Number.isInteger(value.maxRows))
  ) {
    throw new Error('maxRows는 정수여야 합니다.');
  }
  return {sql: value.sql, maxRows: value.maxRows as number | undefined};
}

function validateMappedAreaParams(value: unknown): SelectMappedAreaParams {
  if (
    !isRecord(value) ||
    typeof value.startNs !== 'string' ||
    typeof value.endNs !== 'string' ||
    !Array.isArray(value.trackUris) ||
    !value.trackUris.every((item) => typeof item === 'string') ||
    (value.focus !== undefined && typeof value.focus !== 'boolean')
  ) {
    throw new Error(
      'selection.selectMappedArea params 형식이 올바르지 않습니다.',
    );
  }
  return {
    startNs: value.startNs,
    endNs: value.endNs,
    trackUris: value.trackUris,
    focus: value.focus,
  };
}

function validateSessionAttachParams(value: unknown): SessionAttachParams {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length < 1 ||
    value.sessionId.length > 128 ||
    (value.role !== 'REF' && value.role !== 'DUT') ||
    (value.displayName !== undefined && typeof value.displayName !== 'string')
  ) {
    throw new Error('session.attach params 형식이 올바르지 않습니다.');
  }
  return {
    sessionId: value.sessionId,
    role: value.role,
    displayName: value.displayName,
  };
}

function requireNoParams(value: unknown): void {
  if (value === undefined || value === null) return;
  if (isRecord(value) && Object.keys(value).length === 0) return;
  throw new Error('이 method는 params를 받지 않습니다.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
