import crypto from 'node:crypto';
import path from 'node:path';
import { AsyncMutex, randomId, readJson, writeJsonAtomic } from './utils.mjs';

const APPROVAL_DECISIONS = Object.freeze(['once', 'session', 'always', 'deny']);
const APPROVAL_POLICIES = Object.freeze(['trusted_always', 'manual']);

function configuredPolicy(config) {
  const policy = config?.approvals?.policy;
  if (!APPROVAL_POLICIES.includes(policy)) throw new Error('Approval policy is invalid');
  return policy;
}

function allowedDecisions(value = APPROVAL_DECISIONS) {
  if (!Array.isArray(value) || value.length === 0 || value.length > APPROVAL_DECISIONS.length) {
    throw new Error('Approval decision policy is invalid');
  }
  const normalized = [...new Set(value)];
  if (normalized.length !== value.length || !normalized.includes('deny')
    || normalized.some((item) => !APPROVAL_DECISIONS.includes(item))) {
    throw new Error('Approval decision policy is invalid');
  }
  return normalized;
}

export class ApprovalRequiredError extends Error {
  constructor(request) {
    super(`APPROVAL_REQUIRED: ${request.summary} (request ${request.id})`);
    this.name = 'ApprovalRequiredError';
    this.code = 'APPROVAL_REQUIRED';
    this.statusCode = 409;
    this.request = request;
  }
}

function safeDisplay(value, depth = 0) {
  if (depth > 4) return '[OMITTED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 300);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeDisplay(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
      key.slice(0, 80),
      /token|secret|password|authorization|api[-_]?key/i.test(key) ? '[REDACTED]' : safeDisplay(item, depth + 1),
    ]));
  }
  return String(value).slice(0, 300);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class ApprovalStore {
  constructor(config) {
    this.config = config;
    this.policy = configuredPolicy(config);
    this.file = path.join(config.dataDir, 'approvals.json');
    this.state = { policy: this.policy, grants: [], pending: [] };
    this.mutex = new AsyncMutex();
  }

  async initialize() {
    return this.mutex.runExclusive(async () => {
      const loaded = await readJson(this.file, this.state);
      // 0.4.x state had no policy field and therefore represents manual mode.
      // A policy transition invalidates old decisions so switching back cannot
      // silently reactivate a grant from a different authorization regime.
      const loadedPolicy = loaded && typeof loaded === 'object'
        && Object.prototype.hasOwnProperty.call(loaded, 'policy')
        ? loaded.policy
        : 'manual';
      const samePolicy = loadedPolicy === this.policy;
      const draft = {
        policy: this.policy,
        // A process restart ends every MCP session.  Session grants therefore
        // cannot be carried into the new process, and consumed one-shot grants
        // have no further security or audit value in this live authorization
        // database.
        grants: samePolicy && this.policy === 'manual' && Array.isArray(loaded?.grants)
          ? loaded.grants.filter((grant) => grant?.mode === 'always')
          : [],
        pending: samePolicy && Array.isArray(loaded?.pending)
          ? loaded.pending.filter((item) => item?.status === 'pending' && !this.isExpired(item))
          : [],
      };
      await this.commit(draft);
    });
  }

  isExpired(request, now = Date.now()) {
    const created = Date.parse(request?.createdAt ?? '');
    return !Number.isFinite(created) || now - created > (this.config.approvals.pendingTtlMs ?? 10 * 60_000);
  }

  async pruneExpiredUnlocked() {
    const draft = structuredClone(this.state);
    draft.pending = draft.pending.filter((item) => item.status === 'pending' && !this.isExpired(item));
    if (draft.pending.length !== this.state.pending.length) await this.commit(draft);
  }

  async commit(draft) {
    await writeJsonAtomic(this.file, draft);
    this.state = draft;
  }

  hasAlways(scope, state = this.state) {
    return this.config.approvals.preapprovedScopes.includes(scope)
      || state.grants.some((grant) => grant.scope === scope && grant.mode === 'always');
  }

  findConsumable(state, scope, requestFingerprint, sessionId, decisions = APPROVAL_DECISIONS) {
    return state.grants.find((grant) => {
      if (grant.scope !== scope) return false;
      if (!decisions.includes(grant.mode)) return false;
      if (grant.mode === 'once') return grant.fingerprint === requestFingerprint && !grant.consumedAt;
      if (grant.mode === 'session') return Boolean(sessionId) && grant.sessionId === sessionId;
      return false;
    });
  }

  async require(input) {
    return this.mutex.runExclusive(() => this.requireUnlocked(input));
  }

  async requireUnlocked(input) {
    await this.pruneExpiredUnlocked();
    const decisions = allowedDecisions(input.allowedDecisions);
    // trusted_always is the configuration-level equivalent of the existing
    // `always` choice. Requests intentionally restricted to once/deny retain
    // their human safety interlock (for example ambiguous mutation recovery).
    if (this.policy === 'trusted_always' && decisions.includes('always')) {
      return { approvedBy: 'trusted_always' };
    }
    if (decisions.includes('always') && this.hasAlways(input.scope)) return { approvedBy: 'always' };
    const requestFingerprint = fingerprint({
      scope: input.scope,
      details: input.details ?? null,
      sessionId: input.sessionId ?? null,
      allowedDecisions: [...decisions].sort(),
    });
    const consumable = this.findConsumable(this.state, input.scope, requestFingerprint, input.sessionId, decisions);
    if (consumable) {
      if (consumable.mode === 'once') {
        const draft = structuredClone(this.state);
        draft.grants = draft.grants.filter((grant) => grant.id !== consumable.id);
        await this.commit(draft);
      }
      return { approvedBy: consumable.mode };
    }
    let request = this.state.pending.find((item) => item.fingerprint === requestFingerprint && item.status === 'pending');
    if (!request) {
      if (this.state.pending.length >= (this.config.approvals.maxPending ?? 200)) {
        throw new Error('Too many pending approval requests');
      }
      request = {
        id: randomId('approval_'),
        scope: input.scope,
        summary: String(input.summary).slice(0, 500),
        fingerprint: requestFingerprint,
        sessionId: input.sessionId ?? null,
        displayDetails: safeDisplay(input.displayDetails ?? null),
        allowedDecisions: decisions,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      const draft = structuredClone(this.state);
      draft.pending.push(request);
      await this.commit(draft);
    }
    throw new ApprovalRequiredError(request);
  }

  list() {
    return structuredClone({
      policy: this.policy,
      pending: this.state.pending.filter((item) => item.status === 'pending'),
      grants: this.state.grants.filter((item) => item.mode !== 'once' || !item.consumedAt),
      preapprovedScopes: this.config.approvals.preapprovedScopes,
    });
  }

  async decide(requestId, decision, options = {}) {
    return this.mutex.runExclusive(() => this.decideUnlocked(requestId, decision, options));
  }

  async decideUnlocked(requestId, decision, options = {}) {
    await this.pruneExpiredUnlocked();
    const draft = structuredClone(this.state);
    const request = draft.pending.find((item) => item.id === requestId && item.status === 'pending');
    if (!request) throw new Error('Pending approval request not found');
    if (!APPROVAL_DECISIONS.includes(decision)) throw new Error('Invalid approval decision');
    if (!allowedDecisions(request.allowedDecisions).includes(decision)) {
      throw new Error('This approval request does not permit that decision');
    }
    if (decision === 'always' && !this.config.approvals.allowPersistentGrants) throw new Error('Persistent grants are disabled');
    let grant = null;
    if (decision !== 'deny') {
      grant = {
        id: randomId('grant_'),
        scope: request.scope,
        mode: decision,
        summary: request.summary,
        displayDetails: request.displayDetails ?? null,
        fingerprint: decision === 'once' ? request.fingerprint : null,
        sessionId: decision === 'session' ? request.sessionId : null,
        createdAt: new Date().toISOString(),
        consumedAt: null,
      };
      if (decision === 'session' && !grant.sessionId) throw new Error('A session grant requires a session id');
    }
    request.status = decision === 'deny' ? 'denied' : 'approved';
    request.decidedAt = new Date().toISOString();
    if (grant) draft.grants.push(grant);
    await this.commit(draft);
    return structuredClone(request);
  }

  async revoke(grantId) {
    return this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      const before = draft.grants.length;
      draft.grants = draft.grants.filter((grant) => grant.id !== grantId);
      if (draft.grants.length === before) throw new Error('Grant not found');
      await this.commit(draft);
      return this.list();
    });
  }

  async revokeSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    return this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      const before = draft.grants.length;
      draft.grants = draft.grants.filter((grant) => grant.mode !== 'session' || grant.sessionId !== sessionId);
      if (draft.grants.length === before) return false;
      await this.commit(draft);
      return true;
    });
  }
}
