import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './helpers.mjs';
import { createApplication } from '../src/server.mjs';
import { requestBindingHash } from '../src/http-proof.mjs';

function bridgeProof(token, kind, record) {
  const input = [
    `relu-ai-bridge/http-${kind}/v1`, record.origin, record.clientNonce,
    record.serverNonce, record.requestHash,
  ].join('\0');
  return crypto.createHmac('sha256', token).update(input).digest('hex');
}

async function rpc(baseUrl, token, body, sessionId) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('HTTP MCP lifecycle, persistent approval, and command profile work end to end', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });
  await fs.writeFile(path.join(env.root, 'sample.txt'), 'before\n');

  const unauthorized = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);

  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.name, 'relu-ai-bridge');
  assert.equal(health.version, '0.7.0');
  assert.equal(health.approvalPolicy, 'manual');

  const initialized = await rpc(baseUrl, env.config.server.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.body.result.serverInfo.name, 'relu-ai-bridge');
  assert.equal(initialized.body.result.serverInfo.version, health.version);
  assert.match(initialized.body.result.instructions, /locally revocable once\/session\/always approval/u);
  const sessionId = initialized.response.headers.get('mcp-session-id');
  assert.ok(sessionId);

  const listed = await rpc(baseUrl, env.config.server.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'apply_edits'));
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'perfetto_align'));
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'list_sessions'));

  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'apply_edits', arguments: {
    rootId: 'project', edits: [{ path: 'sample.txt', oldText: 'before', newText: 'after' }],
  } } };
  const blocked = await rpc(baseUrl, env.config.server.token, call, sessionId);
  assert.equal(blocked.body.result.isError, true);
  assert.equal(blocked.body.result.structuredContent.error, 'APPROVAL_REQUIRED');
  const requestId = blocked.body.result.structuredContent.approval.id;

  const approval = await fetch(`${baseUrl}/bridge/approvals/${requestId}/decide`, {
    method: 'POST', headers: { authorization: `Bearer ${env.config.server.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'always' }),
  });
  assert.equal(approval.status, 200);
  const applied = await rpc(baseUrl, env.config.server.token, call, sessionId);
  assert.equal(applied.body.result.isError, false);
  assert.equal(await fs.readFile(path.join(env.root, 'sample.txt'), 'utf8'), 'after\n');

  const command = await rpc(baseUrl, env.config.server.token, {
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_command', arguments: { rootId: 'project', profile: 'echo' } },
  }, sessionId);
  assert.equal(command.body.result.structuredContent.error, 'APPROVAL_REQUIRED');
  await app.context.approvals.decide(command.body.result.structuredContent.approval.id, 'always');
  const commandResult = await rpc(baseUrl, env.config.server.token, {
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_command', arguments: { rootId: 'project', profile: 'echo' } },
  }, sessionId);
  assert.equal(commandResult.body.result.structuredContent.stdout, 'ok');
});

test('trusted_always does not enable disabled file writes or commands', async (t) => {
  const env = await fixture({
    approvals: { policy: 'trusted_always' },
    permissions: { write: false, commands: false },
  });
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  await fs.writeFile(path.join(env.root, 'protected-by-permission.txt'), 'before\n');

  const edit = await app.context.mcp.callTool('apply_edits', {
    rootId: 'project',
    edits: [{ path: 'protected-by-permission.txt', oldText: 'before', newText: 'after' }],
  }, { mcpSessionId: 'mcp_trusted_permissions' });
  assert.equal(edit.isError, true);
  assert.match(edit.structuredContent.message, /Writes are disabled/u);
  assert.equal(await fs.readFile(path.join(env.root, 'protected-by-permission.txt'), 'utf8'), 'before\n');

  const command = await app.context.mcp.callTool('run_command', {
    rootId: 'project', profile: 'echo',
  }, { mcpSessionId: 'mcp_trusted_permissions' });
  assert.equal(command.isError, true);
  assert.match(command.structuredContent.message, /Command execution is disabled/u);
  assert.deepEqual(app.context.approvals.list().pending, []);
  assert.deepEqual(app.context.approvals.list().grants, []);
});

test('secret-path MCP authentication works without weakening browser bridge auth', async (t) => {
  const env = await fixture();
  env.config.server.mcpAuth = 'path';
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const wrong = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  assert.equal(wrong.status, 401);
  const correct = await fetch(`${baseUrl}/mcp/${env.config.server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  assert.equal(correct.status, 200);
  const bridge = await fetch(`${baseUrl}/bridge/approvals`);
  assert.equal(bridge.status, 401);
});

test('MCP rejects missing, invented, and closed session ids', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });
  const headers = { authorization: `Bearer ${env.config.server.token}`, 'content-type': 'application/json' };
  const initialized = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  const sessionId = initialized.headers.get('mcp-session-id');
  assert.ok(sessionId);
  for (const value of [undefined, 'mcp_invented_session']) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...headers, ...(value ? { 'mcp-session-id': value } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal((await response.json()).error.code, -32001);
  }
  const closed = await fetch(`${baseUrl}/mcp`, {
    method: 'DELETE', headers: { authorization: `Bearer ${env.config.server.token}`, 'mcp-session-id': sessionId },
  });
  assert.equal((await closed.json()).closed, true);
  const afterClose = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  });
  assert.equal((await afterClose.json()).error.code, -32001);
});

test('optional tool session grants are bound to the server-issued MCP session', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });
  await fs.writeFile(path.join(env.root, 'scope.txt'), 'before\n');

  const first = await rpc(baseUrl, env.config.server.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const second = await rpc(baseUrl, env.config.server.token, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  const firstSession = first.response.headers.get('mcp-session-id');
  const secondSession = second.response.headers.get('mcp-session-id');
  assert.notEqual(firstSession, secondSession);

  const firstCall = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'apply_edits', arguments: {
    rootId: 'project', edits: [{ path: 'scope.txt', oldText: 'before', newText: 'after-a' }],
  } } };
  const blocked = await rpc(baseUrl, env.config.server.token, firstCall, firstSession);
  const firstApproval = blocked.body.result.structuredContent.approval;
  assert.equal(firstApproval.sessionId, firstSession);
  await app.context.approvals.decide(firstApproval.id, 'session');
  const applied = await rpc(baseUrl, env.config.server.token, firstCall, firstSession);
  assert.equal(applied.body.result.isError, false);

  const secondCall = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'apply_edits', arguments: {
    rootId: 'project', edits: [{ path: 'scope.txt', oldText: 'after-a', newText: 'after-b' }],
  } } };
  const isolated = await rpc(baseUrl, env.config.server.token, secondCall, secondSession);
  assert.equal(isolated.body.result.structuredContent.error, 'APPROVAL_REQUIRED');
  assert.equal(isolated.body.result.structuredContent.approval.sessionId, secondSession);
  assert.equal(await fs.readFile(path.join(env.root, 'scope.txt'), 'utf8'), 'after-a\n');
});

test('a once approval for file edits is bound to the complete arguments', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  await fs.writeFile(path.join(env.root, 'once.txt'), 'before\n');
  const requestContext = { mcpSessionId: 'mcp_once_edit' };
  const approvedArgs = {
    rootId: 'project',
    edits: [{ path: 'once.txt', oldText: 'before', newText: 'approved' }],
  };
  const blocked = await app.context.mcp.callTool('apply_edits', approvedArgs, requestContext);
  await app.context.approvals.decide(blocked.structuredContent.approval.id, 'once');

  const swapped = await app.context.mcp.callTool('apply_edits', {
    rootId: 'project',
    edits: [{ path: 'once.txt', oldText: 'before', newText: 'swapped-value' }],
  }, requestContext);
  assert.equal(swapped.structuredContent.error, 'APPROVAL_REQUIRED');
  assert.equal(await fs.readFile(path.join(env.root, 'once.txt'), 'utf8'), 'before\n');

  const applied = await app.context.mcp.callTool('apply_edits', approvedArgs, requestContext);
  assert.equal(applied.isError, false);
  assert.equal(await fs.readFile(path.join(env.root, 'once.txt'), 'utf8'), 'approved\n');
});

test('persistent file and command grants are invalidated when their configured target changes', async (t) => {
  const env = await fixture();
  let app = await createApplication({ config: env.config });
  t.after(async () => { await app?.close(); await env.cleanup(); });
  await fs.writeFile(path.join(env.root, 'policy.txt'), 'old\n');
  const firstContext = { mcpSessionId: 'mcp_policy_first' };

  const firstEdit = await app.context.mcp.callTool('apply_edits', {
    rootId: 'project', edits: [{ path: 'policy.txt', oldText: 'old', newText: 'approved' }],
  }, firstContext);
  await app.context.approvals.decide(firstEdit.structuredContent.approval.id, 'always');
  const firstCommand = await app.context.mcp.callTool('run_command', { rootId: 'project', profile: 'echo' }, firstContext);
  await app.context.approvals.decide(firstCommand.structuredContent.approval.id, 'always');
  await app.close();

  const replacementRoot = path.join(env.directory, 'replacement-project');
  await fs.mkdir(replacementRoot);
  await fs.writeFile(path.join(replacementRoot, 'policy.txt'), 'replacement\n');
  env.config.roots[0].path = replacementRoot;
  env.config.commandProfiles.echo.args = ['-e', 'process.stdout.write("changed")'];
  app = await createApplication({ config: env.config });

  const changedEdit = await app.context.mcp.callTool('apply_edits', {
    rootId: 'project', edits: [{ path: 'policy.txt', oldText: 'replacement', newText: 'must-not-write' }],
  }, { mcpSessionId: 'mcp_policy_second' });
  assert.equal(changedEdit.structuredContent.error, 'APPROVAL_REQUIRED');
  assert.equal(await fs.readFile(path.join(replacementRoot, 'policy.txt'), 'utf8'), 'replacement\n');

  const changedCommand = await app.context.mcp.callTool('run_command', {
    rootId: 'project', profile: 'echo',
  }, { mcpSessionId: 'mcp_policy_second' });
  assert.equal(changedCommand.structuredContent.error, 'APPROVAL_REQUIRED');
});

test('an idle MCP session is rejected even when no new initializer runs', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const sessionId = (await app.context.mcp.initialize()).sessionId;
  app.context.mcp.sessions.get(sessionId).lastSeenAt = Date.now() - (25 * 60 * 60_000);
  const expired = await app.context.mcp.handle(
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { mcpSessionId: sessionId },
  );
  assert.equal(expired.response.error.code, -32001);
  assert.equal(app.context.mcp.sessions.has(sessionId), false);
});

test('browser bridge can start a durable goal and enqueue the first message', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${env.config.server.token}`, 'content-type': 'application/json' };
  t.after(async () => { await app.close(); await env.cleanup(); });
  const registered = await fetch(`${baseUrl}/bridge/register`, {
    method: 'POST', headers, body: JSON.stringify({ clientId: 'browser-one', conversationId: 'conversation-one', url: 'https://chatgpt.com/c/one', title: 'Goal test', role: 'prime' }),
  });
  assert.equal(registered.status, 200);
  const session = await registered.json();
  const started = await fetch(`${baseUrl}/bridge/goal/start`, {
    method: 'POST', headers, body: JSON.stringify({ conversationId: 'conversation-one', goal: 'Finish the test' }),
  });
  assert.equal(started.status, 200);
  const commands = await fetch(`${baseUrl}/bridge/commands?clientId=browser-one&after=0`, { headers: { authorization: `Bearer ${env.config.server.token}` } });
  const body = await commands.json();
  assert.equal(body.commands[0].type, 'send_message');
  assert.match(body.commands[0].message, /\[GOAL_COMPLETE\]/);
  assert.equal((await app.context.sessions.get(session.sessionId)).goal, 'Finish the test');
});

test('browser bridge keeps automatic events volatile when session recording is disabled', async (t) => {
  const env = await fixture();
  env.config.privacy.recordSessions = false;
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${env.config.server.token}`, 'content-type': 'application/json' };
  t.after(async () => { await app.close(); await env.cleanup(); });
  const registered = await fetch(`${baseUrl}/bridge/register`, {
    method: 'POST', headers, body: JSON.stringify({ clientId: 'private-browser', conversationId: 'private-goal', role: 'prime' }),
  });
  const session = await registered.json();
  await app.context.sessions.setGoal(session.sessionId, 'Finish without recording');

  const response = await fetch(`${baseUrl}/bridge/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversationId: 'private-goal',
      messageId: 'private-response',
      type: 'response_end',
      role: 'assistant',
      text: 'Done [GOAL_COMPLETE]',
      metadata: { note: 'must not reach disk' },
    }),
  });
  const result = await response.json();
  assert.equal(result.recorded, false);
  assert.equal(result.goalDecision.status, 'complete');
  assert.deepEqual((await app.context.sessions.get(session.sessionId)).events, []);
});

test('MCP capacity rejects only the new initializer and preserves live sessions', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const first = (await app.context.mcp.initialize()).sessionId;
  for (let index = 1; index < 1024; index += 1) {
    app.context.mcp.sessions.set(`mcp_capacity_${index}`, { createdAt: Date.now(), lastSeenAt: Date.now() });
  }
  const rejected = await app.context.mcp.handle({ jsonrpc: '2.0', id: 99, method: 'initialize', params: {} });
  assert.equal(rejected.response.error.code, -32002);
  assert.equal(app.context.mcp.sessions.has(first), true);
  assert.equal(app.context.mcp.sessions.size, 1024);
});

test('HTTP MCP rejects empty and oversized JSON-RPC batches before processing', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });
  const headers = { authorization: `Bearer ${env.config.server.token}`, 'content-type': 'application/json' };
  for (const body of [[], Array.from({ length: 101 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'initialize' }))]) {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32600);
  }
  assert.equal(app.context.mcp.sessions.size, 0);
});

test('only one bridge instance may mutate a data directory at a time', async (t) => {
  const env = await fixture();
  let first = await createApplication({ config: env.config });
  let second;
  t.after(async () => { await second?.close(); await first?.close(); await env.cleanup(); });

  await assert.rejects(
    () => createApplication({ config: env.config }),
    /instance lock is already held/u,
  );
  await first.close();
  first = null;
  second = await createApplication({ config: env.config });
  assert.ok(second.context.approvals);
});

test('Chrome bridge requests use one-shot mutual proof without transmitting the control token', async (t) => {
  const env = await fixture();
  const extensionId = 'a'.repeat(32);
  const origin = `chrome-extension://${extensionId}`;
  env.config.server.allowedChromeExtensionIds = [extensionId];
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });

  const record = {
    origin,
    clientNonce: crypto.randomBytes(32).toString('hex'),
    method: 'GET',
    path: '/bridge/approvals',
  };
  record.requestHash = requestBindingHash(record.method, record.path, null);
  const challengeResponse = await fetch(`${baseUrl}/bridge/challenge`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ clientNonce: record.clientNonce, requestHash: record.requestHash }),
  });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  record.serverNonce = challenge.serverNonce;
  assert.equal(challenge.proof, bridgeProof(env.config.server.token, 'server', record));

  const headers = {
    origin,
    'x-relu-client-nonce': record.clientNonce,
    'x-relu-server-nonce': record.serverNonce,
    'x-relu-request-proof': bridgeProof(env.config.server.token, 'client', record),
  };
  assert.equal('authorization' in headers, false);
  const accepted = await fetch(`${baseUrl}${record.path}`, { headers });
  assert.equal(accepted.status, 200);
  assert.ok(Array.isArray((await accepted.json()).pending));

  const replay = await fetch(`${baseUrl}${record.path}`, { headers });
  assert.equal(replay.status, 401);

  const unpaired = await fetch(`${baseUrl}/bridge/challenge`, {
    method: 'POST',
    headers: { origin: `chrome-extension://${'b'.repeat(32)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...record, serverNonce: undefined }),
  });
  assert.equal(unpaired.status, 403);
});

test('worker approvals cannot be replayed after retirement or a changed clear target set', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const requestContext = { mcpSessionId: 'mcp_worker_replay' };

  await app.context.agents.spawn({ primeId: 'prime', workerId: 'old-worker', task: 'old task' });
  const pendingMessage = await app.context.mcp.callTool('agents', {
    action: 'message', primeId: 'prime', workerId: 'old-worker', message: 'approved message',
  }, requestContext);
  await app.context.approvals.decide(pendingMessage.structuredContent.approval.id, 'once');
  await app.context.agents.clear('prime', app.context.agents.approvalSnapshot('prime').hash);
  const retiredReplay = await app.context.mcp.callTool('agents', {
    action: 'message', primeId: 'prime', workerId: 'old-worker', message: 'approved message',
  }, requestContext);
  assert.equal(retiredReplay.structuredContent.error, 'TOOL_ERROR');

  await app.context.agents.spawn({ primeId: 'prime', workerId: 'worker-a', task: 'task a' });
  const pendingClear = await app.context.mcp.callTool('agents', { action: 'clear', primeId: 'prime' }, requestContext);
  await app.context.approvals.decide(pendingClear.structuredContent.approval.id, 'once');
  await app.context.agents.spawn({ primeId: 'prime', workerId: 'worker-b', task: 'task b' });
  const changedClear = await app.context.mcp.callTool('agents', { action: 'clear', primeId: 'prime' }, requestContext);
  assert.equal(changedClear.structuredContent.error, 'APPROVAL_REQUIRED');
  assert.equal(app.context.agents.status('prime').workers.filter((worker) => worker.status !== 'retired').length, 2);
});

test('retention pruning remains callable during a long-running bridge process', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const sessionFile = path.join(env.dataDir, 'sessions', 'session_old.json');
  const auditFile = path.join(env.dataDir, 'audit', '2000-01-01.ndjson');
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.mkdir(path.dirname(auditFile), { recursive: true });
  await fs.writeFile(sessionFile, '{}\n');
  await fs.writeFile(auditFile, '{}\n');
  const old = new Date('2000-01-01T00:00:00.000Z');
  await fs.utimes(sessionFile, old, old);
  await fs.utimes(auditFile, old, old);

  await app.context.pruneRetention();
  await assert.rejects(() => fs.stat(sessionFile), (error) => error?.code === 'ENOENT');
  await assert.rejects(() => fs.stat(auditFile), (error) => error?.code === 'ENOENT');
});

test('agent approvals persist only an opaque prime key', async (t) => {
  const env = await fixture();
  env.config.privacy.recordSessions = false;
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const sensitivePrime = 'sensitive-chat-conversation-identifier';
  const result = await app.context.mcp.callTool('agents', {
    action: 'spawn', primeId: sensitivePrime, workerId: 'worker-private', task: 'private task',
  }, { mcpSessionId: 'mcp_private_agent' });
  assert.equal(result.structuredContent.error, 'APPROVAL_REQUIRED');

  const serialized = await fs.readFile(path.join(env.dataDir, 'approvals.json'), 'utf8');
  assert.equal(serialized.includes(sensitivePrime), false);
  assert.equal(serialized.includes('private task'), false);
  assert.match(result.structuredContent.approval.scope, /agent_prime_v1_[a-f0-9]{64}/u);
});
