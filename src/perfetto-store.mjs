import path from 'node:path';
import { AsyncMutex, randomId, readJson, writeJsonAtomic } from './utils.mjs';

const ID = /^[a-zA-Z0-9_-]{3,128}$/;
const TRACE_BINDING = /^[a-f0-9]{32}$/;
const ROLES = new Set(['ref', 'dut']);
const INSTANCE_ID = /^session_[a-f0-9]{32}$/u;

function assertId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function findSession(state, sessionId) {
  assertId(sessionId, 'sessionId');
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`Perfetto session not found: ${sessionId}`);
  return session;
}

function publicSession(session) {
  const { alignmentHistory: _alignmentHistory, ...value } = session;
  return structuredClone(value);
}

export class PerfettoSessionStore {
  constructor(config) {
    this.file = path.join(config.dataDir, 'perfetto-sessions.json');
    this.maxSessions = config.perfetto.maxSessions;
    this.state = { version: 2, sessions: [] };
    this.mutex = new AsyncMutex();
  }

  async initialize() {
    return this.mutex.runExclusive(async () => {
      let draft = await readJson(this.file, this.state);
      if (draft.version === 1 && Array.isArray(draft.sessions)) {
        draft = {
        version: 2,
        sessions: draft.sessions.map((session) => ({
          ...session,
          refTraceBinding: null,
          dutTraceBinding: null,
        })),
        };
      }
      if (draft.version !== 2 || !Array.isArray(draft.sessions)) {
        throw new Error('Unsupported perfetto session store format');
      }
      for (const session of draft.sessions) {
        if (!INSTANCE_ID.test(session.instanceId ?? '')) session.instanceId = randomId('session_');
      }
      await this.commit(draft);
    });
  }

  async commit(draft) {
    await writeJsonAtomic(this.file, draft);
    this.state = draft;
  }

  list() {
    return this.state.sessions.map(publicSession);
  }

  get(sessionId) {
    return structuredClone(findSession(this.state, sessionId));
  }

  async create(input = {}) {
    return this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      const now = new Date().toISOString();
      const session = {
        id: input.id ? assertId(input.id, 'session id') : randomId('trace_'),
        instanceId: randomId('session_'),
        name: String(input.name ?? 'REF/DUT session').trim().slice(0, 200) || 'REF/DUT session',
        refClientId: null,
        dutClientId: null,
        refTraceBinding: null,
        dutTraceBinding: null,
        createdAt: now,
        updatedAt: now,
        alignmentHistory: [],
      };
      if (draft.sessions.length >= this.maxSessions) throw new Error(`Perfetto session limit reached (${this.maxSessions})`);
      if (draft.sessions.some((item) => item.id === session.id)) throw new Error(`Session already exists: ${session.id}`);
      draft.sessions.push(session);
      await this.commit(draft);
      return publicSession(session);
    });
  }

  async attach(sessionId, role, clientId, traceBinding, expectedInstanceId = null) {
    if (!ROLES.has(role)) throw new Error('role must be ref or dut');
    assertId(clientId, 'clientId');
    if (typeof traceBinding !== 'string' || !TRACE_BINDING.test(traceBinding)) {
      throw new Error('traceBinding is invalid');
    }
    return this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      const session = findSession(draft, sessionId);
      if (expectedInstanceId !== null && session.instanceId !== expectedInstanceId) {
        throw new Error('Perfetto session changed after approval; retry against the current session');
      }
      const now = new Date().toISOString();
      for (const item of draft.sessions) {
        for (const candidateRole of ROLES) {
          const idKey = candidateRole === 'ref' ? 'refClientId' : 'dutClientId';
          const bindingKey = candidateRole === 'ref' ? 'refTraceBinding' : 'dutTraceBinding';
          if (item[idKey] === clientId) {
            item[idKey] = null;
            item[bindingKey] = null;
            item.updatedAt = now;
          }
        }
      }
      session[role === 'ref' ? 'refClientId' : 'dutClientId'] = clientId;
      session[role === 'ref' ? 'refTraceBinding' : 'dutTraceBinding'] = traceBinding;
      session.updatedAt = now;
      await this.commit(draft);
      return publicSession(session);
    });
  }

  async detach(sessionId, role, expected = null) {
    if (!ROLES.has(role)) throw new Error('role must be ref or dut');
    return this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      const session = findSession(draft, sessionId);
      const clientKey = role === 'ref' ? 'refClientId' : 'dutClientId';
      const bindingKey = role === 'ref' ? 'refTraceBinding' : 'dutTraceBinding';
      if (expected && (
        (expected.instanceId !== null && expected.instanceId !== undefined
          && session.instanceId !== expected.instanceId)
        || session[clientKey] !== expected.clientId
        || session[bindingKey] !== expected.traceBinding
      )) {
        throw new Error('Perfetto target changed after approval; retry against the current trace');
      }
      session[clientKey] = null;
      session[bindingKey] = null;
      session.updatedAt = new Date().toISOString();
      await this.commit(draft);
      return publicSession(session);
    });
  }

  async remove(sessionId, expectedInstanceId = null) {
    return this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      const session = findSession(draft, sessionId);
      if (expectedInstanceId !== null && session.instanceId !== expectedInstanceId) {
        throw new Error('Perfetto session changed after approval; retry against the current session');
      }
      draft.sessions = draft.sessions.filter((item) => item.id !== session.id);
      await this.commit(draft);
      return { id: session.id, removed: true };
    });
  }

  async recordAlignment(sessionId, summary, expectedInstanceId = null) {
    return this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      const session = findSession(draft, sessionId);
      if (expectedInstanceId !== null && session.instanceId !== expectedInstanceId) {
        throw new Error('Perfetto session changed after approval; retry against the current session');
      }
      session.alignmentHistory ??= [];
      session.alignmentHistory.push({
        at: new Date().toISOString(),
        confidence: Number(summary.confidence ?? 0),
        refStart: String(summary.refStart),
        refEnd: String(summary.refEnd),
        dutStart: String(summary.dutStart),
        dutEnd: String(summary.dutEnd),
        method: String(summary.method ?? 'coarse+dtw').slice(0, 80),
      });
      session.alignmentHistory = session.alignmentHistory.slice(-100);
      session.updatedAt = new Date().toISOString();
      await this.commit(draft);
    });
  }
}
