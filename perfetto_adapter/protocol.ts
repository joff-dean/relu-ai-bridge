// Copyright (c) 2026. All rights reserved.

/**
 * Perfetto UI plugin과 loopback bridge 사이의 JSON WebSocket 계약이다.
 *
 * 시간 값은 JavaScript number로 변환하면 나노초 정밀도가 손실될 수 있으므로
 * 항상 10진 문자열로 전송한다. 이 파일은 브리지 구현에서도 그대로 참조할 수
 * 있도록 Perfetto 내부 타입에 의존하지 않는다.
 */

export const PERFETTO_BRIDGE_PROTOCOL_VERSION = '1.0' as const;
export const PERFETTO_AUTH_NONCE_HEX_LENGTH = 64 as const;
export const PERFETTO_AUTH_PROOF_HEX_LENGTH = 64 as const;
export const PERFETTO_SERVER_PROOF_DOMAIN =
  'RELU-AI-BRIDGE-PERFETTO-SERVER-PROOF-V1' as const;
export const PERFETTO_CLIENT_PROOF_DOMAIN =
  'RELU-AI-BRIDGE-PERFETTO-CLIENT-PROOF-V1' as const;
export const DEFAULT_PERFETTO_BRIDGE_URL =
  'ws://127.0.0.1:5746/perfetto/ws' as const;
export const PERFETTO_BOUNDED_READ_MARKER =
  '/*relu-ai-bridge:perfetto-bounded-read-v1*/' as const;

export type TraceRole = 'REF' | 'DUT';

export interface TraceDescriptor {
  readonly traceId: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly startNs: string;
  readonly endNs: string;
  readonly traceTypes: ReadonlyArray<string>;
  readonly hasFtrace: boolean;
  readonly importErrors: number;
}

export interface AreaSelectionDto {
  readonly startNs: string;
  readonly endNs: string;
  readonly trackUris: ReadonlyArray<string>;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | {readonly [key: string]: JsonValue};

/** bigint와 blob을 손실 없이 JSON으로 표현하기 위한 tagged value. */
export type QueryCell =
  | JsonPrimitive
  | {readonly type: 'bigint'; readonly value: string}
  | {readonly type: 'blob'; readonly base64: string};

export interface QueryResponse {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Readonly<Record<string, QueryCell>>>;
  readonly truncated: boolean;
  readonly elapsedTimeMs: number;
  readonly statementCount: number;
  readonly statementWithOutputCount: number;
}

export type BridgeMethod =
  | 'trace.getInfo'
  | 'selection.getArea'
  | 'trace.query'
  | 'selection.selectMappedArea'
  | 'session.attach';

export interface PerfettoAuthAudience {
  readonly origin: string;
  readonly pluginId: string;
}

export interface PerfettoAuthClient {
  readonly clientId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
}

/** Secret이나 trace context를 포함하지 않는 첫 인증 프레임. */
export interface BridgeAuthChallenge {
  readonly type: 'auth_challenge';
  readonly protocolVersion: typeof PERFETTO_BRIDGE_PROTOCOL_VERSION;
  readonly clientNonce: string;
  readonly audience: PerfettoAuthAudience;
}

/** Server proof를 검증한 뒤에만 보내는 client 인증 및 trace 프레임. */
export interface BridgeAuthResponse {
  readonly type: 'auth_response';
  readonly protocolVersion: typeof PERFETTO_BRIDGE_PROTOCOL_VERSION;
  readonly clientNonce: string;
  readonly serverNonce: string;
  readonly audience: PerfettoAuthAudience;
  readonly clientProof: string;
  readonly client: PerfettoAuthClient;
  readonly trace: TraceDescriptor;
}

export interface BridgeResponse {
  readonly type: 'response';
  readonly id: string;
  readonly ok: boolean;
  readonly result?: JsonValue;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface BridgeEvent {
  readonly type: 'event';
  readonly name:
    | 'bridge.pong'
    | 'session.attach_requested'
    | 'session.attached'
    | 'trace.closing';
  readonly payload?: JsonValue;
}

export type ClientMessage =
  | BridgeAuthChallenge
  | BridgeAuthResponse
  | BridgeResponse
  | BridgeEvent;

export interface BridgeAuthChallengeAck {
  readonly type: 'auth_challenge_ack';
  readonly protocolVersion: typeof PERFETTO_BRIDGE_PROTOCOL_VERSION;
  readonly clientNonce: string;
  readonly serverNonce: string;
  readonly audience: PerfettoAuthAudience;
  readonly serverProof: string;
}

export interface BridgeHelloAck {
  readonly type: 'hello_ack';
  readonly protocolVersion: typeof PERFETTO_BRIDGE_PROTOCOL_VERSION;
  readonly accepted: boolean;
  readonly connectionId?: string;
  readonly heartbeatMs?: number;
  readonly error?: string;
}

export interface BridgeRequest {
  readonly type: 'request';
  readonly id: string;
  readonly method: BridgeMethod;
  readonly params?: JsonValue;
}

export interface BridgePing {
  readonly type: 'ping';
  readonly nonce: string;
}

export type ServerMessage =
  | BridgeAuthChallengeAck
  | BridgeHelloAck
  | BridgeRequest
  | BridgePing;

export interface SessionAttachParams {
  readonly sessionId: string;
  readonly role: TraceRole;
  readonly displayName?: string;
}

export interface TraceQueryParams {
  readonly sql: string;
  readonly maxRows?: number;
}

export interface SelectMappedAreaParams extends AreaSelectionDto {
  readonly focus?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return (
    value === 'trace.getInfo' ||
    value === 'selection.getArea' ||
    value === 'trace.query' ||
    value === 'selection.selectMappedArea' ||
    value === 'session.attach'
  );
}

/** Node broker와 browser plugin이 공유하는 canonical HMAC transcript. */
export function perfettoServerProofTranscript(input: {
  readonly origin: string;
  readonly pluginId: string;
  readonly clientNonce: string;
  readonly serverNonce: string;
}): string {
  return JSON.stringify([
    PERFETTO_SERVER_PROOF_DOMAIN,
    PERFETTO_BRIDGE_PROTOCOL_VERSION,
    input.origin,
    input.pluginId,
    input.clientNonce,
    input.serverNonce,
  ]);
}

/** Client proof가 인증 대상과 공개할 trace descriptor를 함께 고정한다. */
export function perfettoClientProofTranscript(input: {
  readonly origin: string;
  readonly pluginId: string;
  readonly clientNonce: string;
  readonly serverNonce: string;
  readonly client: PerfettoAuthClient;
  readonly trace: TraceDescriptor;
}): string {
  return JSON.stringify([
    PERFETTO_CLIENT_PROOF_DOMAIN,
    PERFETTO_BRIDGE_PROTOCOL_VERSION,
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
  ]);
}

/** endpoint를 외부 호스트로 바꿔 로컬 trace가 유출되는 일을 차단한다. */
export function validateLoopbackBridgeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('브리지 URL 형식이 올바르지 않습니다.');
  }
  if (url.protocol !== 'ws:') {
    throw new Error('브리지는 암호화되지 않은 로컬 ws: 연결만 지원합니다.');
  }
  if (url.hostname !== '127.0.0.1') {
    throw new Error('브리지 호스트는 127.0.0.1이어야 합니다.');
  }
  if (url.pathname !== '/perfetto/ws') {
    throw new Error('브리지 path는 /perfetto/ws이어야 합니다.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      '브리지 URL에 자격 증명, query 또는 fragment를 넣을 수 없습니다.',
    );
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('브리지 port 범위가 올바르지 않습니다.');
    }
  }
  return url;
}
