import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const executable = fileURLToPath(new URL('../bin/relu-ai-bridge.mjs', import.meta.url));

test('CLI help is side-effect free for top-level and sensitive subcommands', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-cli-help-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  for (const args of [['--help'], ['init', '--help'], ['archive-ledger', '--help']]) {
    const { stdout, stderr } = await execFileAsync(process.execPath, [executable, ...args], { cwd: directory });
    assert.match(stdout, /Usage: relu-ai-bridge/u);
    assert.doesNotMatch(stdout, /Control\/MCP:|Perfetto connector:/u);
    assert.equal(stderr, '');
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('CLI rejects option-shaped init paths before creating files or tokens', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-cli-options-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, [executable, 'init', '--unexpected'], { cwd: directory }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Usage: relu-ai-bridge init/u);
      assert.doesNotMatch(error.stdout, /Control\/MCP:|Perfetto connector:/u);
      return true;
    },
  );
  assert.deepEqual(await fs.readdir(directory), []);
});
