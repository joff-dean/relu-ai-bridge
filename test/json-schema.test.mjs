import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../src/server.mjs';
import { fixture } from './helpers.mjs';

test('MCP runtime validation enforces array caps before tool execution', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  const result = await app.context.mcp.callTool('perfetto_align', {
    sessionId: 'missing_session',
    refSql: 'SELECT 1 AS ts, 1 AS value',
    dutSql: 'SELECT 1 AS ts, 1 AS value',
    valueColumns: Array.from({ length: 20_000 }, (_, index) => `value_${index}`),
  });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.message, /at most 16 items/);
});

test('MCP runtime validation rejects unknown or oversized alignment tuning', async (t) => {
  const env = await fixture();
  const app = await createApplication({ config: env.config });
  t.after(async () => { await app.close(); await env.cleanup(); });
  for (const options of [
    { unexpected: true },
    { limits: { maxOperations: 8_000_001 } },
    { coarse: { scales: Array.from({ length: 17 }, () => 1) } },
  ]) {
    const result = await app.context.mcp.callTool('perfetto_align', {
      sessionId: 'missing_session',
      refSql: 'SELECT 1 AS ts, 1 AS value',
      dutSql: 'SELECT 1 AS ts, 1 AS value',
      options,
    });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.message, /Invalid tool arguments/);
  }
});
