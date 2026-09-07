// Copyright (c) 2026. All rights reserved.

import m from 'mithril';
import type {AnalysisJob} from '../../perfetto_adapter/protocol';
import {Button, ButtonVariant} from '../../widgets/button';
import {Intent} from '../../widgets/common';
import './analysis_panel.scss';

export interface AnalysisPanelAttrs {
  readonly connected: boolean;
  readonly available: boolean;
  readonly jobs: ReadonlyArray<AnalysisJob>;
  readonly error?: string;
  readonly onStart: () => void;
  readonly onCancel: (jobId: string) => void;
  readonly onCancelAll: () => void;
  readonly onFocus: (
    jobId: string,
    findingIndex: number,
    evidenceIndex: number,
  ) => void;
}

const ACTIVE = new Set(['queued', 'running', 'cancel_requested']);

export class AnalysisPanel implements m.ClassComponent<AnalysisPanelAttrs> {
  view({attrs}: m.CVnode<AnalysisPanelAttrs>): m.Children {
    const activeCount = attrs.jobs.filter((job) => ACTIVE.has(job.status)).length;
    return m(
      '.relu-analysis',
      m(
        '.relu-analysis__header',
        m('.relu-analysis__heading', m('h2', 'RELU 구간 분석'), m(
          'span.relu-analysis__connection',
          attrs.connected ? 'Bridge 연결됨' : 'Bridge 연결 필요',
        )),
        m(
          '.relu-analysis__actions',
          m(Button, {
            label: '현재 선택 분석',
            icon: 'analytics',
            variant: ButtonVariant.Filled,
            intent: Intent.Primary,
            disabled: !attrs.connected || !attrs.available,
            onclick: attrs.onStart,
          }),
          activeCount > 0 && m(Button, {
            label: '모두 중지',
            icon: 'stop_circle',
            intent: Intent.Danger,
            onclick: attrs.onCancelAll,
          }),
        ),
        !attrs.available && m(
          '.relu-analysis__notice',
          '로컬 스택을 --codex-cli 옵션으로 실행하면 백그라운드 분석을 사용할 수 있습니다.',
        ),
        attrs.error && m('.relu-analysis__error', attrs.error),
      ),
      m(
        '.relu-analysis__body',
        attrs.jobs.length === 0
          ? m(
              '.relu-analysis__empty',
              m('span.material-icons', 'query_stats'),
              m('p', '타임라인에서 구간을 선택한 뒤 분석을 시작하세요.'),
              m('p', '시작 후에는 화면을 자유롭게 이동하거나 다른 구간을 선택할 수 있습니다.'),
            )
          : attrs.jobs.map((job) => this.renderJob(attrs, job)),
      ),
    );
  }

  private renderJob(attrs: AnalysisPanelAttrs, job: AnalysisJob): m.Children {
    const active = ACTIVE.has(job.status);
    const durationMs = Number(BigInt(job.selection.endNs) - BigInt(job.selection.startNs)) / 1_000_000;
    return m(
      '.relu-analysis__job',
      m(
        '.relu-analysis__job-title',
        m('strong', statusLabel(job.status)),
        m('span', `${durationMs.toFixed(3)} ms`),
      ),
      m('.relu-analysis__progress', job.progress),
      active && m(Button, {
        label: job.status === 'cancel_requested' ? '중지 처리 중' : '분석 중지',
        icon: 'stop_circle',
        intent: Intent.Danger,
        disabled: job.status === 'cancel_requested',
        onclick: () => attrs.onCancel(job.id),
      }),
      job.error && m('.relu-analysis__error', job.error),
      job.report && m(
        '.relu-analysis__report',
        m('p.relu-analysis__summary', job.report.summary),
        job.report.findings.map((finding, findingIndex) => m(
          '.relu-analysis__finding',
          {className: `relu-analysis__finding--${finding.severity}`},
          m('h3', finding.title),
          m('p', finding.explanation),
          m(
            '.relu-analysis__evidence',
            finding.evidence.map((evidence, evidenceIndex) => m(Button, {
              label: `${targetLabel(evidence.target)} · ${evidence.label}`,
              icon: 'zoom_in',
              variant: ButtonVariant.Outlined,
              onclick: () => attrs.onFocus(job.id, findingIndex, evidenceIndex),
            })),
          ),
        )),
        job.report.caveats.length > 0 && m(
          '.relu-analysis__caveats',
          m('strong', '주의 사항'),
          m('ul', job.report.caveats.map((item) => m('li', item))),
        ),
      ),
    );
  }
}

function statusLabel(status: AnalysisJob['status']): string {
  switch (status) {
    case 'queued': return '대기 중';
    case 'running': return '분석 중';
    case 'cancel_requested': return '중지 요청됨';
    case 'cancelled': return '중지됨';
    case 'completed': return '완료';
    case 'failed': return '실패';
  }
}

function targetLabel(target: 'current' | 'ref' | 'dut'): string {
  if (target === 'ref') return 'REF 보기';
  if (target === 'dut') return 'DUT 보기';
  return '이 구간 보기';
}
