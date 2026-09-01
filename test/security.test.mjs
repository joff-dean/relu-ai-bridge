import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './helpers.mjs';
import { createRedactor, resolveApprovedPath } from '../src/security.mjs';

test('approved paths reject traversal, protected files, and symlinks', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  await fs.writeFile(path.join(env.root, 'safe.txt'), 'safe');
  await fs.writeFile(path.join(env.directory, 'outside.txt'), 'outside');
  await fs.symlink(path.join(env.directory, 'outside.txt'), path.join(env.root, 'escape.txt'));

  const safe = await resolveApprovedPath(env.config, 'project', 'safe.txt', { mustExist: true });
  assert.equal(safe.relativePath, 'safe.txt');
  await assert.rejects(() => resolveApprovedPath(env.config, 'project', '../outside.txt', { mustExist: true }), /escapes/);
  await assert.rejects(() => resolveApprovedPath(env.config, 'project', 'escape.txt', { mustExist: true }), /Symbolic-link/);
  await assert.rejects(() => resolveApprovedPath(env.config, 'project', '.env', { mustExist: true }), /protected/);
  await assert.rejects(() => resolveApprovedPath(env.config, 'project', 'protected/rule.txt', { write: true }), /protected/);
  await assert.rejects(() => resolveApprovedPath(env.config, 'project', '.env', { write: true }), /protected/);
});

test('redaction removes longer credentials before any credential prefix', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  env.config.server.token = 'control_token_1234567890abcd';
  env.config.perfetto.token = 'control_token_1234567890abcd_PERFETTO_SECRET';
  const redact = createRedactor(env.config);

  const output = redact(`control=${env.config.server.token} perfetto=${env.config.perfetto.token}`);

  assert.equal(output, 'control=[REDACTED] perfetto=[REDACTED]');
  assert.doesNotMatch(output, /PERFETTO_SECRET/u);
});
