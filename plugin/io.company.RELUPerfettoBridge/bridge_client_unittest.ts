// Copyright (c) 2026. All rights reserved.

import type {PerfettoV57Adapter} from '../../perfetto_adapter/v57';
import {
  perfettoClientProofTranscript,
  perfettoServerProofTranscript,
} from '../../perfetto_adapter/protocol';
import {
  createPerfettoAuthProof,
  PerfettoBridgeClient,
  type PerfettoAuthCrypto,
} from './bridge_client';

const TOKEN = 'perfetto-token-0123456789';
const ORIGIN = 'http://127.0.0.1:10000';
const PLUGIN_ID = 'io.company.RELUPerfettoBridge';
const CLIENT_NONCE = '11'.repeat(32);
const SERVER_NONCE = '22'.repeat(32);
const SERVER_PROOF = '33'.repeat(32);
const CLIENT_PROOF = '44'.repeat(32);

const TEST_AUTH_CRYPTO: PerfettoAuthCrypto = {
  randomNonce: () => CLIENT_NONCE,
  createProof: async () => CLIENT_PROOF,
  verifyProof: async (_token, _transcript, proof) => proof === SERVER_PROOF,
};

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({code, reason} as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({
      data: JSON.stringify(message),
    } as MessageEvent<unknown>);
  }
}

describe('PerfettoBridgeClient', () => {
  test('server proof 전에는 token/trace를 보내지 않고 상호 인증 뒤 request에 응답한다', async () => {
    const socket = new FakeSocket();
    const adapter = createAdapter();
    const client = createClient(socket, adapter);

    client.connect();
    socket.open();
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'auth_challenge',
      protocolVersion: '1.0',
      clientNonce: CLIENT_NONCE,
      audience: {origin: ORIGIN, pluginId: PLUGIN_ID},
    });
    expect(socket.sent.join('\n')).not.toContain(TOKEN);
    expect(socket.sent.join('\n')).not.toContain('trace-1');

    await sendValidServerProof(socket);
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      type: 'auth_response',
      protocolVersion: '1.0',
      clientNonce: CLIENT_NONCE,
      serverNonce: SERVER_NONCE,
      clientProof: CLIENT_PROOF,
      audience: {origin: ORIGIN, pluginId: PLUGIN_ID},
      trace: {traceId: 'trace-1'},
    });
    expect(socket.sent.join('\n')).not.toContain(TOKEN);
    socket.receive({
      type: 'hello_ack',
      protocolVersion: '1.0',
      accepted: true,
      connectionId: 'connection-1',
    });
    socket.receive({
      type: 'request',
      id: 'request-7',
      method: 'selection.getArea',
      params: {},
    });
    await Promise.resolve();

    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: 'response',
      id: 'request-7',
      ok: true,
      result: {startNs: '1', endNs: '2', trackUris: []},
    });
  });

  test('인증 거부 시 auth_failed가 되고 reconnect하지 않는다', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new PerfettoBridgeClient({
      endpoint: 'ws://127.0.0.1:5746/perfetto/ws',
      token: TOKEN,
      origin: ORIGIN,
      clientId: 'client-1',
      pluginId: PLUGIN_ID,
      pluginVersion: '0.1.0',
      adapter: createAdapter(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      authCrypto: TEST_AUTH_CRYPTO,
    });

    client.connect();
    sockets[0].open();
    sockets[0].receive({
      type: 'hello_ack',
      protocolVersion: '1.0',
      accepted: false,
      error: 'invalid token',
    });
    vi.runAllTimers();

    expect(client.getStatus().state).toBe('auth_failed');
    expect(sockets).toHaveLength(1);
    vi.useRealTimers();
  });

  test('trace.query params를 adapter에 전달하고 같은 request id로 응답한다', async () => {
    const socket = new FakeSocket();
    const executeQuery = vi.fn().mockResolvedValue({
      columns: ['value'],
      rows: [{value: 7}],
      truncated: false,
      elapsedTimeMs: 1,
      statementCount: 1,
      statementWithOutputCount: 1,
    });
    const client = createClient(socket, createAdapter({executeQuery}));
    client.connect();
    socket.open();
    await sendValidServerProof(socket);
    socket.receive({
      type: 'hello_ack',
      protocolVersion: '1.0',
      accepted: true,
    });
    socket.receive({
      type: 'request',
      id: 'query-1',
      method: 'trace.query',
      params: {sql: 'select 7 as value', maxRows: 10},
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(executeQuery).toHaveBeenCalledWith('select 7 as value', 10);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'response',
      id: 'query-1',
      ok: true,
      result: {rows: [{value: 7}]},
    });
  });

  test('예기치 않은 close 뒤 exponential backoff로 새 socket을 연다', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const sockets: FakeSocket[] = [];
    const client = new PerfettoBridgeClient({
      endpoint: 'ws://127.0.0.1:5746/perfetto/ws',
      token: TOKEN,
      origin: ORIGIN,
      clientId: 'client-1',
      pluginId: PLUGIN_ID,
      pluginVersion: '0.1.0',
      adapter: createAdapter(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      authCrypto: TEST_AUTH_CRYPTO,
    });

    client.connect();
    sockets[0].open();
    await sendValidServerProof(sockets[0]);
    sockets[0].receive({
      type: 'hello_ack',
      protocolVersion: '1.0',
      accepted: true,
      connectionId: 'connection-1',
    });
    sockets[0].close(1011, 'bridge restart');

    expect(client.getStatus().state).toBe('reconnecting');
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);

    client.disconnect();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('잘못된 server proof는 trace 공개 없이 fail closed한다', async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    client.connect();
    socket.open();

    socket.receive({
      type: 'auth_challenge_ack',
      protocolVersion: '1.0',
      clientNonce: CLIENT_NONCE,
      serverNonce: SERVER_NONCE,
      audience: {origin: ORIGIN, pluginId: PLUGIN_ID},
      serverProof: 'ff'.repeat(32),
    });
    await settleAuthentication();

    expect(client.getStatus().state).toBe('auth_failed');
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent.join('\n')).not.toContain(TOKEN);
    expect(socket.sent.join('\n')).not.toContain('trace-1');
  });

  test('형식이 잘못된 인증 proof도 timeout을 기다리지 않고 거부한다', async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    client.connect();
    socket.open();
    socket.receive({
      type: 'auth_challenge_ack',
      protocolVersion: '1.0',
      clientNonce: CLIENT_NONCE,
      serverNonce: SERVER_NONCE,
      audience: {origin: ORIGIN, pluginId: PLUGIN_ID},
      serverProof: 'not-a-proof',
    });
    await settleAuthentication();

    expect(client.getStatus().state).toBe('auth_failed');
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent.join('\n')).not.toContain('trace-1');
  });

  test('server proof의 Origin/plugin audience 변경을 trace 공개 전에 거부한다', async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    client.connect();
    socket.open();
    socket.receive({
      type: 'auth_challenge_ack',
      protocolVersion: '1.0',
      clientNonce: CLIENT_NONCE,
      serverNonce: SERVER_NONCE,
      audience: {origin: 'http://127.0.0.1:10001', pluginId: PLUGIN_ID},
      serverProof: SERVER_PROOF,
    });
    await settleAuthentication();

    expect(client.getStatus().state).toBe('auth_failed');
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent.join('\n')).not.toContain('trace-1');
  });

  test('out-of-order hello_ack를 거부하고 자동 재연결하지 않는다', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new PerfettoBridgeClient({
      endpoint: 'ws://127.0.0.1:5746/perfetto/ws',
      token: TOKEN,
      origin: ORIGIN,
      clientId: 'client-1',
      pluginId: PLUGIN_ID,
      pluginVersion: '0.1.0',
      adapter: createAdapter(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      authCrypto: TEST_AUTH_CRYPTO,
    });
    client.connect();
    sockets[0].open();
    sockets[0].receive({
      type: 'hello_ack', protocolVersion: '1.0', accepted: true,
    });
    vi.runAllTimers();

    expect(client.getStatus().state).toBe('auth_failed');
    expect(sockets).toHaveLength(1);
    vi.useRealTimers();
  });

  test('상호 인증 timeout은 fail closed하며 재연결하지 않는다', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new PerfettoBridgeClient({
      endpoint: 'ws://127.0.0.1:5746/perfetto/ws',
      token: TOKEN,
      origin: ORIGIN,
      clientId: 'client-1',
      pluginId: PLUGIN_ID,
      pluginVersion: '0.1.0',
      adapter: createAdapter(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      authCrypto: TEST_AUTH_CRYPTO,
    });
    client.connect();
    sockets[0].open();
    vi.advanceTimersByTime(5_500);
    vi.runAllTimers();

    expect(client.getStatus().state).toBe('auth_failed');
    expect(sockets).toHaveLength(1);
    vi.useRealTimers();
  });

  test('Web Crypto HMAC은 Node broker canonical test vector와 일치한다', async () => {
    const trace = createAdapter().getTraceInfo();
    const client = {
      clientId: 'client-1', pluginId: PLUGIN_ID, pluginVersion: '0.1.0',
    };
    await expect(createPerfettoAuthProof(TOKEN, perfettoServerProofTranscript({
      origin: ORIGIN, pluginId: PLUGIN_ID,
      clientNonce: CLIENT_NONCE, serverNonce: SERVER_NONCE,
    }))).resolves.toBe('92b1aab30f0cf24ee326fda5ecd6e10e9aca9e4e54f5afe7938fdb9ad305ec7a');
    await expect(createPerfettoAuthProof(TOKEN, perfettoClientProofTranscript({
      origin: ORIGIN, pluginId: PLUGIN_ID,
      clientNonce: CLIENT_NONCE, serverNonce: SERVER_NONCE, client, trace,
    }))).resolves.toBe('c74e6d73d81d9d4de2550db7a3fbdfb04a4103638a892766b84723dc0ecd6fa2');
  });
});

async function sendValidServerProof(socket: FakeSocket): Promise<void> {
  socket.receive({
    type: 'auth_challenge_ack',
    protocolVersion: '1.0',
    clientNonce: CLIENT_NONCE,
    serverNonce: SERVER_NONCE,
    audience: {origin: ORIGIN, pluginId: PLUGIN_ID},
    serverProof: SERVER_PROOF,
  });
  await settleAuthentication();
}

async function settleAuthentication(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) await Promise.resolve();
}

function createClient(
  socket: FakeSocket,
  adapter = createAdapter(),
): PerfettoBridgeClient {
  return new PerfettoBridgeClient({
    endpoint: 'ws://127.0.0.1:5746/perfetto/ws',
    token: TOKEN,
    origin: ORIGIN,
    clientId: 'client-1',
    pluginId: PLUGIN_ID,
    pluginVersion: '0.1.0',
    adapter,
    socketFactory: () => socket,
    authCrypto: TEST_AUTH_CRYPTO,
  });
}

function createAdapter(
  overrides: Record<string, unknown> = {},
): PerfettoV57Adapter {
  return {
    getTraceInfo: () => ({
      traceId: 'trace-1',
      title: 'trace',
      sourceUrl: '',
      startNs: '0',
      endNs: '10',
      traceTypes: ['proto'],
      hasFtrace: true,
      importErrors: 0,
    }),
    getAreaSelection: () => ({
      startNs: '1',
      endNs: '2',
      trackUris: [],
    }),
    ...overrides,
  } as unknown as PerfettoV57Adapter;
}
