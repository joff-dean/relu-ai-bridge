// Copyright (c) 2026. All rights reserved.

import {
  DEFAULT_PERFETTO_BRIDGE_URL,
  validateLoopbackBridgeUrl,
} from './protocol';

describe('validateLoopbackBridgeUrl', () => {
  test('기본 loopback endpoint를 허용한다', () => {
    expect(
      validateLoopbackBridgeUrl(DEFAULT_PERFETTO_BRIDGE_URL).hostname,
    ).toBe('127.0.0.1');
  });

  test.each([
    'ws://localhost:5746/perfetto/ws',
    'ws://192.168.0.10:5746/perfetto/ws',
    'wss://127.0.0.1:5746/perfetto/ws',
    'ws://127.0.0.1:5746/other',
    'ws://token@127.0.0.1:5746/perfetto/ws',
    'ws://127.0.0.1:5746/perfetto/ws?token=secret',
  ])('외부 연결 또는 URL 내 자격 증명을 거부한다: %s', (url) => {
    expect(() => validateLoopbackBridgeUrl(url)).toThrow();
  });
});
