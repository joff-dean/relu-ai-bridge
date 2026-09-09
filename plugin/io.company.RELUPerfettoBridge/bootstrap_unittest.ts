// Copyright (c) 2026. All rights reserved.

import {
  PERFETTO_EXTENSION_MESSAGE_SOURCE,
  PERFETTO_EXTENSION_PROTOCOL_VERSION,
  PERFETTO_PLUGIN_MESSAGE_SOURCE,
  loadPerfettoBootstrap,
  type PerfettoExtensionMessageTarget,
} from './bootstrap';

const TOKEN = 'relu_perfetto_runtime_0123456789';
const LOCATION = {protocol: 'https:', origin: 'https://perfetto.company.example'};

class FakeMessageTarget implements PerfettoExtensionMessageTarget {
  readonly sent: Array<{message: unknown; targetOrigin: string}> = [];
  private listener?: (event: MessageEvent<unknown>) => void;

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  postMessage(message: unknown, targetOrigin: string): void {
    this.sent.push({message, targetOrigin});
  }

  respond(data: unknown): void {
    this.listener?.({source: this, data} as unknown as MessageEvent<unknown>);
  }
}

describe('loadPerfettoBootstrap', () => {
  test('배포 Extension에서 ephemeral credential을 받아 온다', async () => {
    const target = new FakeMessageTarget();
    const nonce = '0123456789abcdef0123456789abcdef';
    const loading = loadPerfettoBootstrap(LOCATION, target, () => nonce, 1000);
    expect(target.sent).toEqual([{
      targetOrigin: LOCATION.origin,
      message: {
        source: PERFETTO_PLUGIN_MESSAGE_SOURCE,
        version: PERFETTO_EXTENSION_PROTOCOL_VERSION,
        type: 'bootstrap.request',
        nonce,
      },
    }]);
    target.respond({
      source: PERFETTO_EXTENSION_MESSAGE_SOURCE,
      version: PERFETTO_EXTENSION_PROTOCOL_VERSION,
      type: 'bootstrap.response',
      nonce,
      ok: true,
      value: {endpoint: 'ws://127.0.0.1:5746/perfetto/extension-ws', token: TOKEN},
    });
    await expect(loading).resolves.toEqual({
      endpoint: 'ws://127.0.0.1:5746/perfetto/extension-ws',
      token: TOKEN,
    });
  });

  test.each([
    {protocol: 'file:', origin: 'null'},
    {protocol: 'chrome-extension:', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'},
    {protocol: 'https:', origin: 'https://user:pass@perfetto.company.example'},
  ])('HTTP(S) exact page origin이 아니면 요청 전에 거부한다', async (location) => {
    const target = new FakeMessageTarget();
    await expect(loadPerfettoBootstrap(location, target)).rejects.toThrow(/exact HTTP\(S\) origin/u);
    expect(target.sent).toHaveLength(0);
  });

  test('변경된 Extension bootstrap 계약을 거부하고 직접 연결하지 않는다', async () => {
    const target = new FakeMessageTarget();
    const nonce = '0123456789abcdef0123456789abcdef';
    const loading = loadPerfettoBootstrap(LOCATION, target, () => nonce, 1000);
    target.respond({
      source: PERFETTO_EXTENSION_MESSAGE_SOURCE,
      version: 1,
      type: 'bootstrap.response',
      nonce,
      ok: true,
      value: {endpoint: 'ws://evil.example/perfetto/ws', token: TOKEN},
    });
    await expect(loading).rejects.toThrow(/bootstrap 계약/u);
  });
});
