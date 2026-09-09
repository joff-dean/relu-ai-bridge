// Copyright (c) 2026. All rights reserved.

import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {PerfettoV58Adapter} from '../../perfetto_adapter/v58';
import {loadPerfettoBootstrap} from './bootstrap';
import {PerfettoExtensionSocket} from './extension_socket';
import {
  PerfettoBridgeClient,
  type BridgeConnectionStatus,
} from './bridge_client';

const PLUGIN_ID = 'io.company.RELUPerfettoBridge';
const PLUGIN_VERSION = '0.7.0';

export default class ReluPerfettoBridgePlugin implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;
  static readonly description =
    'RELU AI Bridge를 통해 REF/DUT trace 분석과 화면 선택을 제공하는 Perfetto 플러그인';

  private static bridgeToken = '';
  private static bridgeEndpoint = '';

  private trace?: Trace;
  private adapter?: PerfettoV58Adapter;
  private bridge?: PerfettoBridgeClient;
  private bootstrapRetryTimer?: number;
  private traceInstanceClientId?: string;
  private status: BridgeConnectionStatus = {
    state: 'disconnected',
    reconnectAttempt: 0,
  };

  async onTraceLoad(trace: Trace): Promise<void> {
    this.trace = trace;
    this.traceInstanceClientId = newClientId();
    this.adapter = new PerfettoV58Adapter(trace);
    this.registerStatusItem(trace);

    trace.trash.defer(() => {
      this.bridge?.dispose();
      if (this.bootstrapRetryTimer !== undefined) {
        window.clearTimeout(this.bootstrapRetryTimer);
      }
      this.bridge = undefined;
      this.trace = undefined;
      this.adapter = undefined;
      this.traceInstanceClientId = undefined;
    });

    void this.connectAutomatically();
  }

  private registerStatusItem(trace: Trace): void {
    trace.statusbar.registerItem({
      renderItem: () => {
        const attachment = this.bridge?.getSessionAttachment();
        const sessionLabel = attachment
          ? ` · ${attachment.sessionId}/${attachment.role}`
          : '';
        return {
          label: `RELU: ${statusLabel(this.status)}${sessionLabel}`,
          icon: this.status.state === 'connected' ? 'link' : 'link_off',
        };
      },
    });
  }

  private async connectAutomatically(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      console.error('RELU AI Bridge 자동 연결 실패', error);
      if (!this.trace || this.bootstrapRetryTimer !== undefined) return;
      this.bootstrapRetryTimer = window.setTimeout(() => {
        this.bootstrapRetryTimer = undefined;
        void this.connectAutomatically();
      }, 3000);
    }
  }

  private async connect(): Promise<void> {
    if (!this.trace) throw new Error('trace가 아직 준비되지 않았습니다.');
    if (
      ReluPerfettoBridgePlugin.bridgeToken === '' ||
      ReluPerfettoBridgePlugin.bridgeEndpoint === ''
    ) {
      const bootstrap = await loadPerfettoBootstrap();
      ReluPerfettoBridgePlugin.bridgeToken = bootstrap.token;
      ReluPerfettoBridgePlugin.bridgeEndpoint = bootstrap.endpoint;
    }
    this.bridge?.dispose();
    this.bridge = undefined;
    this.createBridge().connect();
  }

  private createBridge(): PerfettoBridgeClient {
    if (this.bridge) return this.bridge;
    if (!this.trace || !this.adapter) {
      throw new Error('trace가 아직 준비되지 않았습니다.');
    }
    this.bridge = new PerfettoBridgeClient({
      endpoint: ReluPerfettoBridgePlugin.bridgeEndpoint,
      token: ReluPerfettoBridgePlugin.bridgeToken,
      origin: globalThis.location.origin,
      clientId: this.traceInstanceClientId ??= newClientId(),
      pluginId: PLUGIN_ID,
      pluginVersion: PLUGIN_VERSION,
      adapter: this.adapter,
      socketFactory: (endpoint) => new PerfettoExtensionSocket(
        endpoint,
        globalThis.window,
        globalThis.location.origin,
        () => this.handleBootstrapInvalidated(),
      ),
      onStatus: (status) => {
        this.status = status;
        this.trace?.raf.scheduleFullRedraw();
      },
    });
    return this.bridge;
  }

  private handleBootstrapInvalidated(): void {
    ReluPerfettoBridgePlugin.bridgeToken = '';
    ReluPerfettoBridgePlugin.bridgeEndpoint = '';
    this.bridge?.dispose();
    this.bridge = undefined;
    if (!this.trace || this.bootstrapRetryTimer !== undefined) return;
    this.bootstrapRetryTimer = window.setTimeout(() => {
      this.bootstrapRetryTimer = undefined;
      void this.connectAutomatically();
    }, 250);
  }

}

function statusLabel(status: BridgeConnectionStatus): string {
  switch (status.state) {
    case 'connected':
      return '연결됨';
    case 'connecting':
      return '연결 중';
    case 'authenticating':
      return '인증 중';
    case 'reconnecting':
      return `재연결 중(${status.reconnectAttempt})`;
    case 'auth_failed':
      return '인증 실패';
    case 'disconnected':
      return '연결 안 됨';
  }
}

function newClientId(): string {
  // Perfetto trace UUID is caller-controlled metadata, not a content digest.
  // Keep identity only for this live trace instance so a reopened trace cannot
  // inherit an old assignment or persistent grant by reusing a UUID.
  return `perfetto_${crypto.randomUUID().replaceAll('-', '_')}`;
}
