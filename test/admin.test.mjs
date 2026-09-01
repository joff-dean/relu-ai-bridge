import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../src/server.mjs';
import { fixture } from './helpers.mjs';

test('local admin shell is public but control APIs remain bearer protected', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await env.cleanup(); });
  const page = await fetch(`${baseUrl}/admin/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RELU AI Bridge/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const denied = await fetch(`${baseUrl}/api/v1/perfetto/clients`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${baseUrl}/api/v1/perfetto/clients`, {
    headers: { authorization: `Bearer ${env.config.server.token}` },
  });
  assert.equal(allowed.status, 200);
});

test('admin session creation is approval-gated and can be persistently granted', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    authorization: `Bearer ${env.config.server.token}`,
    'content-type': 'application/json',
  };
  t.after(async () => { await app.close(); await env.cleanup(); });

  const first = await fetch(`${baseUrl}/api/v1/perfetto/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'pair' }),
  });
  assert.equal(first.status, 409);
  assert.equal(app.context.perfettoStore.list().length, 0);
  const pending = app.context.approvals.list().pending[0];
  assert.equal(pending.scope, 'perfetto.session.create');
  assert.deepEqual(pending.displayDetails, { action: 'create', source: 'admin', name: 'pair' });
  await app.context.approvals.decide(pending.id, 'always');

  const retry = await fetch(`${baseUrl}/api/v1/perfetto/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'pair' }),
  });
  assert.equal(retry.status, 201);
  assert.equal(app.context.perfettoStore.list().length, 1);
});
