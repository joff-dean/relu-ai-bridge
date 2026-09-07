// Copyright (c) 2026. All rights reserved.

export const PERFETTO_BOOTSTRAP_PATH = '/relu/perfetto-bootstrap' as const;

const MIN_TOKEN_LENGTH = 24;
const MAX_TOKEN_LENGTH = 4096;
const MAX_BOOTSTRAP_RESPONSE_CHARS = 8192;

export interface PerfettoBootstrapConnection {
  readonly endpoint: string;
  readonly token: string;
}

/**
 * RELU local stack가 같은 origin에서 제공하는 일회성 runtime credential을 읽는다.
 * endpoint는 응답 값으로 받지 않고 현재 exact loopback origin에서만 파생한다.
 */
export async function loadPerfettoBootstrap(
  pageLocation: Pick<Location, 'protocol' | 'hostname' | 'port' | 'origin'> =
    globalThis.location,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PerfettoBootstrapConnection> {
  validateLocalStackOrigin(pageLocation);
  const response = await fetchImpl(PERFETTO_BOOTSTRAP_PATH, {
    method: 'POST',
    body: '{}',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {'content-type': 'application/json'},
  });
  if (!response.ok) {
    throw new Error('RELU local stack bootstrap을 사용할 수 없습니다.');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new Error('RELU local stack bootstrap 응답 형식이 올바르지 않습니다.');
  }
  const text = await response.text();
  if (text.length === 0 || text.length > MAX_BOOTSTRAP_RESPONSE_CHARS) {
    throw new Error('RELU local stack bootstrap 응답 크기가 올바르지 않습니다.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('RELU local stack bootstrap JSON이 올바르지 않습니다.');
  }
  if (!isExactBootstrapResponse(value)) {
    throw new Error('RELU local stack bootstrap 계약이 올바르지 않습니다.');
  }
  return {
    endpoint: `ws://${pageLocation.hostname}:${pageLocation.port}/perfetto/ws`,
    token: value.token,
  };
}

function validateLocalStackOrigin(
  pageLocation: Pick<Location, 'protocol' | 'hostname' | 'port' | 'origin'>,
): void {
  if (
    pageLocation.protocol !== 'http:' ||
    pageLocation.hostname !== '127.0.0.1' ||
    !/^[1-9][0-9]{0,4}$/u.test(pageLocation.port) ||
    Number(pageLocation.port) > 65535 ||
    pageLocation.origin !==
      `http://${pageLocation.hostname}:${pageLocation.port}`
  ) {
    throw new Error(
      'RELU local stack은 exact 127.0.0.1 HTTP origin에서만 사용할 수 있습니다.',
    );
  }
}

function isExactBootstrapResponse(
  value: unknown,
): value is {readonly version: 1; readonly token: string} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 2 &&
    keys[0] === 'token' &&
    keys[1] === 'version' &&
    record.version === 1 &&
    typeof record.token === 'string' &&
    record.token.length >= MIN_TOKEN_LENGTH &&
    record.token.length <= MAX_TOKEN_LENGTH
  );
}
