import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const RUNTIME_DIRECTORY = 'relu-ai-bridge-runtime';
const RUNTIME_FILENAME = 'perfetto-local-v1.json';
const MAX_RUNTIME_BYTES = 8192;
const EXPECTED_KEYS = ['bridgeUrl', 'bridgeVersion', 'createdAt', 'instanceId', 'pid', 'token', 'version'];

function isPrivateMode(stat, expectedType) {
  if (expectedType === 'directory' && !stat.isDirectory()) return false;
  if (expectedType === 'file' && !stat.isFile()) return false;
  if (stat.isSymbolicLink()) return false;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
  return process.platform === 'win32' || (stat.mode & 0o077) === 0;
}

function assertRuntimeShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Perfetto runtime descriptor is invalid');
  if (Object.keys(value).sort().join('\0') !== EXPECTED_KEYS.join('\0')) throw new Error('Perfetto runtime descriptor fields are invalid');
  if (value.version !== 1) throw new Error('Perfetto runtime descriptor version is unsupported');
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error('Perfetto runtime descriptor PID is invalid');
  if (!/^[a-f0-9]{32}$/u.test(value.instanceId)) throw new Error('Perfetto runtime descriptor instance is invalid');
  if (typeof value.token !== 'string' || value.token.length < 24 || value.token.length > 4096) {
    throw new Error('Perfetto runtime descriptor credential is invalid');
  }
  if (value.bridgeVersion !== '0.7.0') throw new Error('Perfetto runtime descriptor product version is invalid');
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('Perfetto runtime descriptor timestamp is invalid');
  }
  let endpoint;
  try {
    endpoint = new URL(value.bridgeUrl);
  } catch {
    throw new Error('Perfetto runtime descriptor endpoint is invalid');
  }
  if (
    endpoint.protocol !== 'http:'
    || endpoint.hostname !== '127.0.0.1'
    || !/^[1-9][0-9]{0,4}$/u.test(endpoint.port)
    || Number(endpoint.port) > 65_535
    || endpoint.pathname !== '/mcp'
    || endpoint.search !== ''
    || endpoint.hash !== ''
    || endpoint.username !== ''
    || endpoint.password !== ''
  ) {
    throw new Error('Perfetto runtime descriptor endpoint is invalid');
  }
  return Object.freeze({...value});
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function perfettoRuntimeFile(tmpDirectory = os.tmpdir()) {
  return path.join(path.resolve(tmpDirectory), RUNTIME_DIRECTORY, RUNTIME_FILENAME);
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, {recursive: false, mode: 0o700}).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const stat = await fs.lstat(directory);
  if (!isPrivateMode(stat, 'directory')) {
    throw new Error('Perfetto runtime directory must be a private, user-owned directory');
  }
}

export async function readPerfettoRuntime(runtimeFile = perfettoRuntimeFile()) {
  const directory = path.dirname(runtimeFile);
  const directoryStat = await fs.lstat(directory);
  if (!isPrivateMode(directoryStat, 'directory')) {
    throw new Error('Perfetto runtime directory must be a private, user-owned directory');
  }
  const stat = await fs.lstat(runtimeFile);
  if (!isPrivateMode(stat, 'file') || stat.size < 2 || stat.size > MAX_RUNTIME_BYTES) {
    throw new Error('Perfetto runtime descriptor must be a bounded, private regular file');
  }
  const text = await fs.readFile(runtimeFile, 'utf8');
  if (Buffer.byteLength(text) > MAX_RUNTIME_BYTES) throw new Error('Perfetto runtime descriptor is too large');
  return assertRuntimeShape(JSON.parse(text));
}

export async function publishPerfettoRuntime(descriptor, runtimeFile = perfettoRuntimeFile()) {
  const value = assertRuntimeShape(descriptor);
  const directory = path.dirname(runtimeFile);
  await ensurePrivateDirectory(directory);
  let replaced = null;
  try {
    const existing = await readPerfettoRuntime(runtimeFile);
    if (existing.instanceId !== value.instanceId && processIsAlive(existing.pid)) {
      throw new Error('Another live Perfetto local stack owns the Codex runtime descriptor');
    }
    replaced = existing;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, `.${RUNTIME_FILENAME}.${value.instanceId}.tmp`);
  const body = `${JSON.stringify(value)}\n`;
  await fs.writeFile(temporary, body, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  try {
    if (process.platform === 'win32' && replaced) {
      const current = await readPerfettoRuntime(runtimeFile);
      if (current.instanceId !== replaced.instanceId || current.pid !== replaced.pid) {
        throw new Error('Perfetto runtime descriptor changed before replacement');
      }
      if (current.instanceId !== value.instanceId && processIsAlive(current.pid)) {
        throw new Error('Another live Perfetto local stack owns the Codex runtime descriptor');
      }
      await fs.unlink(runtimeFile);
    }
    await fs.rename(temporary, runtimeFile);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return runtimeFile;
}

export async function removePerfettoRuntime(instanceId, runtimeFile = perfettoRuntimeFile()) {
  try {
    const current = await readPerfettoRuntime(runtimeFile);
    if (current.instanceId !== instanceId) return false;
    await fs.unlink(runtimeFile);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function assertPerfettoRuntimeOwner(runtime) {
  if (!processIsAlive(runtime.pid)) throw new Error('Perfetto local stack is not running');
}
