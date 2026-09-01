import crypto from 'node:crypto';
import path from 'node:path';
import { AsyncMutex, randomId, readJson, writeJsonAtomic } from './utils.mjs';

const PRIVATE_SCHEMA_VERSION = 2;
const PRIME_KEY_PREFIX = 'agent_prime_v1_';
const CONVERSATION_KEY_PREFIX = 'agent_conversation_v1_';
const VALID_WORKER_STATUSES = new Set(['starting', 'working', 'sleeping', 'failed', 'retired']);
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function emptyRecord() {
  return Object.create(null);
}

function validTimestamp(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return new Date(value).toISOString() === value ? value : fallback;
  } catch {
    return fallback;
  }
}

function validWorkerId(value) {
  return typeof value === 'string'
    && /^[a-zA-Z0-9_-]{1,64}$/u.test(value)
    && !RESERVED_OBJECT_KEYS.has(value);
}

function validPrivateKey(value, prefix) {
  return typeof value === 'string' && new RegExp(`^${prefix}[a-f0-9]{64}$`, 'u').test(value);
}

function validCursor(value, fallback = 1) {
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

export class AgentBroker {
  constructor(config, options = {}) {
    this.config = config;
    this.file = path.join(config.dataDir, 'agents.json');
    this.state = { nextCursor: 1, commands: [], primes: emptyRecord() };
    this.visibleState = structuredClone(this.state);
    this.mutationMutex = new AsyncMutex();
    this.persistWriter = options.writeJsonAtomic ?? writeJsonAtomic;
    this.persistTail = Promise.resolve();
  }

  recordsAgentPayloads() {
    return this.config.permissions.sessions && this.config.privacy.recordSessions;
  }

  privateAgentMode() {
    return !this.recordsAgentPayloads();
  }

  hmacKey(prefix, domain, value) {
    if (!value) return null;
    return `${prefix}${crypto.createHmac('sha256', this.config.server.token)
      .update(domain)
      .update(String(value))
      .digest('hex')}`;
  }

  primeKey(primeId) {
    return this.hmacKey(PRIME_KEY_PREFIX, 'relu-ai-bridge/agent-prime/v1\0', primeId);
  }

  conversationKey(conversationId) {
    return this.hmacKey(CONVERSATION_KEY_PREFIX, 'relu-ai-bridge/agent-conversation/v1\0', conversationId);
  }

  normalizePrivateState(loaded) {
    const now = new Date().toISOString();
    const normalized = {
      nextCursor: validCursor(loaded?.nextCursor),
      commands: [],
      primes: emptyRecord(),
    };
    for (const [rawStorageKey, rawPrime] of Object.entries(loaded?.primes ?? {})) {
      if (!rawPrime || typeof rawPrime !== 'object' || Array.isArray(rawPrime)) continue;
      const suppliedKey = validPrivateKey(rawPrime.key, PRIME_KEY_PREFIX)
        ? rawPrime.key
        : (validPrivateKey(rawStorageKey, PRIME_KEY_PREFIX) ? rawStorageKey : null);
      const key = suppliedKey ?? this.primeKey(rawPrime.id ?? rawStorageKey);
      if (!key) continue;
      const prime = {
        key,
        id: null,
        workers: emptyRecord(),
        createdAt: validTimestamp(rawPrime.createdAt, now),
      };
      for (const [rawWorkerId, rawWorker] of Object.entries(rawPrime.workers ?? {})) {
        if (!rawWorker || typeof rawWorker !== 'object' || Array.isArray(rawWorker)) continue;
        const workerId = validWorkerId(rawWorker.id) ? rawWorker.id : rawWorkerId;
        if (!validWorkerId(workerId)) continue;
        const rawStatus = VALID_WORKER_STATUSES.has(rawWorker.status) ? rawWorker.status : 'sleeping';
        const status = ['starting', 'working'].includes(rawStatus) ? 'sleeping' : rawStatus;
        const conversationKey = validPrivateKey(rawWorker.conversationKey, CONVERSATION_KEY_PREFIX)
          ? rawWorker.conversationKey
          : this.conversationKey(rawWorker.conversationId);
        prime.workers[workerId] = {
          id: workerId,
          label: workerId,
          task: null,
          status,
          conversationId: null,
          conversationUrl: null,
          conversationKey,
          _restored: true,
          result: null,
          createdAt: validTimestamp(rawWorker.createdAt, prime.createdAt),
          updatedAt: validTimestamp(rawWorker.updatedAt, prime.createdAt),
        };
      }
      normalized.primes[key] = prime;
    }
    return normalized;
  }

  normalizeRecordedState(loaded) {
    if (loaded?.private === true) {
      return { nextCursor: validCursor(loaded.nextCursor), commands: [], primes: emptyRecord() };
    }
    const primes = emptyRecord();
    if (loaded?.primes && typeof loaded.primes === 'object' && !Array.isArray(loaded.primes)) {
      for (const [key, prime] of Object.entries(loaded.primes)) {
        if (!prime || typeof prime !== 'object' || Array.isArray(prime)) continue;
        primes[key] = {
          ...prime,
          workers: Object.assign(emptyRecord(),
            prime.workers && typeof prime.workers === 'object' && !Array.isArray(prime.workers)
              ? prime.workers
              : {}),
        };
      }
    }
    return {
      nextCursor: validCursor(loaded?.nextCursor),
      commands: Array.isArray(loaded?.commands) ? loaded.commands.slice(-2000) : [],
      primes,
    };
  }

  async initialize() {
    const loaded = await readJson(this.file, this.state);
    this.state = this.privateAgentMode()
      ? this.normalizePrivateState(loaded)
      : this.normalizeRecordedState(loaded);
    await this.persist();
  }

  privateDurableState() {
    const primes = emptyRecord();
    for (const [storageKey, prime] of Object.entries(this.state.primes)) {
      const key = validPrivateKey(prime.key, PRIME_KEY_PREFIX)
        ? prime.key
        : (validPrivateKey(storageKey, PRIME_KEY_PREFIX) ? storageKey : this.primeKey(prime.id ?? storageKey));
      if (!key) continue;
      const workers = emptyRecord();
      for (const worker of Object.values(prime.workers ?? {})) {
        if (!validWorkerId(worker.id)) continue;
        const conversationKey = worker.conversationId
          ? this.conversationKey(worker.conversationId)
          : (validPrivateKey(worker.conversationKey, CONVERSATION_KEY_PREFIX) ? worker.conversationKey : null);
        workers[worker.id] = {
          id: worker.id,
          status: VALID_WORKER_STATUSES.has(worker.status) ? worker.status : 'sleeping',
          createdAt: worker.createdAt,
          updatedAt: worker.updatedAt,
          conversationKey,
        };
      }
      primes[key] = {
        key,
        createdAt: prime.createdAt,
        workers,
      };
    }
    return {
      schemaVersion: PRIVATE_SCHEMA_VERSION,
      private: true,
      nextCursor: this.state.nextCursor,
      commands: [],
      primes,
    };
  }

  async persist() {
    this.state.commands = this.state.commands.slice(-2000);
    const runtimeSnapshot = structuredClone(this.state);
    const durable = structuredClone(this.privateAgentMode() ? this.privateDurableState() : this.state);
    const operation = this.persistTail.catch(() => {}).then(() => this.persistWriter(this.file, durable));
    this.persistTail = operation;
    await operation;
    this.visibleState = runtimeSnapshot;
  }

  async mutate(operation) {
    return this.mutationMutex.runExclusive(async () => {
      const before = this.state;
      this.state = structuredClone(this.state);
      try {
        const result = await operation();
        await this.persist();
        return structuredClone(result);
      } catch (error) {
        this.state = before;
        throw error;
      }
    });
  }

  prime(primeId) {
    const id = String(primeId || 'default').slice(0, 128);
    const storageKey = this.privateAgentMode() ? this.primeKey(id) : id;
    this.state.primes[storageKey] ??= {
      id,
      ...(this.privateAgentMode() ? { key: storageKey } : {}),
      workers: emptyRecord(),
      createdAt: new Date().toISOString(),
    };
    this.state.primes[storageKey].id = id;
    return this.state.primes[storageKey];
  }

  workerView(worker) {
    const { conversationKey: _conversationKey, _restored, ...view } = worker;
    return view;
  }

  activeCount(state = this.state) {
    return Object.values(state.primes)
      .flatMap((prime) => Object.values(prime.workers))
      .filter((worker) => ['starting', 'working'].includes(worker.status)).length;
  }

  approvalSnapshot(primeId, workerId = null, state = this.visibleState) {
    const id = String(primeId || 'default').slice(0, 128);
    const storageKey = this.privateAgentMode() ? this.primeKey(id) : id;
    const prime = state.primes[storageKey];
    const workers = Object.values(prime?.workers ?? {})
      .filter((worker) => worker.status !== 'retired' && (!workerId || worker.id === workerId))
      .map((worker) => ({ id: worker.id, status: worker.status, createdAt: worker.createdAt }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (workerId && workers.length !== 1) throw new Error('Unknown or retired worker');
    const hash = crypto.createHash('sha256').update(JSON.stringify({ primeId: id, workers })).digest('hex');
    return { primeId: id, workers, hash };
  }

  enqueueUnlocked(command) {
    const item = {
      id: randomId('browser_'),
      cursor: this.state.nextCursor++,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...command,
    };
    this.state.commands.push(item);
    return item;
  }

  async enqueue(command) {
    return this.mutate(() => this.enqueueUnlocked(command));
  }

  async spawn(input) {
    if (!this.config.permissions.multiAgent) throw new Error('Multi-agent mode is disabled');
    return this.mutate(() => {
      if (this.activeCount() >= this.config.limits.maxWorkers) throw new Error('No worker slot is available');
      const prime = this.prime(input.primeId);
      const number = Object.keys(prime.workers).length + 1;
      const workerId = input.workerId ?? `worker-${number}`;
      if (!validWorkerId(workerId)) throw new Error('Invalid worker id');
      // A durable worker id is a lifecycle identity, not a reusable display
      // slot.  Keeping retired ids reserved prevents an approval or delayed
      // browser message for an old worker from targeting a replacement.
      if (prime.workers[workerId]) throw new Error(`Worker id has already been used: ${workerId}`);
      const worker = {
        id: workerId,
        label: String(input.label ?? workerId).slice(0, 120),
        task: String(input.task ?? '').slice(0, 20_000),
        status: 'starting',
        conversationId: null,
        conversationUrl: null,
        conversationKey: null,
        _restored: false,
        result: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!worker.task) throw new Error('Worker task is required');
      prime.workers[workerId] = worker;
      const command = this.enqueueUnlocked({
        type: 'open_worker',
        targetClientId: input.clientId ?? null,
        primeId: prime.id,
        workerId,
        message: worker.task,
      });
      return { worker: this.workerView(worker), commandId: command.id };
    });
  }

  async message(input) {
    if (!this.config.permissions.multiAgent) throw new Error('Multi-agent mode is disabled');
    return this.mutate(() => {
      if (input.expectedTargetHash
        && this.approvalSnapshot(input.primeId, input.workerId, this.state).hash !== input.expectedTargetHash) {
        throw new Error('Worker changed after approval; request approval again');
      }
      const prime = this.prime(input.primeId);
      const worker = prime.workers[input.workerId];
      if (!worker) throw new Error('Unknown worker');
      if (worker.status === 'retired') throw new Error('Worker is retired');
      if (this.privateAgentMode() && worker._restored && !worker.conversationId) {
        throw new Error('Worker browser binding is unavailable after restart; reconnect the worker before messaging');
      }
      if (!['starting', 'working'].includes(worker.status) && this.activeCount() >= this.config.limits.maxWorkers) {
        throw new Error('No worker slot is available');
      }
      worker.status = 'working';
      worker.updatedAt = new Date().toISOString();
      const command = this.enqueueUnlocked({
        type: 'message_worker',
        targetClientId: input.clientId ?? null,
        primeId: prime.id,
        workerId: worker.id,
        conversationId: worker.conversationId,
        conversationUrl: worker.conversationUrl,
        message: String(input.message ?? '').slice(0, 20_000),
      });
      return { worker: this.workerView(worker), commandId: command.id };
    });
  }

  async registerWorker(input) {
    return this.mutate(() => {
      const prime = this.prime(input.primeId);
      const worker = prime.workers[input.workerId];
      if (!worker) throw new Error('Unknown worker');
      if (worker.status === 'retired') throw new Error('Worker is retired');
      worker.conversationId = input.conversationId;
      worker.conversationUrl = input.conversationUrl;
      worker.conversationKey = this.privateAgentMode() ? this.conversationKey(input.conversationId) : null;
      worker._restored = false;
      worker.status = 'working';
      worker.updatedAt = new Date().toISOString();
      return this.workerView(worker);
    });
  }

  async report(input) {
    return this.mutate(() => {
      if (input.expectedTargetHash
        && this.approvalSnapshot(input.primeId, input.workerId, this.state).hash !== input.expectedTargetHash) {
        throw new Error('Worker changed after approval; request approval again');
      }
      const prime = this.prime(input.primeId);
      const worker = prime.workers[input.workerId];
      if (!worker) throw new Error('Unknown worker');
      if (worker.status === 'retired') throw new Error('Worker is retired');
      worker.result = String(input.result ?? '').slice(0, 100_000);
      worker.status = input.status === 'failed' ? 'failed' : 'sleeping';
      worker.updatedAt = new Date().toISOString();
      return this.workerView(worker);
    });
  }

  status(primeId) {
    const id = String(primeId || 'default').slice(0, 128);
    const storageKey = this.privateAgentMode() ? this.primeKey(id) : id;
    const prime = this.visibleState.primes[storageKey] ?? { id, workers: emptyRecord() };
    return {
      primeId: prime.id,
      activeWorkers: this.activeCount(this.visibleState),
      maxWorkers: this.config.limits.maxWorkers,
      workers: Object.values(prime.workers).map((worker) => this.workerView(worker)),
    };
  }

  async clear(primeId, expectedTargetHash = null) {
    await this.mutate(() => {
      if (expectedTargetHash && this.approvalSnapshot(primeId, null, this.state).hash !== expectedTargetHash) {
        throw new Error('Worker set changed after approval; request approval again');
      }
      const prime = this.prime(primeId);
      for (const worker of Object.values(prime.workers)) worker.status = 'retired';
      for (const command of this.state.commands) {
        if (command.primeId === prime.id && command.status === 'pending') command.status = 'cancelled';
      }
      return true;
    });
    return this.status(primeId);
  }

  poll(clientId, after = 0) {
    return this.visibleState.commands.filter((command) => {
      if (command.cursor <= after || command.status !== 'pending') return false;
      return !command.targetClientId || command.targetClientId === clientId;
    }).slice(0, 50);
  }

  async acknowledge(commandId, input = {}) {
    return this.mutate(() => {
      const command = this.state.commands.find((item) => item.id === commandId);
      if (!command) throw new Error('Unknown browser command');
      command.status = input.status === 'failed' ? 'failed' : 'acknowledged';
      command.acknowledgedAt = new Date().toISOString();
      command.error = input.error ? String(input.error).slice(0, 2000) : null;
      return command;
    });
  }
}
