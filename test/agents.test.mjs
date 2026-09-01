import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AgentBroker } from '../src/agents.mjs';
import { fixture } from './helpers.mjs';

test('worker routing is durable, bounded, and clear cancels pending work', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const broker = new AgentBroker(env.config);
  await broker.initialize();
  await broker.spawn({ primeId: 'prime', workerId: 'one', task: 'Task one' });
  await broker.spawn({ primeId: 'prime', workerId: 'two', task: 'Task two' });
  await assert.rejects(() => broker.spawn({ primeId: 'prime', workerId: 'three', task: 'Task three' }), /slot/);
  const commands = broker.poll('client', 0);
  assert.equal(commands.length, 2);
  await broker.registerWorker({ primeId: 'prime', workerId: 'one', conversationId: 'conversation-one', conversationUrl: 'https://chatgpt.com/c/one' });
  await broker.report({ primeId: 'prime', workerId: 'one', result: 'done', status: 'complete' });
  assert.equal(broker.status('prime').workers.find((item) => item.id === 'one').status, 'sleeping');
  await broker.clear('prime');
  assert.equal(broker.poll('client', 0).length, 0);

  const reloaded = new AgentBroker(env.config);
  await reloaded.initialize();
  assert.equal(reloaded.status('prime').workers.length, 2);
});

for (const disabledBy of ['permissions.sessions', 'privacy.recordSessions']) {
  test(`private agent state keeps payloads volatile when ${disabledBy} is false`, async (t) => {
    const env = await fixture();
    t.after(() => env.cleanup());
    if (disabledBy === 'permissions.sessions') env.config.permissions.sessions = false;
    else env.config.privacy.recordSessions = false;

    const broker = new AgentBroker(env.config);
    await broker.initialize();
    const spawned = await broker.spawn({
      primeId: 'prime-conversation-sensitive',
      workerId: 'worker-1',
      label: 'sensitive worker label',
      task: 'sensitive initial task payload',
      clientId: 'sensitive-browser-client',
    });
    assert.equal(broker.poll('sensitive-browser-client', 0)[0].message, 'sensitive initial task payload');
    await broker.registerWorker({
      primeId: 'prime-conversation-sensitive',
      workerId: 'worker-1',
      conversationId: 'worker-conversation-sensitive',
      conversationUrl: 'https://chatgpt.com/c/sensitive-worker-url',
    });
    await broker.message({
      primeId: 'prime-conversation-sensitive',
      workerId: 'worker-1',
      message: 'sensitive follow-up message',
      clientId: 'sensitive-browser-client',
    });
    await broker.report({
      primeId: 'prime-conversation-sensitive',
      workerId: 'worker-1',
      result: 'sensitive worker result',
      status: 'complete',
    });

    const liveWorker = broker.status('prime-conversation-sensitive').workers[0];
    assert.equal(liveWorker.task, 'sensitive initial task payload');
    assert.equal(liveWorker.result, 'sensitive worker result');
    assert.equal(liveWorker.conversationId, 'worker-conversation-sensitive');
    assert.equal(spawned.worker.task, 'sensitive initial task payload');

    const file = path.join(env.dataDir, 'agents.json');
    const durable = JSON.parse(await fs.readFile(file, 'utf8'));
    const serialized = JSON.stringify(durable);
    for (const secret of [
      'prime-conversation-sensitive',
      'sensitive worker label',
      'sensitive initial task payload',
      'sensitive-browser-client',
      'worker-conversation-sensitive',
      'sensitive-worker-url',
      'sensitive follow-up message',
      'sensitive worker result',
    ]) assert.equal(serialized.includes(secret), false, `agents.json leaked ${secret}`);
    assert.deepEqual(Object.keys(durable).sort(), ['commands', 'nextCursor', 'primes', 'private', 'schemaVersion']);
    assert.equal(durable.private, true);
    assert.deepEqual(durable.commands, []);
    const [primeKey] = Object.keys(durable.primes);
    assert.match(primeKey, /^agent_prime_v1_[a-f0-9]{64}$/u);
    assert.deepEqual(Object.keys(durable.primes[primeKey]).sort(), ['createdAt', 'key', 'workers']);
    const durableWorker = durable.primes[primeKey].workers['worker-1'];
    assert.deepEqual(Object.keys(durableWorker).sort(), ['conversationKey', 'createdAt', 'id', 'status', 'updatedAt']);
    assert.match(durableWorker.conversationKey, /^agent_conversation_v1_[a-f0-9]{64}$/u);

    const reloaded = new AgentBroker(env.config);
    await reloaded.initialize();
    const restored = reloaded.status('prime-conversation-sensitive').workers[0];
    assert.equal(restored.id, 'worker-1');
    assert.equal(restored.label, 'worker-1');
    assert.equal(restored.task, null);
    assert.equal(restored.result, null);
    assert.equal(restored.conversationId, null);
    assert.equal(restored.conversationUrl, null);
    assert.equal(reloaded.poll('sensitive-browser-client', 0).length, 0);
    await assert.rejects(() => reloaded.message({
      primeId: 'prime-conversation-sensitive',
      workerId: 'worker-1',
      message: 'must not route without a live browser binding',
    }), /reconnect the worker/u);
    await reloaded.registerWorker({
      primeId: 'prime-conversation-sensitive',
      workerId: 'worker-1',
      conversationId: 'worker-conversation-sensitive',
      conversationUrl: 'https://chatgpt.com/c/sensitive-worker-url',
    });
    await reloaded.message({
      primeId: 'prime-conversation-sensitive',
      workerId: 'worker-1',
      message: 'same-process routing works after volatile rebind',
    });
  });
}

test('private agent initialization scrubs legacy raw payloads', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  env.config.privacy.recordSessions = false;
  const now = new Date().toISOString();
  await fs.mkdir(env.dataDir, { recursive: true });
  await fs.writeFile(path.join(env.dataDir, 'agents.json'), JSON.stringify({
    nextCursor: 19,
    commands: [{
      id: 'legacy-command', cursor: 18, status: 'pending', type: 'message_worker',
      targetClientId: 'legacy-client-secret', primeId: 'legacy-prime-secret',
      workerId: 'worker-1', conversationId: 'legacy-conversation-secret',
      conversationUrl: 'https://chatgpt.com/c/legacy-secret', message: 'legacy-message-secret',
    }],
    primes: {
      'legacy-prime-secret': {
        id: 'legacy-prime-secret',
        createdAt: now,
        workers: {
          'worker-1': {
            id: 'worker-1', label: 'legacy-label-secret', task: 'legacy-task-secret',
            status: 'working', conversationId: 'legacy-conversation-secret',
            conversationUrl: 'https://chatgpt.com/c/legacy-secret', result: 'legacy-result-secret',
            createdAt: now, updatedAt: now,
          },
        },
      },
    },
  }));

  const broker = new AgentBroker(env.config);
  await broker.initialize();
  const serialized = await fs.readFile(path.join(env.dataDir, 'agents.json'), 'utf8');
  for (const secret of [
    'legacy-client-secret', 'legacy-prime-secret', 'legacy-conversation-secret',
    'legacy-secret', 'legacy-message-secret', 'legacy-label-secret', 'legacy-task-secret', 'legacy-result-secret',
  ]) assert.equal(serialized.includes(secret), false, `legacy payload was not scrubbed: ${secret}`);
  const durable = JSON.parse(serialized);
  assert.equal(durable.private, true);
  assert.equal(durable.nextCursor, 19);
  assert.deepEqual(durable.commands, []);
  const restored = broker.status('legacy-prime-secret').workers[0];
  assert.equal(restored.id, 'worker-1');
  assert.equal(restored.status, 'sleeping');
  assert.equal(restored.task, null);
  assert.equal(restored.result, null);
  assert.equal(restored.conversationId, null);
  assert.equal(restored.conversationUrl, null);
});

test('agent persistence serializes snapshots so older state cannot win a write race', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  env.config.privacy.recordSessions = false;
  let activeWrites = 0;
  let maximumConcurrentWrites = 0;
  const snapshots = [];
  const broker = new AgentBroker(env.config, {
    writeJsonAtomic: async (_file, value) => {
      activeWrites += 1;
      maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, Object.keys(value.primes).length ? 20 : 1));
      snapshots.push(structuredClone(value));
      activeWrites -= 1;
    },
  });
  broker.state.primes[broker.primeKey('old')] = {
    key: broker.primeKey('old'),
    id: 'old',
    workers: Object.create(null),
    createdAt: new Date().toISOString(),
  };
  const oldWrite = broker.persist();
  broker.state.primes = Object.create(null);
  const newWrite = broker.persist();

  await Promise.all([oldWrite, newWrite]);

  assert.equal(maximumConcurrentWrites, 1);
  assert.equal(Object.keys(snapshots.at(-1).primes).length, 0);
});

test('failed agent persistence never exposes a ghost worker or browser command', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  let writes = 0;
  const broker = new AgentBroker(env.config, {
    writeJsonAtomic: async () => {
      writes += 1;
      if (writes > 1) throw new Error('simulated disk full');
    },
  });
  await broker.initialize();

  await assert.rejects(
    () => broker.spawn({ primeId: 'prime', workerId: 'ghost', task: 'must not execute' }),
    /simulated disk full/u,
  );

  assert.equal(broker.status('prime').workers.length, 0);
  assert.equal(broker.poll('browser-client', 0).length, 0);
});

test('retired worker ids cannot be reused and clear validates its approved worker snapshot', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const broker = new AgentBroker(env.config);
  await broker.initialize();
  await broker.spawn({ primeId: 'prime', workerId: 'stable-worker', task: 'old task' });
  const beforeClear = broker.approvalSnapshot('prime');
  await broker.spawn({ primeId: 'prime', workerId: 'new-worker', task: 'new task' });
  await assert.rejects(() => broker.clear('prime', beforeClear.hash), /Worker set changed/u);

  await broker.clear('prime', broker.approvalSnapshot('prime').hash);
  await assert.rejects(() => broker.registerWorker({
    primeId: 'prime', workerId: 'stable-worker', conversationId: 'late', conversationUrl: 'https://chatgpt.com/c/late',
  }), /retired/u);
  await assert.rejects(() => broker.report({
    primeId: 'prime', workerId: 'stable-worker', result: 'late result', status: 'complete',
  }), /retired/u);
  await assert.rejects(
    () => broker.spawn({ primeId: 'prime', workerId: 'stable-worker', task: 'replacement task' }),
    /already been used/u,
  );
});
