import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AsyncMutex,
  ensurePrivateDir,
  randomId,
  readJson,
  truncateUtf8,
  writeJsonAtomic,
} from './utils.mjs';

const MAX_EVENT_METADATA_DEPTH = 8;
const MAX_EVENT_METADATA_ITEMS = 100;
const MAX_EVENT_METADATA_KEYS = 100;
const MAX_EVENT_METADATA_STRING_BYTES = 4096;
const PRIVATE_SESSION_TITLE = 'Private session';
const CONVERSATION_KEY_PREFIX = 'conversation_v1_';

function sanitizeEventMetadata(value, redactor, depth = 0) {
  if (depth > MAX_EVENT_METADATA_DEPTH) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return truncateUtf8(redactor(value), MAX_EVENT_METADATA_STRING_BYTES).text;
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_EVENT_METADATA_ITEMS)
      .map((item) => sanitizeEventMetadata(item, redactor, depth + 1));
    if (value.length > MAX_EVENT_METADATA_ITEMS) bounded.push(`[${value.length - MAX_EVENT_METADATA_ITEMS} ITEMS OMITTED]`);
    return bounded;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, MAX_EVENT_METADATA_KEYS).map(([rawKey, item]) => {
      const key = redactor(String(rawKey)).slice(0, 200);
      if (/token|secret|password|authorization|api[-_]?key/i.test(rawKey)) return [key, '[REDACTED]'];
      return [key, sanitizeEventMetadata(item, redactor, depth + 1)];
    });
    if (Object.keys(value).length > MAX_EVENT_METADATA_KEYS) entries.push(['_omittedKeys', true]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function estimateTokens(text) {
  const value = String(text ?? '');
  const ascii = (value.match(/[\x00-\x7F]/g) ?? []).length;
  const nonAscii = value.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 1.7);
}

function validSessionId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{3,128}$/.test(id);
}

function validOpaqueSessionId(id) {
  return typeof id === 'string' && /^session_[a-f0-9]{32}$/u.test(id);
}

function validTimestamp(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return new Date(value).toISOString() === value ? value : fallback;
  } catch {
    return fallback;
  }
}

export class SessionStore {
  constructor(config, redactor) {
    this.config = config;
    this.redactor = redactor;
    this.directory = path.join(config.dataDir, 'sessions');
    this.activeConversationId = null;
    this.mutex = new AsyncMutex();
    this.volatileEvents = new Map();
    this.volatileBindings = new Map();
  }

  recordsBrowserEvents() {
    return this.config.permissions.sessions && this.config.privacy.recordSessions;
  }

  privateSessionMode() {
    return !this.recordsBrowserEvents();
  }

  conversationKey(conversationId) {
    if (!conversationId) return null;
    return `${CONVERSATION_KEY_PREFIX}${crypto.createHmac('sha256', this.config.server.token)
      .update('relu-ai-bridge/session-conversation/v1\0')
      .update(String(conversationId))
      .digest('hex')}`;
  }

  rememberBinding(id, input = {}) {
    if (!this.privateSessionMode()) return;
    const current = this.volatileBindings.get(id) ?? {};
    const next = { ...current };
    for (const field of ['title', 'conversationId', 'conversationUrl', 'role', 'primeId']) {
      if (input[field] !== undefined) next[field] = input[field];
    }
    this.volatileBindings.set(id, next);
  }

  hydratePrivateSession(session) {
    if (!this.privateSessionMode()) return session;
    const binding = this.volatileBindings.get(session.id) ?? {};
    return {
      ...session,
      title: binding.title ?? PRIVATE_SESSION_TITLE,
      conversationId: binding.conversationId ?? null,
      conversationUrl: binding.conversationUrl ?? null,
      role: binding.role ?? session.role ?? 'prime',
      primeId: binding.primeId ?? null,
      events: [],
      estimatedTokens: 0,
    };
  }

  privateDurableSession(session) {
    const now = new Date().toISOString();
    const conversationKey = session.conversationId
      ? this.conversationKey(session.conversationId)
      : (/^conversation_v1_[a-f0-9]{64}$/u.test(session.conversationKey ?? '') ? session.conversationKey : null);
    return {
      id: session.id,
      conversationKey,
      role: session.role === 'worker' ? 'worker' : 'prime',
      createdAt: validTimestamp(session.createdAt, now),
      updatedAt: validTimestamp(session.updatedAt, now),
      estimatedTokens: 0,
      goal: session.goal ? this.redactor(String(session.goal)).slice(0, 4000) : null,
      goalTurns: Number.isSafeInteger(session.goalTurns) && session.goalTurns >= 0 ? session.goalTurns : 0,
      handoffs: Array.isArray(session.handoffs) ? session.handoffs.slice(-2000).map((handoff) => ({
        at: validTimestamp(handoff?.at, now),
        text: this.redactor(String(handoff?.text ?? '')).slice(0, 100_000),
      })) : [],
    };
  }

  async persistSession(session) {
    const durable = this.privateSessionMode() ? this.privateDurableSession(session) : session;
    await writeJsonAtomic(this.sessionPath(session.id), durable);
  }

  async scrubPrivateSessions() {
    if (!this.privateSessionMode()) return;
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.directory, entry.name);
      let session;
      try {
        session = await readJson(file);
      } catch {
        continue;
      }
      const durable = this.privateDurableSession(session);
      if (JSON.stringify(durable) !== JSON.stringify(session)) await writeJsonAtomic(file, durable);
    }
  }

  normalizeEvent(event) {
    const text = this.redactor(String(event.text ?? ''));
    const clipped = truncateUtf8(text, this.config.privacy.maxRecordedResultBytes);
    return {
      at: new Date().toISOString(),
      type: this.redactor(String(event.type ?? 'message')).slice(0, 100),
      role: this.redactor(String(event.role ?? '')).slice(0, 100),
      text: clipped.text,
      truncated: clipped.truncated,
      metadata: event.metadata === undefined ? undefined : sanitizeEventMetadata(event.metadata, this.redactor),
    };
  }

  async initialize() {
    await ensurePrivateDir(this.directory);
    await this.prune();
    await this.scrubPrivateSessions();
  }

  sessionPath(id) {
    if (!validSessionId(id)) throw new Error('Invalid session id');
    return path.join(this.directory, `${id}.json`);
  }

  async create(input = {}) {
    return this.mutex.runExclusive(() => this.createUnlocked(input));
  }

  async createUnlocked(input = {}) {
    const suppliedIdIsAllowed = this.privateSessionMode() ? validOpaqueSessionId(input.id) : validSessionId(input.id);
    const id = suppliedIdIsAllowed ? input.id : randomId('session_');
    const now = new Date().toISOString();
    const session = {
      id,
      title: String(input.title ?? 'Untitled session').slice(0, 200),
      conversationId: input.conversationId ?? null,
      conversationUrl: input.conversationUrl ?? null,
      role: input.role ?? 'prime',
      primeId: input.primeId ?? null,
      createdAt: now,
      updatedAt: now,
      estimatedTokens: 0,
      goal: null,
      goalTurns: 0,
      handoffs: [],
      events: [],
    };
    this.rememberBinding(id, session);
    await this.persistSession(session);
    if (session.conversationId) this.activeConversationId = session.conversationId;
    return session;
  }

  async findByConversation(conversationId) {
    if (!conversationId) return null;
    const expectedKey = this.privateSessionMode() ? this.conversationKey(conversationId) : null;
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let session;
      try {
        session = await readJson(path.join(this.directory, entry.name));
      } catch {
        continue;
      }
      if (this.privateSessionMode() ? session.conversationKey === expectedKey : session.conversationId === conversationId) {
        this.rememberBinding(session.id, { conversationId });
        return this.hydratePrivateSession(session);
      }
    }
    return null;
  }

  async getOrCreateForConversation(input) {
    return this.mutex.runExclusive(async () => {
      const existing = await this.findByConversation(input.conversationId);
      if (existing) {
        existing.title = String(input.title ?? existing.title).slice(0, 200);
        existing.conversationUrl = input.conversationUrl ?? existing.conversationUrl;
        existing.role = input.role ?? existing.role;
        existing.primeId = input.primeId ?? existing.primeId;
        existing.updatedAt = new Date().toISOString();
        this.rememberBinding(existing.id, existing);
        await this.persistSession(existing);
        this.activeConversationId = existing.conversationId;
        return existing;
      }
      return this.createUnlocked(input);
    });
  }

  async get(id) {
    return this.hydratePrivateSession(await readJson(this.sessionPath(id)));
  }

  async list() {
    await ensurePrivateDir(this.directory);
    const result = [];
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.directory, entry.name);
      try {
        const session = this.hydratePrivateSession(await readJson(file));
        result.push({
          id: session.id,
          title: session.title,
          conversationId: session.conversationId,
          role: session.role,
          updatedAt: session.updatedAt,
          estimatedTokens: session.estimatedTokens,
          hasGoal: Boolean(session.goal),
        });
      } catch {
        // Ignore an incomplete file; atomic writes make this unlikely.
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendEvent(id, event) {
    return this.mutex.runExclusive(async () => {
      const session = await this.get(id);
      const normalized = this.normalizeEvent(event);
      if (!this.recordsBrowserEvents()) {
        const events = [...(this.volatileEvents.get(id) ?? []), normalized].slice(-2000);
        this.volatileEvents.set(id, events);
        return {
          ...session,
          events,
          estimatedTokens: events.reduce((sum, item) => sum + estimateTokens(item.text), 0),
        };
      }
      session.events.push(normalized);
      session.events = session.events.slice(-2000);
      session.updatedAt = normalized.at;
      session.estimatedTokens = session.events.reduce((sum, item) => sum + estimateTokens(item.text), 0);
      await this.persistSession(session);
      return session;
    });
  }

  async setGoal(id, goal) {
    return this.mutex.runExclusive(async () => {
      const session = await this.get(id);
      session.goal = goal ? String(goal).slice(0, 4000) : null;
      session.goalTurns = 0;
      session.updatedAt = new Date().toISOString();
      await this.persistSession(session);
      return session;
    });
  }

  async incrementGoalTurn(id) {
    return this.mutex.runExclusive(async () => {
      const session = await this.get(id);
      session.goalTurns += 1;
      session.updatedAt = new Date().toISOString();
      await this.persistSession(session);
      return session;
    });
  }

  async saveHandoff(id, handoff, replacement = {}) {
    return this.mutex.runExclusive(async () => {
      const session = await this.get(id);
      const item = {
        at: new Date().toISOString(),
        text: this.redactor(String(handoff)).slice(0, 100_000),
        replacementConversationId: replacement.conversationId ?? null,
        replacementUrl: replacement.url ?? null,
      };
      session.handoffs.push(item);
      session.updatedAt = item.at;
      if (replacement.conversationId) {
        session.conversationId = replacement.conversationId;
        session.conversationUrl = replacement.url ?? session.conversationUrl;
        this.activeConversationId = replacement.conversationId;
      }
      this.rememberBinding(id, session);
      await this.persistSession(session);
      return item;
    });
  }

  async rebind(id, replacement) {
    return this.mutex.runExclusive(async () => {
      const session = await this.get(id);
      session.conversationId = replacement.conversationId;
      session.conversationUrl = replacement.url ?? null;
      session.updatedAt = new Date().toISOString();
      this.activeConversationId = replacement.conversationId;
      this.rememberBinding(id, session);
      await this.persistSession(session);
      return session;
    });
  }

  async prune() {
    await ensurePrivateDir(this.directory);
    const cutoff = Date.now() - this.config.limits.sessionRetentionDays * 86_400_000;
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.directory, entry.name);
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) {
        const id = entry.name.slice(0, -'.json'.length);
        await fs.unlink(file);
        this.volatileBindings.delete(id);
        this.volatileEvents.delete(id);
      }
    }
  }
}
