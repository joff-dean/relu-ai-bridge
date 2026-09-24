// Copyright (c) 2026. All rights reserved.

import type {PerfettoExtensionMessageTarget} from './bootstrap';
import {PerfettoExtensionSocket} from './extension_socket';

class FakeMessageTarget implements PerfettoExtensionMessageTarget {
  readonly sent: unknown[] = [];
  private listener?: (event: MessageEvent<unknown>) => void;

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  respond(data: unknown): void {
    this.listener?.({source: this, data} as unknown as MessageEvent<unknown>);
  }
}

describe('PerfettoExtensionSocket', () => {
  test('page socket을 Extension message channel로만 중계한다', () => {
    const target = new FakeMessageTarget();
    const socket = new PerfettoExtensionSocket(
      'ws://127.0.0.1:5746/perfetto/extension-ws',
      target,
      'https://perfetto.company.example',
    );
    const opened = vi.fn();
    const received = vi.fn();
    const closed = vi.fn();
    socket.onopen = opened;
    socket.onmessage = received;
    socket.onclose = closed;

    const open = target.sent[0] as Record<string, unknown>;
    expect(open).toMatchObject({
      source: 'relu-perfetto-plugin',
      version: 1,
      type: 'socket.open',
      endpoint: 'ws://127.0.0.1:5746/perfetto/extension-ws',
    });
    target.respond({source: 'relu-perfetto-extension', version: 1, type: 'socket.opened', socketId: open.socketId});
    expect(opened).toHaveBeenCalledOnce();

    socket.send('{"type":"auth_challenge"}');
    expect(target.sent[1]).toMatchObject({type: 'socket.send', socketId: open.socketId});
    target.respond({source: 'relu-perfetto-extension', version: 1, type: 'socket.message', socketId: open.socketId, data: '{}'});
    expect(received.mock.calls[0][0].data).toBe('{}');

    socket.close(1000, 'done');
    expect(target.sent[2]).toMatchObject({type: 'socket.close', socketId: open.socketId, code: 1000});
    target.respond({source: 'relu-perfetto-extension', version: 1, type: 'socket.closed', socketId: open.socketId, code: 1000, reason: 'done'});
    expect(closed.mock.calls[0][0]).toMatchObject({code: 1000, reason: 'done'});
  });
});
