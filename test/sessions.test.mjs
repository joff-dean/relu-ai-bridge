import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fixture } from './helpers.mjs';
import { SessionStore } from '../src/sessions.mjs';
import { evaluateGoal } from '../src/goal.mjs';

test('session recording, explicit goal completion, and rebinding are durable', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const sessions = new SessionStore(env.config, (value) => value);
  await sessions.initialize();
  const session = await sessions.create({ conversationId: 'first', title: 'Test' });
  await sessions.setGoal(session.id, 'Finish tests');
  await sessions.appendEvent(session.id, { type: 'message', role: 'assistant', text: 'Done [GOAL_COMPLETE]' });
  const completed = await sessions.get(session.id);
  assert.equal((await evaluateGoal(env.config, completed)).status, 'complete');
  await sessions.rebind(session.id, { conversationId: 'second', url: 'https://chatgpt.com/c/second' });
  assert.equal((await sessions.findByConversation('second')).id, session.id);
});

test('concurrent session mutations do not lose events or goal turns', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const sessions = new SessionStore(env.config, (value) => value);
  await sessions.initialize();
  const session = await sessions.create({ conversationId: 'concurrent', title: 'Concurrent' });
  await Promise.all(Array.from({ length: 20 }, (_, index) => sessions.appendEvent(session.id, {
    type: 'message', role: 'assistant', text: `event-${index}`,
  })));
  await Promise.all(Array.from({ length: 10 }, () => sessions.incrementGoalTurn(session.id)));
  const loaded = await sessions.get(session.id);
  assert.equal(loaded.events.length, 20);
  assert.equal(new Set(loaded.events.map((item) => item.text)).size, 20);
  assert.equal(loaded.goalTurns, 10);
});

for (const disabledBy of ['permissions.sessions', 'privacy.recordSessions']) {
  test(`browser transcript stays volatile when ${disabledBy} is false while explicit session state remains durable`, async (t) => {
    const env = await fixture();
    t.after(() => env.cleanup());
    if (disabledBy === 'permissions.sessions') env.config.permissions.sessions = false;
    else env.config.privacy.recordSessions = false;
    const sessions = new SessionStore(env.config, (value) => String(value).replaceAll('private-token', '[REDACTED]'));
    await sessions.initialize();
    const created = await sessions.create({ conversationId: 'private-conversation', title: 'Private' });
    await sessions.setGoal(created.id, 'Finish privately');

    const transient = await sessions.appendEvent(created.id, {
      type: 'response_end',
      role: 'assistant',
      text: 'private-token [GOAL_COMPLETE]',
      metadata: { nested: { authorization: 'Bearer private-token', note: 'private-token' } },
    });
    assert.equal(transient.events.length, 1);
    assert.equal(transient.events[0].text, '[REDACTED] [GOAL_COMPLETE]');
    assert.deepEqual(transient.events[0].metadata, {
      nested: { authorization: '[REDACTED]', note: '[REDACTED]' },
    });
    assert.equal((await evaluateGoal(env.config, transient)).status, 'complete');

    await sessions.saveHandoff(created.id, 'Explicit handoff private-token', {
      conversationId: 'replacement-conversation',
      url: 'https://chatgpt.com/c/replacement',
    });
    const durable = await sessions.get(created.id);
    assert.deepEqual(durable.events, []);
    assert.equal(durable.estimatedTokens, 0);
    assert.equal(durable.goal, 'Finish privately');
    assert.equal(durable.conversationId, 'replacement-conversation');
    assert.equal(durable.handoffs[0].text, 'Explicit handoff [REDACTED]');
  });
}

test('durable event metadata is recursively redacted', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const sessions = new SessionStore(env.config, (value) => String(value).replaceAll('private-token', '[REDACTED]'));
  await sessions.initialize();
  const session = await sessions.create({ conversationId: 'metadata-redaction' });
  await sessions.appendEvent(session.id, {
    type: 'message',
    role: 'assistant',
    text: 'safe',
    metadata: {
      note: 'contains private-token',
      nested: [{ apiKey: 'private-token' }, 'private-token'],
      'label-private-token': 'safe',
    },
  });
  assert.deepEqual((await sessions.get(session.id)).events[0].metadata, {
    note: 'contains [REDACTED]',
    nested: [{ apiKey: '[REDACTED]' }, '[REDACTED]'],
    'label-[REDACTED]': '[REDACTED]',
  });
});

for (const disabledBy of ['permissions.sessions', 'privacy.recordSessions']) {
  test(`private ${disabledBy} sessions persist only opaque conversation binding and explicit state`, async (t) => {
    const env = await fixture();
    t.after(() => env.cleanup());
    if (disabledBy === 'permissions.sessions') env.config.permissions.sessions = false;
    else env.config.privacy.recordSessions = false;
    const redact = (value) => String(value).replaceAll('private-token', '[REDACTED]');
    const sessions = new SessionStore(env.config, redact);
    await sessions.initialize();
    const created = await sessions.create({
      id: 'raw-user-supplied-session-id',
      conversationId: 'raw-conversation-id',
      conversationUrl: 'https://chatgpt.com/c/raw-conversation-id',
      title: 'Raw confidential title',
      role: 'prime',
      primeId: 'raw-prime-id',
    });
    assert.match(created.id, /^session_[a-f0-9]{32}$/u);
    assert.notEqual(created.id, 'raw-user-supplied-session-id');
    await sessions.setGoal(created.id, 'Durable explicit goal');
    await sessions.appendEvent(created.id, {
      type: 'message',
      role: 'assistant',
      text: 'Raw browser event private-token',
      metadata: { page: 'Raw browser metadata' },
    });
    assert.equal((await sessions.findByConversation('raw-conversation-id')).id, created.id);
    await sessions.rebind(created.id, {
      conversationId: 'raw-rebound-id',
      url: 'https://chatgpt.com/c/raw-rebound-id',
    });
    assert.equal((await sessions.findByConversation('raw-rebound-id')).id, created.id);
    await sessions.saveHandoff(created.id, 'Durable explicit handoff private-token', {
      conversationId: 'raw-replacement-id',
      url: 'https://chatgpt.com/c/raw-replacement-id',
    });
    assert.equal((await sessions.findByConversation('raw-replacement-id')).id, created.id);

    const rawText = await fs.readFile(sessions.sessionPath(created.id), 'utf8');
    for (const secret of [
      'raw-user-supplied-session-id',
      'raw-conversation-id',
      'https://chatgpt.com/c/raw-conversation-id',
      'Raw confidential title',
      'raw-prime-id',
      'Raw browser event',
      'Raw browser metadata',
      'raw-rebound-id',
      'https://chatgpt.com/c/raw-rebound-id',
      'raw-replacement-id',
      'https://chatgpt.com/c/raw-replacement-id',
    ]) assert.doesNotMatch(rawText, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const raw = JSON.parse(rawText);
    assert.equal(raw.conversationKey, sessions.conversationKey('raw-replacement-id'));
    assert.equal('title' in raw, false);
    assert.equal('conversationId' in raw, false);
    assert.equal('conversationUrl' in raw, false);
    assert.equal('primeId' in raw, false);
    assert.equal('events' in raw, false);
    assert.deepEqual(raw.handoffs, [{ at: raw.handoffs[0].at, text: 'Durable explicit handoff [REDACTED]' }]);

    const restarted = new SessionStore(env.config, redact);
    await restarted.initialize();
    const restored = await restarted.findByConversation('raw-replacement-id');
    assert.equal(restored.id, created.id);
    assert.equal(restored.goal, 'Durable explicit goal');
    assert.equal(restored.conversationId, 'raw-replacement-id');
    assert.equal(restored.title, 'Private session');
    assert.equal(restored.handoffs[0].text, 'Durable explicit handoff [REDACTED]');
    const reconnected = await restarted.getOrCreateForConversation({
      conversationId: 'raw-replacement-id',
      conversationUrl: 'https://chatgpt.com/c/current-private-url',
      title: 'Current volatile title',
      role: 'prime',
    });
    assert.equal(reconnected.id, created.id);
    assert.equal(reconnected.title, 'Current volatile title');
    assert.equal(reconnected.conversationUrl, 'https://chatgpt.com/c/current-private-url');
    const afterReconnect = await fs.readFile(restarted.sessionPath(created.id), 'utf8');
    assert.doesNotMatch(afterReconnect, /Current volatile title|current-private-url/u);
  });
}

test('private-mode initialization scrubs legacy raw session metadata and events', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const legacy = new SessionStore(env.config, (value) => value);
  await legacy.initialize();
  const created = await legacy.create({
    conversationId: 'legacy-raw-conversation',
    conversationUrl: 'https://chatgpt.com/c/legacy-raw-conversation',
    title: 'Legacy raw title',
  });
  await legacy.setGoal(created.id, 'Keep this goal');
  await legacy.appendEvent(created.id, {
    type: 'message', role: 'assistant', text: 'Legacy raw browser event', metadata: { page: 'Legacy raw metadata' },
  });
  await legacy.saveHandoff(created.id, 'Keep this explicit handoff', {
    conversationId: 'legacy-raw-replacement',
    url: 'https://chatgpt.com/c/legacy-raw-replacement',
  });

  env.config.privacy.recordSessions = false;
  const privateSessions = new SessionStore(env.config, (value) => value);
  await privateSessions.initialize();
  const rawText = await fs.readFile(privateSessions.sessionPath(created.id), 'utf8');
  for (const secret of [
    'legacy-raw-conversation', 'Legacy raw title', 'Legacy raw browser event', 'Legacy raw metadata',
    'legacy-raw-replacement', 'https://chatgpt.com/c/legacy-raw-replacement',
  ]) assert.doesNotMatch(rawText, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const raw = JSON.parse(rawText);
  assert.equal('events' in raw, false);
  assert.equal(raw.goal, 'Keep this goal');
  assert.deepEqual(raw.handoffs, [{ at: raw.handoffs[0].at, text: 'Keep this explicit handoff' }]);
  assert.equal(raw.conversationKey, privateSessions.conversationKey('legacy-raw-replacement'));
  const restored = await privateSessions.findByConversation('legacy-raw-replacement');
  assert.equal(restored.id, created.id);
  assert.equal(restored.goal, 'Keep this goal');
});
