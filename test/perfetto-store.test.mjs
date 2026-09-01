import assert from 'node:assert/strict';
import test from 'node:test';
import { PerfettoSessionStore } from '../src/perfetto-store.mjs';
import { fixture } from './helpers.mjs';

test('concurrent Perfetto session mutations remain durable and ordered', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();

  await Promise.all([
    store.create({ id: 'session_one', name: 'one' }),
    store.create({ id: 'session_two', name: 'two' }),
  ]);
  const binding = 'a'.repeat(32);
  await Promise.all([
    store.attach('session_one', 'ref', 'client_one', binding),
    store.attach('session_two', 'dut', 'client_two', binding),
  ]);

  const reloaded = new PerfettoSessionStore(env.config);
  await reloaded.initialize();
  assert.deepEqual(
    reloaded.list().map((item) => ({ id: item.id, ref: item.refClientId, dut: item.dutClientId })),
    [
      { id: 'session_one', ref: 'client_one', dut: null },
      { id: 'session_two', ref: null, dut: 'client_two' },
    ],
  );
});

test('v1 assignments migrate as stale instead of inheriting an unverified trace', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const file = new URL(`file://${env.dataDir}/perfetto-sessions.json`);
  const fs = await import('node:fs/promises');
  await fs.mkdir(env.dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    sessions: [{
      id: 'legacy_session', name: 'legacy', refClientId: 'legacy_client', dutClientId: null,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), alignmentHistory: [],
    }],
  }));
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  assert.equal(store.get('legacy_session').refTraceBinding, null);
});

test('session-targeted commits reject a replacement that reuses the public id', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new PerfettoSessionStore(env.config);
  await store.initialize();
  const original = await store.create({ id: 'reused_session', name: 'original' });
  const binding = 'a'.repeat(32);
  await store.attach(original.id, 'ref', 'client_one', binding, original.instanceId);
  await store.remove(original.id, original.instanceId);
  const replacement = await store.create({ id: original.id, name: 'replacement' });
  await store.attach(replacement.id, 'ref', 'client_one', binding, replacement.instanceId);

  await assert.rejects(
    store.attach(original.id, 'dut', 'client_two', 'b'.repeat(32), original.instanceId),
    /session changed after approval/u,
  );
  await assert.rejects(
    store.detach(original.id, 'ref', {
      instanceId: original.instanceId, clientId: 'client_one', traceBinding: binding,
    }),
    /target changed after approval/u,
  );
  await assert.rejects(
    store.recordAlignment(original.id, {
      confidence: 1, refStart: '0', refEnd: '1', dutStart: '0', dutEnd: '1',
    }, original.instanceId),
    /session changed after approval/u,
  );

  const current = store.get(original.id);
  assert.equal(current.instanceId, replacement.instanceId);
  assert.equal(current.refClientId, 'client_one');
  assert.equal(current.dutClientId, null);
  assert.deepEqual(current.alignmentHistory, []);
});
