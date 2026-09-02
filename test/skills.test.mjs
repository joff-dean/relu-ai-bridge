import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANAGER = path.join(REPOSITORY_ROOT, 'scripts', 'skills', 'manage-skills.mjs');
const SOURCE_SKILL = path.join(REPOSITORY_ROOT, 'skills', 'relu-analyze-selection');

function runManager(args, options = {}) {
  return spawnSync(process.execPath, [options.manager ?? MANAGER, ...args], {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    env: options.env ?? process.env,
  });
}

function createManagerFixture(t, options = {}) {
  const root = createTemporaryProject(t);
  const scriptDirectory = path.join(root, 'scripts', 'skills');
  fs.mkdirSync(scriptDirectory, { recursive: true });
  const manager = path.join(scriptDirectory, 'manage-skills.mjs');
  fs.copyFileSync(MANAGER, manager);
  fs.cpSync(path.join(REPOSITORY_ROOT, 'skills'), path.join(root, 'skills'), { recursive: true });

  const paddingFiles = options.paddingFiles ?? 0;
  if (paddingFiles > 0) {
    const manifestPath = path.join(root, 'skills', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const assets = path.join(root, 'skills', 'relu-analyze-selection', 'assets');
    fs.mkdirSync(assets);
    for (let index = 0; index < paddingFiles; index += 1) {
      const name = `assets/padding-${String(index).padStart(3, '0')}.dat`;
      const content = Buffer.alloc(options.paddingBytes ?? 256 * 1024, index % 251);
      fs.writeFileSync(path.join(root, 'skills', 'relu-analyze-selection', ...name.split('/')), content);
      manifest.skills[0].files.push({
        path: name,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        bytes: content.byteLength,
      });
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { root, manager, manifestPath: path.join(root, 'skills', 'manifest.json') };
}

function runManagerAsync(manager, args, options = {}) {
  const child = spawn(process.execPath, [manager, ...args], {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

async function waitFor(condition, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (condition()) return;
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function createTemporaryProject(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'relu-skills-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function destination(project, client) {
  return path.join(project, client === 'claude' ? '.claude' : '.agents', 'skills', 'relu-analyze-selection');
}

function markInstalledStateOld(project, client) {
  const statePath = path.join(destination(project, client), '.relu-ai-bridge-install.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.suiteVersion = '0.0.9';
  state.sourceManifestSha256 = '0'.repeat(64);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

test('Skill source manifest verifies independently of an installation', () => {
  const result = runManager(['verify-source']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified source: 1 Skill/u);
});

test('manifest and installed state reject duplicate keys and malformed UTF-8', (t) => {
  const fixture = createManagerFixture(t);
  const originalManifest = fs.readFileSync(fixture.manifestPath);
  const duplicateManifest = originalManifest.toString('utf8').replace(
    '"schemaVersion": 1,',
    '"schemaVersion": 1,\n  "schema\\u0056ersion": 1,',
  );
  assert.notEqual(duplicateManifest, originalManifest.toString('utf8'));
  fs.writeFileSync(fixture.manifestPath, duplicateManifest);
  const duplicateManifestResult = runManager(['verify-source'], { manager: fixture.manager });
  assert.notEqual(duplicateManifestResult.status, 0);
  assert.match(duplicateManifestResult.stderr, /duplicate object key/u);

  fs.writeFileSync(fixture.manifestPath, Buffer.concat([
    originalManifest.subarray(0, 12), Buffer.from([0xc3, 0x28]), originalManifest.subarray(12),
  ]));
  const invalidManifestResult = runManager(['verify-source'], { manager: fixture.manager });
  assert.notEqual(invalidManifestResult.status, 0);
  assert.match(invalidManifestResult.stderr, /not valid UTF-8 JSON/u);

  fs.writeFileSync(fixture.manifestPath, originalManifest);
  const project = path.join(fixture.root, 'workspace');
  fs.mkdirSync(project);
  const common = ['--scope', 'project', '--target', 'claude', '--project-root', project];
  const installed = runManager(['install', ...common], { manager: fixture.manager });
  assert.equal(installed.status, 0, installed.stderr);
  const statePath = path.join(destination(project, 'claude'), '.relu-ai-bridge-install.json');
  const originalState = fs.readFileSync(statePath);
  const duplicateState = originalState.toString('utf8').replace(
    '"schemaVersion": 1,',
    '"schemaVersion": 1,\n  "schema\\u0056ersion": 1,',
  );
  fs.writeFileSync(statePath, duplicateState);
  const duplicateStateResult = runManager(['verify', ...common], { manager: fixture.manager });
  assert.notEqual(duplicateStateResult.status, 0);
  assert.match(duplicateStateResult.stderr, /duplicate object key/u);

  fs.writeFileSync(statePath, Buffer.concat([
    originalState.subarray(0, 12), Buffer.from([0xf0, 0x28, 0x8c, 0x28]), originalState.subarray(12),
  ]));
  const invalidStateResult = runManager(['verify', ...common], { manager: fixture.manager });
  assert.notEqual(invalidStateResult.status, 0);
  assert.match(invalidStateResult.stderr, /not valid UTF-8 JSON/u);
});

test('pre-existing parent lock fails closed without changing a destination', (t) => {
  const project = createTemporaryProject(t);
  const parent = path.join(project, '.claude', 'skills');
  const lock = path.join(parent, '.relu-ai-bridge-skills.lock');
  fs.mkdirSync(lock, { recursive: true });
  const result = runManager(['install', '--scope', 'project', '--target', 'claude', '--project-root', project]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another Skill manager or stale lock/u);
  assert.equal(fs.existsSync(destination(project, 'claude')), false);
  assert.equal(fs.existsSync(lock), true);
});

test('concurrent managers contend on the same atomic parent lock', async (t) => {
  const fixture = createManagerFixture(t, { paddingFiles: 32, paddingBytes: 256 * 1024 });
  const project = path.join(fixture.root, 'workspace');
  fs.mkdirSync(project);
  const both = ['--scope', 'project', '--target', 'both', '--project-root', project];
  const installed = runManager(['install', ...both], { manager: fixture.manager });
  assert.equal(installed.status, 0, installed.stderr);
  markInstalledStateOld(project, 'claude');
  markInstalledStateOld(project, 'codex');

  const first = runManagerAsync(fixture.manager, ['install', ...both]);
  const claudeLock = path.join(project, '.claude', 'skills', '.relu-ai-bridge-skills.lock');
  await waitFor(() => fs.existsSync(claudeLock), 'the first manager to acquire its parent lock');
  const second = runManager([
    'install', '--scope', 'project', '--target', 'claude', '--project-root', project,
  ], { manager: fixture.manager });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /another Skill manager or stale lock/u);

  const firstResult = await first.completed;
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(fs.existsSync(claudeLock), false);
});

test('destination edit during staging is detected before replacement', async (t) => {
  const fixture = createManagerFixture(t, { paddingFiles: 32, paddingBytes: 256 * 1024 });
  const project = path.join(fixture.root, 'workspace');
  fs.mkdirSync(project);
  const common = ['--scope', 'project', '--target', 'claude', '--project-root', project];
  const installed = runManager(['install', ...common], { manager: fixture.manager });
  assert.equal(installed.status, 0, installed.stderr);
  markInstalledStateOld(project, 'claude');

  const target = destination(project, 'claude');
  const parent = path.dirname(target);
  const update = runManagerAsync(fixture.manager, ['install', ...common]);
  await waitFor(
    () => fs.readdirSync(parent).some((entry) => entry.startsWith('.relu-analyze-selection.staging-')),
    'a staged replacement',
  );
  fs.appendFileSync(path.join(target, 'SKILL.md'), '\nedit-during-stage\n');
  const result = await update.completed;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /(checksum does not match|changed after preflight)/u);
  assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /edit-during-stage/u);
  assert.equal(fs.readdirSync(parent).some((entry) => entry.includes('.backup-')), false);
});

test('rollback never deletes a newly installed destination changed after staging', async (t) => {
  const fixture = createManagerFixture(t, { paddingFiles: 64, paddingBytes: 256 * 1024 });
  const project = path.join(fixture.root, 'workspace');
  fs.mkdirSync(project);
  const common = ['--scope', 'project', '--target', 'both', '--project-root', project];
  const installed = runManager(['install', ...common], { manager: fixture.manager });
  assert.equal(installed.status, 0, installed.stderr);
  markInstalledStateOld(project, 'claude');
  markInstalledStateOld(project, 'codex');

  const claudeTarget = destination(project, 'claude');
  const codexTarget = destination(project, 'codex');
  const update = runManagerAsync(fixture.manager, ['install', ...common]);
  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(claudeTarget, '.relu-ai-bridge-install.json'), 'utf8'));
    return state.suiteVersion === '0.1.0' && state.sourceManifestSha256 !== '0'.repeat(64);
  }, 'the new Claude destination to be committed');

  fs.appendFileSync(path.join(claudeTarget, 'SKILL.md'), '\nnew-destination-edit\n');
  fs.appendFileSync(path.join(codexTarget, 'SKILL.md'), '\nforce-later-target-failure\n');
  const result = await update.completed;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback incomplete/u);
  assert.match(fs.readFileSync(path.join(claudeTarget, 'SKILL.md'), 'utf8'), /new-destination-edit/u);
  const claudeParent = path.dirname(claudeTarget);
  assert.equal(fs.readdirSync(claudeParent).some((entry) => entry.includes('.backup-')), true);
});

test('changed uninstall removal is retained instead of recursively deleted', async (t) => {
  const fixture = createManagerFixture(t, { paddingFiles: 32, paddingBytes: 256 * 1024 });
  const project = path.join(fixture.root, 'workspace');
  fs.mkdirSync(project);
  const common = ['--scope', 'project', '--target', 'claude', '--project-root', project];
  const installed = runManager(['install', ...common], { manager: fixture.manager });
  assert.equal(installed.status, 0, installed.stderr);

  const target = destination(project, 'claude');
  const parent = path.dirname(target);
  const removalProcess = runManagerAsync(fixture.manager, ['uninstall', ...common]);
  let removal;
  await waitFor(() => {
    const entry = fs.readdirSync(parent).find((name) => name.includes('.removing-'));
    if (!entry) return false;
    removal = path.join(parent, entry);
    return true;
  }, 'the uninstall removal directory');
  fs.appendFileSync(path.join(removal, 'SKILL.md'), '\nremoval-edit\n');
  const result = await removalProcess.completed;
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(removal), true);
  assert.match(fs.readFileSync(path.join(removal, 'SKILL.md'), 'utf8'), /removal-edit/u);
});

test('project install supports Claude and Codex, verifies, is idempotent, and uninstalls', (t) => {
  const project = createTemporaryProject(t);
  const installArguments = ['install', '--scope', 'project', '--target', 'both', '--project-root', project];
  const first = runManager(installArguments);
  assert.equal(first.status, 0, first.stderr);

  const targets = ['claude', 'codex'].map((client) => destination(project, client));
  for (const target of targets) {
    assert.equal(fs.lstatSync(target).isDirectory(), true);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(path.join(target, 'SKILL.md')), fs.readFileSync(path.join(SOURCE_SKILL, 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(target, '.relu-ai-bridge-install.json')), true);
  }

  const stateTimes = targets.map((target) => fs.statSync(path.join(target, '.relu-ai-bridge-install.json')).mtimeMs);
  const second = runManager(installArguments);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /current claude/u);
  assert.match(second.stdout, /current codex/u);
  assert.deepEqual(
    targets.map((target) => fs.statSync(path.join(target, '.relu-ai-bridge-install.json')).mtimeMs),
    stateTimes,
  );

  const verify = runManager(['verify', '--scope', 'project', '--target', 'both', '--project-root', project]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /verified claude/u);
  assert.match(verify.stdout, /verified codex/u);

  const uninstall = runManager(['uninstall', '--scope', 'project', '--target', 'both', '--project-root', project]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  for (const target of targets) assert.equal(fs.existsSync(target), false);
});

test('user scope maps to Claude and Codex discovery directories', (t) => {
  const userHome = createTemporaryProject(t);
  const environment = { ...process.env, HOME: userHome, USERPROFILE: userHome };
  const install = runManager(['install', '--scope', 'user', '--target', 'both'], { env: environment });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.existsSync(path.join(userHome, '.claude', 'skills', 'relu-analyze-selection', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(userHome, '.agents', 'skills', 'relu-analyze-selection', 'SKILL.md')), true);

  const verify = runManager(['verify', '--scope', 'user', '--target', 'both'], { env: environment });
  assert.equal(verify.status, 0, verify.stderr);
  const uninstall = runManager(['uninstall', '--scope', 'user', '--target', 'both'], { env: environment });
  assert.equal(uninstall.status, 0, uninstall.stderr);
});

test('modified managed Skill blocks update and uninstall without changing the other target', (t) => {
  const project = createTemporaryProject(t);
  const common = ['--scope', 'project', '--target', 'both', '--project-root', project];
  const installed = runManager(['install', ...common]);
  assert.equal(installed.status, 0, installed.stderr);

  const claudeSkill = destination(project, 'claude');
  const codexSkill = destination(project, 'codex');
  const claudeEntrypoint = path.join(claudeSkill, 'SKILL.md');
  const codexState = path.join(codexSkill, '.relu-ai-bridge-install.json');
  const codexStateBefore = fs.readFileSync(codexState);
  fs.appendFileSync(claudeEntrypoint, '\nlocal modification\n');

  const update = runManager(['install', ...common]);
  assert.notEqual(update.status, 0);
  assert.match(update.stderr, /checksum does not match/u);
  assert.match(fs.readFileSync(claudeEntrypoint, 'utf8'), /local modification/u);
  assert.deepEqual(fs.readFileSync(codexState), codexStateBefore);

  const uninstall = runManager(['uninstall', ...common]);
  assert.notEqual(uninstall.status, 0);
  assert.equal(fs.existsSync(claudeSkill), true);
  assert.equal(fs.existsSync(codexSkill), true);
});

test('unmanaged destination is never overwritten', (t) => {
  const project = createTemporaryProject(t);
  const target = destination(project, 'claude');
  fs.mkdirSync(target, { recursive: true });
  const entrypoint = path.join(target, 'SKILL.md');
  fs.writeFileSync(entrypoint, 'user-owned skill\n');

  const result = runManager(['install', '--scope', 'project', '--target', 'claude', '--project-root', project]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required file does not exist/u);
  assert.equal(fs.readFileSync(entrypoint, 'utf8'), 'user-owned skill\n');
  assert.equal(fs.existsSync(path.join(target, '.relu-ai-bridge-install.json')), false);
});

test('a valid older managed state upgrades through staged replacement', (t) => {
  const project = createTemporaryProject(t);
  const common = ['--scope', 'project', '--target', 'claude', '--project-root', project];
  const installed = runManager(['install', ...common]);
  assert.equal(installed.status, 0, installed.stderr);

  const statePath = path.join(destination(project, 'claude'), '.relu-ai-bridge-install.json');
  const oldState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  oldState.suiteVersion = '0.0.9';
  oldState.sourceManifestSha256 = '0'.repeat(64);
  fs.writeFileSync(statePath, `${JSON.stringify(oldState, null, 2)}\n`);

  const update = runManager(['install', ...common]);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /updated claude/u);
  const verify = runManager(['verify', ...common]);
  assert.equal(verify.status, 0, verify.stderr);
});

test('invalid paths and force-like options fail closed', (t) => {
  const missingProject = path.join(createTemporaryProject(t), 'does-not-exist');
  const missing = runManager(['install', '--scope', 'project', '--target', 'claude', '--project-root', missingProject]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /installation base does not exist/u);
  assert.equal(fs.existsSync(missingProject), false);

  const force = runManager(['install', '--force', 'true']);
  assert.notEqual(force.status, 0);
  assert.match(force.stderr, /invalid option/u);
});
