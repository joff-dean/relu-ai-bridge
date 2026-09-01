import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fixture } from './helpers.mjs';
import { FileTools } from '../src/tools/files.mjs';
import { createRedactor } from '../src/security.mjs';

const run = promisify(execFile);

test('file tools read, search, and atomically edit approved files', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  await fs.mkdir(path.join(env.root, 'src'));
  await fs.writeFile(path.join(env.root, 'src', 'a.txt'), 'hello old\n');
  const tools = new FileTools(env.config);
  const read = await tools.readFile({ rootId: 'project', path: 'src/a.txt' });
  assert.equal(read.content, 'hello old\n');
  const search = await tools.search({ rootId: 'project', query: 'old' });
  assert.equal(search.results[0].path, 'src/a.txt');
  const result = await tools.applyEdits({
    rootId: 'project',
    edits: [
      { path: 'src/a.txt', oldText: 'old', newText: 'new' },
      { path: 'src/b.txt', create: true, newText: 'created\n' },
    ],
  });
  assert.equal(result.changed.length, 2);
  assert.equal(await fs.readFile(path.join(env.root, 'src', 'a.txt'), 'utf8'), 'hello new\n');
  assert.equal(await fs.readFile(path.join(env.root, 'src', 'b.txt'), 'utf8'), 'created\n');
});

test('edit preflight prevents partial writes', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  await fs.writeFile(path.join(env.root, 'a.txt'), 'original');
  await fs.writeFile(path.join(env.root, 'b.txt'), 'original');
  const tools = new FileTools(env.config);
  await assert.rejects(() => tools.applyEdits({
    rootId: 'project',
    edits: [
      { path: 'a.txt', oldText: 'original', newText: 'changed' },
      { path: 'b.txt', oldText: 'missing', newText: 'changed' },
    ],
  }), /Expected 1 occurrence/);
  assert.equal(await fs.readFile(path.join(env.root, 'a.txt'), 'utf8'), 'original');
});

test('concurrent edit transactions are serialized per root', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  await fs.writeFile(path.join(env.root, 'counter.txt'), 'zero');
  const tools = new FileTools(env.config);
  const first = tools.applyEdits({ rootId: 'project', edits: [{ path: 'counter.txt', oldText: 'zero', newText: 'one' }] });
  const second = tools.applyEdits({ rootId: 'project', edits: [{ path: 'counter.txt', oldText: 'zero', newText: 'two' }] });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(await fs.readFile(path.join(env.root, 'counter.txt'), 'utf8'), 'one');
});

test('protected files are omitted from list, search, read, and whole-root diff', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  await fs.writeFile(path.join(env.root, '.env'), 'RELU_PRIVATE_VALUE=do-not-return\n');
  await fs.writeFile(path.join(env.root, '.npmrc'), '//registry.example/:_authToken=npm-private-marker\n');
  await fs.writeFile(path.join(env.root, 'signing.pem'), 'PRIVATE-KEY-MARKER\n');
  await fs.writeFile(path.join(env.root, 'visible.txt'), 'visible before\n');
  await run('git', ['init', '-q'], { cwd: env.root });
  await run('git', ['add', '.'], { cwd: env.root });
  await run('git', ['-c', 'user.name=RELU Test', '-c', 'user.email=relu@example.invalid', 'commit', '-qm', 'base'], { cwd: env.root });
  await fs.writeFile(path.join(env.root, '.env'), 'RELU_PRIVATE_VALUE=changed-secret\n');
  await fs.writeFile(path.join(env.root, '.npmrc'), '//registry.example/:_authToken=changed-npm-marker\n');
  await fs.writeFile(path.join(env.root, 'signing.pem'), 'CHANGED-PRIVATE-KEY-MARKER\n');
  await fs.writeFile(path.join(env.root, 'visible.txt'), 'visible after\n');
  const tools = new FileTools(env.config, createRedactor(env.config));

  const listed = await tools.listFiles({ rootId: 'project', limit: 100 });
  assert.equal(listed.files.includes('.env'), false);
  assert.equal(listed.files.includes('.npmrc'), false);
  assert.equal(listed.files.includes('signing.pem'), false);
  const searched = await tools.search({ rootId: 'project', query: 'changed-secret' });
  assert.equal(searched.results.length, 0);
  await assert.rejects(() => tools.readFile({ rootId: 'project', path: '.env' }), /protected/);
  await assert.rejects(() => tools.readFile({ rootId: 'project', path: '.npmrc' }), /protected/);
  await assert.rejects(() => tools.readFile({ rootId: 'project', path: 'signing.pem' }), /protected/);
  await assert.rejects(() => tools.gitDiff({ rootId: 'project', paths: ['.env'] }), /protected/);
  const magicPathspec = await tools.gitDiff({ rootId: 'project', paths: [':(top).env'] });
  assert.equal(magicPathspec.diff, '');
  const diff = await tools.gitDiff({ rootId: 'project' });
  assert.match(diff.diff, /visible after/);
  assert.doesNotMatch(diff.diff, /changed-secret|RELU_PRIVATE_VALUE|changed-npm-marker|PRIVATE-KEY-MARKER/);
});

test('git diff disables textconv, strips bridge credentials, and redacts output', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const secret = env.config.server.token;
  const previous = process.env.RELU_AI_BRIDGE_TOKEN;
  process.env.RELU_AI_BRIDGE_TOKEN = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.RELU_AI_BRIDGE_TOKEN;
    else process.env.RELU_AI_BRIDGE_TOKEN = previous;
  });
  await run('git', ['init', '-q'], { cwd: env.root });
  await fs.writeFile(path.join(env.root, '.gitattributes'), '*.leak diff=leak\n');
  await fs.writeFile(path.join(env.root, 'value.leak'), 'before\n');
  await fs.writeFile(path.join(env.root, 'textconv.sh'), '#!/bin/sh\nprintf "%s\\n" "$RELU_AI_BRIDGE_TOKEN"\n', { mode: 0o700 });
  await run('git', ['config', 'diff.leak.textconv', path.join(env.root, 'textconv.sh')], { cwd: env.root });
  await run('git', ['add', '.'], { cwd: env.root });
  await run('git', ['-c', 'user.name=RELU Test', '-c', 'user.email=relu@example.invalid', 'commit', '-qm', 'base'], { cwd: env.root });
  await fs.writeFile(path.join(env.root, 'value.leak'), `after ${secret}\n`);

  const tools = new FileTools(env.config, createRedactor(env.config));
  const diff = await tools.gitDiff({ rootId: 'project', paths: ['value.leak'] });
  assert.doesNotMatch(diff.diff, new RegExp(secret));
  assert.match(diff.diff, /\[REDACTED\]/);
  assert.match(diff.diff, /before/);
});

test('bridge config and state remain reserved when they overlap an approved root', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  env.config.configPath = path.join(env.root, 'config', 'local.json');
  env.config.dataDir = path.join(env.root, '.relu-state');
  await fs.mkdir(path.dirname(env.config.configPath), { recursive: true });
  await fs.mkdir(env.config.dataDir, { recursive: true });
  await fs.writeFile(env.config.configPath, 'bridge-config-secret\n');
  await fs.writeFile(path.join(env.config.dataDir, 'approvals.json'), 'bridge-state-secret\n');
  await fs.writeFile(path.join(env.root, 'visible.txt'), 'visible before\n');
  await run('git', ['init', '-q'], { cwd: env.root });
  await run('git', ['add', '.'], { cwd: env.root });
  await run('git', ['-c', 'user.name=RELU Test', '-c', 'user.email=relu@example.invalid', 'commit', '-qm', 'base'], { cwd: env.root });
  await fs.writeFile(env.config.configPath, 'changed-config-secret\n');
  await fs.writeFile(path.join(env.config.dataDir, 'approvals.json'), 'changed-state-secret\n');
  await fs.writeFile(path.join(env.root, 'visible.txt'), 'visible after\n');
  const tools = new FileTools(env.config, createRedactor(env.config));

  const listed = await tools.listFiles({ rootId: 'project', limit: 100 });
  assert.equal(listed.files.includes('config/local.json'), false);
  assert.equal(listed.files.some((file) => file.startsWith('.relu-state/')), false);
  assert.equal((await tools.search({ rootId: 'project', query: 'changed-config-secret' })).results.length, 0);
  assert.equal((await tools.search({ rootId: 'project', query: 'changed-state-secret' })).results.length, 0);
  await assert.rejects(() => tools.readFile({ rootId: 'project', path: 'config/local.json' }), /reserved/u);
  await assert.rejects(() => tools.readFile({ rootId: 'project', path: '.relu-state/approvals.json' }), /reserved/u);
  await assert.rejects(() => tools.applyEdits({
    rootId: 'project',
    edits: [{ path: 'config/local.json', oldText: 'changed', newText: 'unsafe' }],
  }), /reserved/u);
  await fs.symlink(env.config.dataDir, path.join(env.root, 'state-alias'));
  await assert.rejects(() => tools.applyEdits({
    rootId: 'project',
    edits: [{ path: 'state-alias/new-ledger.json', create: true, newText: 'unsafe' }],
  }), /reserved/u);
  await assert.rejects(() => fs.access(path.join(env.config.dataDir, 'new-ledger.json')));
  await assert.rejects(() => tools.gitDiff({ rootId: 'project', paths: ['.relu-state/approvals.json'] }), /reserved/u);
  const diff = await tools.gitDiff({ rootId: 'project' });
  assert.match(diff.diff, /visible after/u);
  assert.doesNotMatch(diff.diff, /config-secret|state-secret/u);
});

test('git diff obeys the global file-read permission', async (t) => {
  const env = await fixture({ permissions: { read: false } });
  t.after(() => env.cleanup());
  await fs.writeFile(path.join(env.root, 'visible.txt'), 'before\n');
  await run('git', ['init', '-q'], { cwd: env.root });
  await run('git', ['add', 'visible.txt'], { cwd: env.root });
  await run('git', ['-c', 'user.name=RELU Test', '-c', 'user.email=relu@example.invalid', 'commit', '-qm', 'base'], { cwd: env.root });
  await fs.writeFile(path.join(env.root, 'visible.txt'), 'sensitive after\n');
  const tools = new FileTools(env.config, createRedactor(env.config));

  await assert.rejects(() => tools.gitDiff({ rootId: 'project' }), /File reads are disabled/u);
});

test('binary file reads are denied instead of bypassing text credential redaction', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  await fs.writeFile(path.join(env.root, 'artifact.bin'), Buffer.concat([
    Buffer.from([0]),
    Buffer.from(`prefix:${env.config.perfetto.token}:suffix`),
  ]));
  const tools = new FileTools(env.config, createRedactor(env.config));

  await assert.rejects(
    () => tools.readFile({ rootId: 'project', path: 'artifact.bin' }),
    /Binary file reads are disabled/u,
  );
});

test('multi-file edit revalidates each target and preserves an external editor change', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  await fs.writeFile(path.join(env.root, 'first.txt'), 'first-old');
  await fs.writeFile(path.join(env.root, 'victim.txt'), 'approved-old');
  const tools = new FileTools(env.config, createRedactor(env.config), {
    beforeCommit: async ({ index }) => {
      if (index === 1) await fs.writeFile(path.join(env.root, 'victim.txt'), 'external-editor-new');
    },
  });

  await assert.rejects(() => tools.applyEdits({
    rootId: 'project',
    edits: [
      { path: 'first.txt', oldText: 'first-old', newText: 'first-new' },
      { path: 'victim.txt', oldText: 'approved-old', newText: 'bridge-result' },
    ],
  }), /target changed before commit/u);

  assert.equal(await fs.readFile(path.join(env.root, 'first.txt'), 'utf8'), 'first-old');
  assert.equal(await fs.readFile(path.join(env.root, 'victim.txt'), 'utf8'), 'external-editor-new');
});
