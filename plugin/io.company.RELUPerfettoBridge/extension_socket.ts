// Copyright (c) 2026. All rights reserved.

import {validateLoopbackBridgeUrl} from '../../perfetto_adapter/protocol';
import {
  PERFETTO_EXTENSION_MESSAGE_SOURCE,
  PERFETTO_EXTENSION_PROTOCOL_VERSION,
  PERFETTO_PLUGIN_MESSAGE_SOURCE,
  type PerfettoExtensionMessageTarget,
} from './bootstrap';
import type {BridgeSocket} from './bridge_client';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MAX_MESSAGE_CHARS = 1_048_576;

export class PerfettoExtensionSocket implements BridgeSocket {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private readonly socketId = `socket_${crypto.randomUUID().replaceAll('-', '_')}`;
  private closed = false;
  private readonly listener = (event: MessageEvent<unknown>) => this.handleMessage(event);

  constructor(
    endpoint: string,
    private readonly messageTarget: PerfettoExtensionMessageTarget = globalThis.window,
    private readonly targetOrigin: string = globalThis.location.origin,
    private readonly onBootstrapInvalidated?: () => void,
  ) {
    const validated = validateLoopbackBridgeUrl(endpoint).toString();
    this.messageTarget.addEventListener('message', this.listener);
    this.post({type: 'socket.open', endpoint: validated});
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('RELU Extension socket이 열려 있지 않습니다.');
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS) {
      throw new Error('RELU Extension socket message가 너무 큽니다.');
    }
    this.post({type: 'socket.send', data});
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.readyState = CLOSING;
    this.post({type: 'socket.close', code, reason: String(reason).slice(0, 123)});
  }

  private post(payload: Record<string, unknown>): void {
    this.messageTarget.postMessage({
      source: PERFETTO_PLUGIN_MESSAGE_SOURCE,
      version: PERFETTO_EXTENSION_PROTOCOL_VERSION,
      socketId: this.socketId,
      ...payload,
    }, this.targetOrigin);
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    if (event.source !== this.messageTarget || !isRecord(event.data)) return;
    const message = event.data;
    if (
      message.source === PERFETTO_EXTENSION_MESSAGE_SOURCE &&
      message.version === PERFETTO_EXTENSION_PROTOCOL_VERSION &&
      message.type === 'bootstrap.invalidated'
    ) {
      this.onBootstrapInvalidated?.();
      this.finishClose(1012, 'Native Host restarted');
      return;
    }
    if (
      message.source !== PERFETTO_EXTENSION_MESSAGE_SOURCE ||
      message.version !== PERFETTO_EXTENSION_PROTOCOL_VERSION ||
      message.socketId !== this.socketId ||
      typeof message.type !== 'string'
    ) return;
    if (message.type === 'socket.opened') {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.();
      return;
    }
    if (message.type === 'socket.message') {
      if (this.readyState !== OPEN || typeof message.data !== 'string' || message.data.length > MAX_MESSAGE_CHARS) {
        this.onerror?.();
        return;
      }
      this.onmessage?.({data: message.data} as MessageEvent<unknown>);
      return;
    }
    if (message.type === 'socket.error') {
      this.onerror?.();
      return;
    }
    if (message.type === 'socket.closed') {
      this.finishClose(
        Number.isSafeInteger(message.code) ? Number(message.code) : 1006,
        typeof message.reason === 'string' ? message.reason.slice(0, 123) : '',
      );
    }
  }

  private finishClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = CLOSED;
    this.messageTarget.removeEventListener('message', this.listener);
    this.onclose?.({code, reason} as CloseEvent);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
