// Copyright (c) 2026. All rights reserved.

import {z} from 'zod';
import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Setting} from '../../public/settings';
import type {Trace} from '../../public/trace';
import {
  DEFAULT_PERFETTO_BRIDGE_URL,
  type TraceRole,
} from '../../perfetto_adapter/protocol';
import {PerfettoV57Adapter} from '../../perfetto_adapter/v57';
import {
  PerfettoBridgeClient,
  type BridgeConnectionStatus,
} from './bridge_client';

const PLUGIN_ID = 'io.company.RELUPerfettoBridge';
const PLUGIN_VERSION = '0.5.0';
const COMMAND_SOURCE = 'RELU AI Bridge · Perfetto';

export default class ReluPerfettoBridgePlugin implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;
  static readonly description =
    'RELU AI Bridge를 통해 REF/DUT trace 분석과 화면 선택을 제공하는 Perfetto 플러그인';

  private static bridgeUrlSetting: Setting<string>;
  private static autoConnectSetting: Setting<boolean>;
  private static bridgeToken = '';

  private trace?: Trace;
  private adapter?: PerfettoV57Adapter;
  private bridge?: PerfettoBridgeClient;
  private traceInstanceClientId?: string;
  private status: BridgeConnectionStatus = {
    state: 'disconnected',
    reconnectAttempt: 0,
  };

  static onActivate(app: App): void {
    ReluPerfettoBridgePlugin.bridgeUrlSetting = app.settings.register({
      id: `${PLUGIN_ID}#BridgeUrl`,
      name: 'RELU AI Bridge URL',
      description:
        '로컬 bridge WebSocket 주소입니다. 보안을 위해 127.0.0.1의 /perfetto/ws만 허용합니다.',
      schema: z.string(),
      defaultValue: DEFAULT_PERFETTO_BRIDGE_URL,
    });
    ReluPerfettoBridgePlugin.autoConnectSetting = app.settings.register({
      id: `${PLUGIN_ID}#AutoConnect`,
      name: 'RELU AI Bridge 자동 연결',
      description:
        '현재 Perfetto 페이지 메모리에 token이 있으면 새 trace를 열 때 자동 연결합니다.',
      schema: z.boolean(),
      defaultValue: true,
    });
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    this.trace = trace;
    this.traceInstanceClientId = newClientId();
    this.adapter = new PerfettoV57Adapter(trace);
    this.registerCommands(trace);
    this.registerStatusItem(trace);

    trace.trash.defer(() => {
      this.bridge?.dispose();
      this.bridge = undefined;
      this.trace = undefined;
      this.adapter = undefined;
      this.traceInstanceClientId = undefined;
    });

    if (
      ReluPerfettoBridgePlugin.autoConnectSetting.get() &&
      ReluPerfettoBridgePlugin.bridgeToken !== ''
    ) {
      try {
        this.createBridge().connect();
      } catch (error) {
        console.error('RELU AI Bridge 자동 연결 실패', error);
      }
    }
  }

  private registerCommands(trace: Trace): void {
    trace.commands.registerCommand({
      id: `${PLUGIN_ID}.Connect`,
      name: 'RELU AI Bridge 연결',
      source: COMMAND_SOURCE,
      callback: async () => this.connectWithPrompt(true),
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}.Disconnect`,
      name: 'RELU AI Bridge 연결 해제',
      source: COMMAND_SOURCE,
      callback: () => this.bridge?.disconnect(),
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}.AttachSession`,
      name: '현재 trace를 REF/DUT 세션에 연결',
      source: COMMAND_SOURCE,
      callback: async () => {
        const sessionId = await trace.omnibox.prompt(
          '연결할 RELU AI Bridge session ID',
        );
        if (sessionId === undefined || sessionId.trim() === '') return;
        const role = await trace.omnibox.prompt('이 trace의 역할', [
          'REF',
          'DUT',
        ]);
        if (role !== 'REF' && role !== 'DUT') return;
        this.requireBridge().requestSessionAttach(
          sessionId.trim(),
          role as TraceRole,
          trace.traceInfo.traceTitle,
        );
      },
    });
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
          onclick: () => {
            if (this.status.state === 'connected') {
              this.bridge?.disconnect();
            } else {
              void this.connectWithPrompt(false).catch((error) => {
                console.error('RELU AI Bridge 연결 실패', error);
              });
            }
          },
        };
      },
    });
  }

  private async connectWithPrompt(forcePrompt: boolean): Promise<void> {
    if (!this.trace) throw new Error('trace가 아직 준비되지 않았습니다.');
    let token = ReluPerfettoBridgePlugin.bridgeToken;
    if (forcePrompt || token === '') {
      const entered = await this.trace.omnibox.prompt(
        'Perfetto connector 전용 token을 입력하세요 (페이지 메모리에만 유지)',
      );
      if (entered === undefined || entered.trim() === '') return;
      token = entered.trim();
      ReluPerfettoBridgePlugin.bridgeToken = token;
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
      endpoint: ReluPerfettoBridgePlugin.bridgeUrlSetting.get(),
      token: ReluPerfettoBridgePlugin.bridgeToken,
      origin: globalThis.location.origin,
      clientId: this.traceInstanceClientId ??= newClientId(),
      pluginId: PLUGIN_ID,
      pluginVersion: PLUGIN_VERSION,
      adapter: this.adapter,
      onStatus: (status) => {
        this.status = status;
        this.trace?.raf.scheduleFullRedraw();
      },
    });
    return this.bridge;
  }

  private requireBridge(): PerfettoBridgeClient {
    const bridge = this.bridge;
    if (!bridge || bridge.getStatus().state !== 'connected') {
      throw new Error('RELU AI Bridge에 먼저 연결하세요.');
    }
    return bridge;
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
