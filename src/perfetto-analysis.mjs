import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {safeChildEnvironment} from './security.mjs';

const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const INTEGER = /^-?[0-9]+$/u;
const MAX_JOBS_PER_CLIENT = 20;
const MAX_TOTAL_JOBS = 100;
const MAX_CONCURRENT_ANALYSES = 2;
const MAX_TRACK_URIS = 1_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_STDIO_BYTES = 2 * 1024 * 1024;
const MAX_ANALYSIS_TIME_MS = 10 * 60_000;
const ACTIVE_STATES = new Set(['queued', 'running', 'cancel_requested']);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function boundedString(value, name, maximum, {allowEmpty = false} = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value) > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function normalizeSelection(value, trace) {
  if (!exactKeys(value, ['startNs', 'endNs', 'trackUris'])) {
    throw new Error('Analysis selection is invalid');
  }
  const startNs = boundedString(value.startNs, 'selection.startNs', 128);
  const endNs = boundedString(value.endNs, 'selection.endNs', 128);
  if (!INTEGER.test(startNs) || !INTEGER.test(endNs)) throw new Error('Analysis timestamps are invalid');
  const start = BigInt(startNs);
  const end = BigInt(endNs);
  if (start >= end || start < BigInt(trace.startNs) || end > BigInt(trace.endNs)) {
    throw new Error('Analysis selection is outside the trace');
  }
  if (!Array.isArray(value.trackUris) || value.trackUris.length > MAX_TRACK_URIS
    || value.trackUris.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 2_048)) {
    throw new Error('Analysis track URIs are invalid');
  }
  return {startNs, endNs, trackUris: [...value.trackUris]};
}

function normalizeEvidence(value, resolveTarget) {
  if (!exactKeys(value, ['label', 'target', 'startNs', 'endNs', 'trackUris'])) {
    throw new Error('Analysis evidence is invalid');
  }
  const target = boundedString(value.target, 'evidence.target', 16);
  if (!['current', 'ref', 'dut'].includes(target)) throw new Error('Analysis evidence target is invalid');
  const targetClient = resolveTarget(target);
  const selection = normalizeSelection({
    startNs: value.startNs,
    endNs: value.endNs,
    trackUris: value.trackUris,
  }, targetClient.trace);
  return {
    label: boundedString(value.label, 'evidence.label', 100),
    target,
    ...selection,
  };
}

function normalizeReport(value, resolveTarget) {
  if (!exactKeys(value, ['summary', 'findings', 'caveats'])
    || !Array.isArray(value.findings) || value.findings.length > 20
    || !Array.isArray(value.caveats) || value.caveats.length > 20) {
    throw new Error('Codex analysis report is invalid');
  }
  return {
    summary: boundedString(value.summary, 'report.summary', 8_000),
    findings: value.findings.map((finding) => {
      if (!exactKeys(finding, ['title', 'severity', 'explanation', 'evidence'])
        || !['info', 'warning', 'critical'].includes(finding.severity)
        || !Array.isArray(finding.evidence) || finding.evidence.length > 8) {
        throw new Error('Codex analysis finding is invalid');
      }
      return {
        title: boundedString(finding.title, 'finding.title', 200),
        severity: finding.severity,
        explanation: boundedString(finding.explanation, 'finding.explanation', 4_000),
        evidence: finding.evidence.map((item) => normalizeEvidence(item, resolveTarget)),
      };
    }),
    caveats: value.caveats.map((item) => boundedString(item, 'report.caveat', 1_000)),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    requestId: job.requestId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    selection: structuredClone(job.selection),
    progress: job.progress,
    report: job.report ? structuredClone(job.report) : null,
    error: job.error,
  };
}

function analysisPrompt(job) {
  const target = {
    clientId: job.clientId,
    sessionId: job.sessionId,
    role: job.role,
    startNs: job.selection.startNs,
    endNs: job.selection.endNs,
  };
  return [
    'Analyze one immutable Perfetto interval in the background.',
    'Use only the relu-perfetto MCP tools. Do not run shell commands, edit files, browse the web, or change any Perfetto selection.',
    `The exact target is this trusted server-generated JSON: ${JSON.stringify(target)}.`,
    'Never call perfetto_get_selection. Every SQL query must explicitly filter or clip results to the supplied startNs/endNs.',
    'Inspect CPU scheduling, long running/runnable threads, process concentration, memory pressure, UI/rendering signals, and trace import errors when available.',
    'If a REF/DUT session is supplied, compare only when the evidence supports a meaningful mapping; otherwise report the current trace and add a caveat.',
    'Return concise Korean text matching the required JSON schema. Evidence timestamps must identify a real subrange and target current, ref, or dut.',
  ].join('\n');
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function createCodexAnalysisRunner(options) {
  const required = ['codexCli', 'nodePath', 'proxyPath', 'schemaPath', 'cwd', 'outputDir'];
  for (const name of required) {
    if (typeof options?.[name] !== 'string' || !path.isAbsolute(options[name])) {
      throw new Error(`Perfetto Codex analysis ${name} must be an absolute path`);
    }
  }
  return async function runCodexAnalysis(job, {signal, onProgress}) {
    await fs.mkdir(options.cwd, {recursive: true, mode: 0o700});
    await fs.mkdir(options.outputDir, {recursive: true, mode: 0o700});
    const outputFile = path.join(options.outputDir, `${job.id}.json`);
    const args = [
      'exec', '--json', '--ephemeral', '--sandbox', 'read-only',
      '--ignore-user-config',
      '-c', `mcp_servers.relu-perfetto.command=${tomlString(options.nodePath)}`,
      '-c', `mcp_servers.relu-perfetto.args=[${tomlString(options.proxyPath)}]`,
      '-c', 'mcp_servers.relu-perfetto.startup_timeout_sec=15',
      '-c', 'mcp_servers.relu-perfetto.tool_timeout_sec=65',
      '--skip-git-repo-check', '-C', options.cwd,
      '--output-schema', options.schemaPath,
      '--output-last-message', outputFile,
      analysisPrompt(job),
    ];
    onProgress('Codex가 고정된 구간을 분석하고 있습니다.');
    const child = (options.spawnImpl ?? spawn)(options.codexCli, args, {
      cwd: options.cwd,
      env: safeChildEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let forceTimer;
    const terminate = () => {
      child.kill('SIGTERM');
      if (forceTimer) return;
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      forceTimer.unref?.();
    };
    const consume = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_STDIO_BYTES) {
        outputExceeded = true;
        terminate();
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    const abort = () => terminate();
    signal.addEventListener('abort', abort, {once: true});
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, MAX_ANALYSIS_TIME_MS);
    deadline.unref?.();
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, exitSignal) => resolve({exitCode, exitSignal}));
      });
      if (signal.aborted) throw Object.assign(new Error('Analysis cancelled'), {code: 'CANCELLED'});
      if (timedOut) throw new Error('Codex analysis timed out');
      if (outputExceeded) throw new Error('Codex analysis output exceeded the size limit');
      if (code.exitCode !== 0) throw new Error(`Codex analysis exited unexpectedly (${code.exitSignal ?? code.exitCode})`);
      const stat = await fs.stat(outputFile);
      if (stat.size > MAX_OUTPUT_BYTES) throw new Error('Codex analysis report exceeded the size limit');
      return JSON.parse(await fs.readFile(outputFile, 'utf8'));
    } finally {
      signal.removeEventListener('abort', abort);
      clearTimeout(deadline);
      clearTimeout(forceTimer);
      await fs.rm(outputFile, {force: true}).catch(() => {});
    }
  };
}

export class PerfettoAnalysisManager {
  constructor({runner = null, audit = null} = {}) {
    this.runner = runner;
    this.audit = audit;
    this.jobs = new Map();
    this.queues = new Map();
    this.active = new Map();
    this.bridge = null;
    this.focusHandler = null;
  }

  get enabled() {
    return typeof this.runner === 'function';
  }

  attach({bridge, focusHandler}) {
    this.bridge = bridge;
    this.focusHandler = focusHandler;
  }

  start(client, payload) {
    if (!this.enabled) throw new Error('Codex background analysis is not configured');
    if (!exactKeys(payload, ['requestId', 'selection']) || !REQUEST_ID.test(String(payload.requestId ?? ''))) {
      throw new Error('Analysis request is invalid');
    }
    const duplicate = [...this.jobs.values()].find((job) =>
      job.clientId === client.id && job.requestId === payload.requestId);
    if (duplicate) return publicJob(duplicate);
    const existing = [...this.jobs.values()].filter((job) => job.clientId === client.id);
    while (existing.length >= MAX_JOBS_PER_CLIENT) {
      const removable = existing.find((job) => !ACTIVE_STATES.has(job.status));
      if (!removable) throw new Error('Too many analysis jobs for this Perfetto tab');
      this.jobs.delete(removable.id);
      existing.splice(existing.indexOf(removable), 1);
    }
    while (this.jobs.size >= MAX_TOTAL_JOBS) {
      const removable = [...this.jobs.values()].find((job) => !ACTIVE_STATES.has(job.status));
      if (!removable) throw new Error('Too many analysis jobs are active');
      this.jobs.delete(removable.id);
    }
    const selection = normalizeSelection(payload.selection, client.trace);
    const now = new Date().toISOString();
    const job = {
      id: `analysis_${crypto.randomBytes(16).toString('hex')}`,
      requestId: payload.requestId,
      clientId: client.id,
      traceBinding: client.traceBinding,
      traceResourceBinding: client.traceResourceBinding,
      connection: client.connection,
      pluginVersion: client.plugin.version,
      sessionId: client.sessionId,
      role: client.role,
      selection,
      status: 'queued',
      progress: '분석 대기 중',
      report: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    const queue = this.queues.get(client.id) ?? [];
    queue.push(job.id);
    this.queues.set(client.id, queue);
    this.publish(job);
    void this.pump(client.id);
    return publicJob(job);
  }

  cancel(client, jobId) {
    const job = this.requireOwnedJob(client, jobId);
    if (!ACTIVE_STATES.has(job.status)) return publicJob(job);
    job.status = 'cancel_requested';
    job.progress = '중지 요청됨 · 실행 중인 SQL 결과는 폐기됩니다.';
    job.updatedAt = new Date().toISOString();
    job.controller.abort();
    this.publish(job);
    if (this.active.get(client.id) !== job.id) this.finishCancelled(job);
    return publicJob(job);
  }

  cancelAll(client) {
    for (const job of this.jobs.values()) {
      if (job.clientId === client.id && ACTIVE_STATES.has(job.status)) this.cancel(client, job.id);
    }
  }

  cancelClient(clientId, reason = 'Perfetto tab disconnected') {
    for (const job of this.jobs.values()) {
      if (job.clientId !== clientId || !ACTIVE_STATES.has(job.status)) continue;
      job.error = reason;
      job.controller.abort();
      this.finishCancelled(job);
    }
  }

  async focus(client, payload) {
    if (!exactKeys(payload, ['jobId', 'findingIndex', 'evidenceIndex', 'operationId'])
      || !REQUEST_ID.test(String(payload.operationId ?? ''))
      || !Number.isSafeInteger(payload.findingIndex) || payload.findingIndex < 0
      || !Number.isSafeInteger(payload.evidenceIndex) || payload.evidenceIndex < 0) {
      throw new Error('Analysis focus request is invalid');
    }
    const job = this.requireOwnedJob(client, payload.jobId);
    const evidence = job.report?.findings?.[payload.findingIndex]?.evidence?.[payload.evidenceIndex];
    if (!evidence) throw new Error('Analysis evidence is unavailable');
    if (typeof this.focusHandler !== 'function') throw new Error('Analysis focus handler is unavailable');
    await this.focusHandler(job, evidence, payload.operationId);
  }

  requireOwnedJob(client, jobId) {
    const job = this.jobs.get(String(jobId ?? ''));
    if (!job || job.clientId !== client.id || job.traceBinding !== client.traceBinding
      || job.connection !== client.connection) throw new Error('Analysis job is unavailable for this trace');
    return job;
  }

  resolveTarget(job, target) {
    if (!this.bridge) throw new Error('Analysis bridge is unavailable');
    if (target === 'current') return this.bridge.assertSnapshot({
      clientId: job.clientId,
      traceBinding: job.traceBinding,
      traceResourceBinding: job.traceResourceBinding,
      connection: job.connection,
      pluginVersion: job.pluginVersion,
      origin: this.bridge.getClient(job.clientId).origin ?? '',
      sessionId: null,
      role: null,
    });
    if (!job.sessionId) throw new Error('Analysis evidence references an unavailable REF/DUT session');
    return this.bridge.resolveSessionClient(job.sessionId, target);
  }

  async pump(clientId) {
    if (this.active.has(clientId) || this.active.size >= MAX_CONCURRENT_ANALYSES) return;
    const queue = this.queues.get(clientId) ?? [];
    const nextId = queue.shift();
    if (!nextId) return;
    const job = this.jobs.get(nextId);
    if (!job || job.status === 'cancelled') return void this.pump(clientId);
    this.active.set(clientId, job.id);
    job.status = 'running';
    job.progress = '고정된 선택 영역 분석 시작';
    job.updatedAt = new Date().toISOString();
    this.publish(job);
    try {
      const raw = await this.runner(job, {
        signal: job.controller.signal,
        onProgress: (progress) => {
          if (job.status !== 'running') return;
          job.progress = boundedString(progress, 'analysis progress', 500);
          job.updatedAt = new Date().toISOString();
          this.publish(job);
        },
      });
      if (job.controller.signal.aborted) return this.finishCancelled(job);
      job.report = normalizeReport(raw, (target) => this.resolveTarget(job, target));
      job.status = 'completed';
      job.progress = '분석 완료';
      job.updatedAt = new Date().toISOString();
      this.publish(job);
    } catch (error) {
      if (job.controller.signal.aborted || error?.code === 'CANCELLED') {
        this.finishCancelled(job);
      } else {
        job.status = 'failed';
        job.error = String(error?.message ?? 'Analysis failed').slice(0, 1_000);
        job.progress = '분석 실패';
        job.updatedAt = new Date().toISOString();
        this.publish(job);
      }
    } finally {
      this.active.delete(clientId);
      void this.audit?.append({
        category: 'perfetto', action: 'analysis.finish', clientId,
        jobId: job.id, status: job.status,
      }).catch(() => {});
      this.pumpAll();
    }
  }

  pumpAll() {
    for (const queuedClientId of this.queues.keys()) {
      if (this.active.size >= MAX_CONCURRENT_ANALYSES) break;
      void this.pump(queuedClientId);
    }
  }

  finishCancelled(job) {
    job.status = 'cancelled';
    job.progress = '분석 중지됨';
    job.updatedAt = new Date().toISOString();
    this.publish(job);
  }

  publish(job) {
    try {
      const client = this.bridge?.getClient(job.clientId);
      if (client?.connection === job.connection) {
        client.connection.sendJson({type: 'analysis_job', job: publicJob(job)});
      }
    } catch {}
  }

  shutdown() {
    for (const job of this.jobs.values()) {
      if (ACTIVE_STATES.has(job.status)) job.controller.abort();
    }
  }
}
