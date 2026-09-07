// Copyright (c) 2026. All rights reserved.

import {
  PERFETTO_BOOTSTRAP_PATH,
  loadPerfettoBootstrap,
} from './bootstrap';

const TOKEN = 'relu_perfetto_runtime_0123456789';
const LOCATION = {
  protocol: 'http:',
  hostname: '127.0.0.1',
  port: '10000',
  origin: 'http://127.0.0.1:10000',
};

describe('loadPerfettoBootstrap', () => {
  test('같은 exact loopback origin에서 credential을 메모리로 읽고 endpoint를 파생한다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({version: 1, token: TOKEN}), {
        status: 200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      }),
    );

    await expect(loadPerfettoBootstrap(LOCATION, fetchImpl)).resolves.toEqual({
      endpoint: 'ws://127.0.0.1:10000/perfetto/ws',
      token: TOKEN,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      PERFETTO_BOOTSTRAP_PATH,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      }),
    );
  });

  test.each([
    {...LOCATION, hostname: 'localhost', origin: 'http://localhost:10000'},
    {...LOCATION, hostname: '192.168.0.2', origin: 'http://192.168.0.2:10000'},
    {...LOCATION, protocol: 'https:', origin: 'https://127.0.0.1:10000'},
    {...LOCATION, port: '', origin: 'http://127.0.0.1'},
  ])('exact 127.0.0.1 HTTP origin이 아니면 요청 전에 거부한다', async (location) => {
    const fetchImpl = vi.fn();
    await expect(loadPerfettoBootstrap(location, fetchImpl)).rejects.toThrow(
      /exact 127\.0\.0\.1/u,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    {version: 1, token: 'short'},
    {version: 2, token: TOKEN},
    {version: 1, token: TOKEN, endpoint: 'ws://evil.example/perfetto/ws'},
    [1, TOKEN],
  ])('변경되거나 과도한 bootstrap 계약을 거부한다', async (body) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
    await expect(loadPerfettoBootstrap(LOCATION, fetchImpl)).rejects.toThrow(
      /bootstrap 계약/u,
    );
  });
});
