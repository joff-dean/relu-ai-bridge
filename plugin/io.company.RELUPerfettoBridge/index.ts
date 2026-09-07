// Copyright (c) 2026. All rights reserved.

import {z} from 'zod';
import m from 'mithril';
import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Setting} from '../../public/settings';
import type {Trace} from '../../public/trace';
import {type TraceRole} from '../../perfetto_adapter/protocol';
import type {AnalysisJob} from '../../perfetto_adapter/protocol';
import {PerfettoV58Adapter} from '../../perfetto_adapter/v58';
import {loadPerfettoBootstrap} from './bootstrap';
import {
  PerfettoBridgeClient,
  type BridgeConnectionStatus,
} from './bridge_client';
import {AnalysisPanel} from './analysis_panel';

const PLUGIN_ID = 'io.company.RELUPerfettoBridge';
const PLUGIN_VERSION = '0.7.0';
const COMMAND_SOURCE = 'RELU AI Bridge · Perfetto';

export default class ReluPerfettoBridgePlugin implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;
  static readonly description =
    'RELU AI Bridge를 통해 REF/DUT trace 분석과 화면 선택을 제공하는 Perfetto 플러그인';

  private static autoConnectSetting: Setting<boolean>;
  private static bridgeToken = '';
  private static bridgeEndpoint = '';

  private trace?: Trace;
  private adapter?: PerfettoV58Adapter;
  private bridge?: PerfettoBridgeClient;
  private traceInstanceClientId?: string;
  private status: BridgeConnectionStatus = {
    state: 'disconnected',
    reconnectAttempt: 0,
  };
  private readonly analysisJobs = new Map<string, AnalysisJob>();
  private analysisError?: string;

  static onActivate(app: App): void {
    ReluPerfettoBridgePlugin.autoConnectSetting = app.settings.register({
      id: `${PLUGIN_ID}#AutoConnect`,
      name: 'RELU AI Bridge 자동 연결',
      description:
        '동일 출처 RELU local stack에서 runtime credential을 받아 새 trace를 자동 연결합니다.',
      schema: z.boolean(),
      defaultValue: true,
    });
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    this.trace = trace;
    this.traceInstanceClientId = newClientId();
    this.adapter = new PerfettoV58Adapter(trace);
    this.registerCommands(trace);
    this.registerStatusItem(trace);
    this.registerAnalysisPanel(trace);

    trace.trash.defer(() => {
      this.bridge?.dispose();
      this.bridge = undefined;
      this.trace = undefined;
      this.adapter = undefined;
      this.traceInstanceClientId = undefined;
    });

    if (ReluPerfettoBridgePlugin.autoConnectSetting.get()) {
      try {
        await this.connect();
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
      callback: async () => this.connect(),
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}.OpenAnalysis`,
      name: 'RELU 분석 패널 열기',
      source: COMMAND_SOURCE,
      callback: () => trace.sidePanel.showTab(`${PLUGIN_ID}#Analysis`),
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

  private registerAnalysisPanel(trace: Trace): void {
    trace.sidePanel.registerTab({
      uri: `${PLUGIN_ID}#Analysis`,
      title: 'RELU 분석',
      icon: 'query_stats',
      render: () => m(AnalysisPanel, {
        connected: this.status.state === 'connected',
        available: this.bridge?.isAnalysisAvailable() === true,
        jobs: [...this.analysisJobs.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)),
        error: this.analysisError,
        onStart: () => this.startSelectionAnalysis(),
        onCancel: (jobId: string) => this.runPanelAction(() =>
          this.requireBridge().cancelAnalysis(jobId)),
        onCancelAll: () => this.runPanelAction(() =>
          this.requireBridge().cancelAllAnalyses()),
        onFocus: (jobId: string, findingIndex: number, evidenceIndex: number) =>
          this.runPanelAction(() => this.requireBridge().focusAnalysisEvidence(
            jobId,
            findingIndex,
            evidenceIndex,
          )),
      }),
    });
  }

  private startSelectionAnalysis(): void {
    this.runPanelAction(() => {
      const selection = this.adapter?.getAreaSelection();
      if (!selection) throw new Error('타임라인에서 분석할 영역을 먼저 선택하세요.');
      this.requireBridge().requestSelectionAnalysis(selection);
    });
  }

  private runPanelAction(action: () => void): void {
    try {
      this.analysisError = undefined;
      action();
    } catch (error) {
      this.analysisError = error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
    }
    this.trace?.raf.scheduleFullRedraw();
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
              void this.connect().catch((error) => {
                console.error('RELU AI Bridge 연결 실패', error);
              });
            }
          },
        };
      },
    });
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
      onStatus: (status) => {
        this.status = status;
        this.trace?.raf.scheduleFullRedraw();
      },
      onAnalysisJob: (job) => {
        this.analysisJobs.set(job.id, job);
        this.analysisError = undefined;
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
