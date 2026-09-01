import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir, randomId, readJson, writeJsonAtomic } from './utils.mjs';

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function removeStaleDirectory(directory, expectedToken) {
  const quarantine = `${directory}.stale.${randomId()}`;
  try {
    await fs.rename(directory, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const moved = await readJson(path.join(quarantine, 'owner.json'), null).catch(() => null);
  if (moved?.token !== expectedToken) {
    // Another owner replaced the directory between observation and rename.
    // Restore it when possible and fail closed instead of deleting its lock.
    await fs.rename(quarantine, directory).catch(() => {});
    throw new Error('RELU AI Bridge lock changed during stale-lock recovery; retry later');
  }
  await fs.rm(quarantine, { recursive: true, force: true });
  return true;
}

async function acquireDirectory(directory, kind) {
  const token = randomId('lock_');
  const owner = { token, pid: process.pid, createdAt: new Date().toISOString(), kind };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      await writeJsonAtomic(path.join(directory, 'owner.json'), owner);
      return owner;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const current = await readJson(path.join(directory, 'owner.json'), null).catch(() => null);
      if (!current?.token || processIsAlive(current.pid)) {
        const suffix = kind === 'instance' && Number.isSafeInteger(current?.pid) ? ` by process ${current.pid}` : '';
        throw new Error(`RELU AI Bridge ${kind} lock is already held${suffix}`);
      }
      await removeStaleDirectory(directory, current.token);
    }
  }
  throw new Error(`Unable to acquire RELU AI Bridge ${kind} lock`);
}

async function releaseDirectory(directory, token) {
  const current = await readJson(path.join(directory, 'owner.json'), null).catch(() => null);
  if (current?.token !== token) return false;
  const quarantine = `${directory}.released.${randomId()}`;
  try {
    await fs.rename(directory, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const moved = await readJson(path.join(quarantine, 'owner.json'), null).catch(() => null);
  if (moved?.token !== token) {
    await fs.rename(quarantine, directory).catch(() => {});
    return false;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
  return true;
}

export async function acquireDataDirectoryLock(dataDir) {
  await ensurePrivateDir(dataDir);
  const guardDirectory = path.join(dataDir, '.instance-lock-guard');
  const lockDirectory = path.join(dataDir, '.instance-lock');
  const guard = await acquireDirectory(guardDirectory, 'coordination');
  let owner;
  try {
    owner = await acquireDirectory(lockDirectory, 'instance');
  } finally {
    await releaseDirectory(guardDirectory, guard.token);
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const releaseGuard = await acquireDirectory(guardDirectory, 'coordination');
      try {
        await releaseDirectory(lockDirectory, owner.token);
      } finally {
        await releaseDirectory(guardDirectory, releaseGuard.token);
      }
    },
  };
}
