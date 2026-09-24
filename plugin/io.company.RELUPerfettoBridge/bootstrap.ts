// Copyright (c) 2026. All rights reserved.

export const PERFETTO_EXTENSION_PROTOCOL_VERSION = 1 as const;
export const PERFETTO_PLUGIN_MESSAGE_SOURCE = 'relu-perfetto-plugin' as const;
export const PERFETTO_EXTENSION_MESSAGE_SOURCE = 'relu-perfetto-extension' as const;

const MIN_TOKEN_LENGTH = 24;
const MAX_TOKEN_LENGTH = 4096;
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const LOOPBACK_ENDPOINT = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/perfetto\/extension-ws$/u;

export interface PerfettoBootstrapConnection {
  readonly endpoint: string;
  readonly token: string;
}

export interface PerfettoExtensionMessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * 회사 배포 Chrome Extension에 bootstrap을 요청한다. Extension은 Chrome이 자동 시작한
 * Native Host에서 받은 ephemeral connector credential만 page memory로 전달한다.
 */
export function loadPerfettoBootstrap(
  pageLocation: Pick<Location, 'protocol' | 'origin'> = globalThis.location,
  messageTarget: PerfettoExtensionMessageTarget = globalThis.window,
  randomNonce: () => string = () => crypto.randomUUID().replaceAll('-', ''),
  timeoutMs = BOOTSTRAP_TIMEOUT_MS,
): Promise<PerfettoBootstrapConnection> {
  validatePerfettoPageOrigin(pageLocation);
  const nonce = randomNonce();
  if (!/^[a-f0-9]{32}$/u.test(nonce)) {
    throw new Error('RELU Extension bootstrap nonce가 올바르지 않습니다.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error?: Error,
      value?: PerfettoBootstrapConnection,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      messageTarget.removeEventListener('message', onMessage);
      if (error) reject(error);
      else resolve(value!);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== messageTarget || !isRecord(event.data)) return;
      const message = event.data;
      if (
        message.source !== PERFETTO_EXTENSION_MESSAGE_SOURCE ||
        message.version !== PERFETTO_EXTENSION_PROTOCOL_VERSION ||
        message.type !== 'bootstrap.response' ||
        message.nonce !== nonce
      ) return;
      if (message.ok !== true) {
        finish(new Error('RELU Perfetto Connector를 시작할 수 없습니다.'));
        return;
      }
      if (!isBootstrapValue(message.value)) {
        finish(new Error('RELU Extension bootstrap 계약이 올바르지 않습니다.'));
        return;
      }
      finish(undefined, message.value);
    };
    const timer = setTimeout(
      () => finish(new Error('RELU Perfetto Connector 응답 시간이 초과되었습니다.')),
      timeoutMs,
    );
    messageTarget.addEventListener('message', onMessage);
    messageTarget.postMessage({
      source: PERFETTO_PLUGIN_MESSAGE_SOURCE,
      version: PERFETTO_EXTENSION_PROTOCOL_VERSION,
      type: 'bootstrap.request',
      nonce,
    }, pageLocation.origin);
  });
}

function validatePerfettoPageOrigin(
  pageLocation: Pick<Location, 'protocol' | 'origin'>,
): void {
  let origin: URL;
  try {
    origin = new URL(pageLocation.origin);
  } catch {
    throw new Error('Perfetto page origin이 올바르지 않습니다.');
  }
  if (
    !['http:', 'https:'].includes(pageLocation.protocol) ||
    origin.origin !== pageLocation.origin ||
    origin.protocol !== pageLocation.protocol ||
    origin.pathname !== '/' || origin.search !== '' || origin.hash !== '' ||
    origin.username !== '' || origin.password !== ''
  ) {
    throw new Error('Perfetto page는 exact HTTP(S) origin이어야 합니다.');
  }
}

function isBootstrapValue(value: unknown): value is PerfettoBootstrapConnection {
  if (!isRecord(value) || !hasExactKeys(value, ['endpoint', 'token'])) return false;
  if (
    typeof value.endpoint !== 'string' ||
    !LOOPBACK_ENDPOINT.test(value.endpoint) ||
    Number(new URL(value.endpoint).port) > 65_535
  ) return false;
  return typeof value.token === 'string' &&
    value.token.length >= MIN_TOKEN_LENGTH &&
    value.token.length <= MAX_TOKEN_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
