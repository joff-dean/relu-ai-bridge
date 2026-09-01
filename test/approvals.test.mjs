import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers.mjs';
import { ApprovalRequiredError, ApprovalStore } from '../src/approvals.mjs';

test('an always grant persists and can be revoked', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new ApprovalStore(env.config);
  await store.initialize();
  let pending;
  await assert.rejects(
    () => store.require({
      scope: 'file.write:project',
      summary: 'write files',
      details: { paths: ['a.txt'] },
      displayDetails: { paths: ['a.txt'], count: 1 },
    }),
    (error) => { pending = error.request; return error instanceof ApprovalRequiredError; },
  );
  await store.decide(pending.id, 'always');
  assert.equal((await store.require({ scope: 'file.write:project', summary: 'write again', details: { paths: ['b.txt'] } })).approvedBy, 'always');

  const reloaded = new ApprovalStore(env.config);
  await reloaded.initialize();
  assert.equal((await reloaded.require({ scope: 'file.write:project', summary: 'after restart' })).approvedBy, 'always');
  const grant = reloaded.list().grants.find((item) => item.scope === 'file.write:project');
  assert.equal(grant.summary, 'write files');
  assert.deepEqual(grant.displayDetails, { paths: ['a.txt'], count: 1 });
  await reloaded.revoke(grant.id);
  await assert.rejects(() => reloaded.require({ scope: 'file.write:project', summary: 'write files' }), ApprovalRequiredError);
});

test('a once grant is tied to the exact request and consumed', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new ApprovalStore(env.config);
  await store.initialize();
  const input = { scope: 'command.run:project:test', summary: 'run tests', details: { profile: 'test' } };
  let request;
  await assert.rejects(() => store.require(input), (error) => { request = error.request; return true; });
  await store.decide(request.id, 'once');
  assert.equal((await store.require(input)).approvedBy, 'once');
  await assert.rejects(() => store.require(input), ApprovalRequiredError);
});

test('a once grant cannot be consumed by two concurrent requests', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new ApprovalStore(env.config);
  await store.initialize();
  const input = { scope: 'perfetto.test:race', summary: 'race', details: { target: 'same' } };
  let request;
  await assert.rejects(() => store.require(input), (error) => { request = error.request; return true; });
  await store.decide(request.id, 'once');

  const results = await Promise.allSettled([store.require(input), store.require(input)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected' && item.reason instanceof ApprovalRequiredError).length, 1);

  const reloaded = new ApprovalStore(env.config);
  await reloaded.initialize();
  assert.equal(reloaded.list().grants.some((grant) => grant.mode === 'once'), false);
});

test('a session grant is bound to the server-recorded pending session', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new ApprovalStore(env.config);
  await store.initialize();
  const input = { scope: 'relu.capability:fixed', summary: 'read context', details: {}, sessionId: 'relu_server_session' };
  let request;
  await assert.rejects(() => store.require(input), (error) => { request = error.request; return true; });
  await store.decide(request.id, 'session', { sessionId: 'attacker_override' });
  const grant = store.list().grants.find((item) => item.scope === input.scope);
  assert.equal(grant.sessionId, 'relu_server_session');
  assert.equal((await store.require(input)).approvedBy, 'session');
  await assert.rejects(() => store.require({ ...input, sessionId: 'attacker_override' }), ApprovalRequiredError);
});

test('a once grant cannot be consumed by a different MCP session', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new ApprovalStore(env.config);
  await store.initialize();
  const input = {
    scope: 'relu.capability:session-bound-once',
    summary: 'one exact call',
    details: { action: 'read' },
    sessionId: 'mcp_session_a',
  };
  let request;
  await assert.rejects(() => store.require(input), (error) => { request = error.request; return true; });
  await store.decide(request.id, 'once');
  await assert.rejects(
    () => store.require({ ...input, sessionId: 'mcp_session_b' }),
    ApprovalRequiredError,
  );
  assert.equal((await store.require(input)).approvedBy, 'once');
});

test('a sensitive approval can forbid persistent and session grants', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new ApprovalStore(env.config);
  await store.initialize();
  const scope = 'relu.operation.reconcile:fixed';

  let broadRequest;
  await assert.rejects(
    () => store.require({ scope, summary: 'ordinary request', details: { generation: 1 } }),
    (error) => { broadRequest = error.request; return true; },
  );
  await store.decide(broadRequest.id, 'always');

  const restricted = {
    scope,
    summary: 'reconcile one incident',
    details: { generation: 2 },
    allowedDecisions: ['once', 'deny'],
  };
  let restrictedRequest;
  await assert.rejects(
    () => store.require(restricted),
    (error) => { restrictedRequest = error.request; return error instanceof ApprovalRequiredError; },
  );
  assert.deepEqual(restrictedRequest.allowedDecisions, ['once', 'deny']);
  await assert.rejects(() => store.decide(restrictedRequest.id, 'always'), /does not permit/);
  await assert.rejects(() => store.decide(restrictedRequest.id, 'session'), /does not permit/);
  await store.decide(restrictedRequest.id, 'once');
  assert.equal((await store.require(restricted)).approvedBy, 'once');
  await assert.rejects(() => store.require(restricted), ApprovalRequiredError);
});

test('restart prunes ephemeral grants and closing a session revokes its grants', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new ApprovalStore(env.config);
  await store.initialize();

  for (const [scope, mode, sessionId] of [
    ['ephemeral.once', 'once', null],
    ['ephemeral.session', 'session', 'mcp_ephemeral'],
    ['durable.always', 'always', null],
  ]) {
    let request;
    await assert.rejects(
      () => store.require({ scope, summary: scope, details: {}, sessionId }),
      (error) => { request = error.request; return true; },
    );
    await store.decide(request.id, mode);
  }

  assert.equal(await store.revokeSession('mcp_ephemeral'), true);
  assert.equal(store.list().grants.some((grant) => grant.mode === 'session'), false);

  const reloaded = new ApprovalStore(env.config);
  await reloaded.initialize();
  assert.deepEqual(reloaded.list().grants.map((grant) => grant.mode), ['always']);
});
