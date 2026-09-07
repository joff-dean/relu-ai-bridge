import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {safeChildEnvironment} from './security.mjs';

const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;

async function regularAbsoluteFile(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const stat = await fs.lstat(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symlink`);
  return fs.realpath(value);
}

function runBounded(command, args, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: safeChildEnvironment(),
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      child.kill('SIGKILL');
      reject(new Error('Codex MCP registration command timed out'));
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => {
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (size > MAX_COMMAND_OUTPUT_BYTES) return reject(new Error('Codex MCP registration output exceeded the local size limit'));
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function isMissing(result, serverName) {
  if (result.code === 0) return false;
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) === `Error: No MCP server named '${serverName}' found.`;
}

function isExactRegistration(text, serverName, nodePath, proxyPath) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  const transport = value?.transport;
  return value?.name === serverName
    && value.enabled !== false
    && transport?.type === 'stdio'
    && transport.command === nodePath
    && Array.isArray(transport.args)
    && transport.args.length === 1
    && transport.args[0] === proxyPath
    && (transport.env === null || (transport.env && Object.keys(transport.env).length === 0))
    && (!Array.isArray(transport.env_vars) || transport.env_vars.length === 0);
}

export async function ensureCodexRegistration({
  codexCli,
  nodePath,
  proxyPath,
  serverName = 'relu-perfetto',
  spawnImpl = spawn,
} = {}) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/u.test(serverName)) throw new Error('Codex MCP server name is invalid');
  const command = await regularAbsoluteFile(codexCli, 'Codex CLI');
  const node = await regularAbsoluteFile(nodePath, 'Perfetto Node runtime');
  const proxy = await regularAbsoluteFile(proxyPath, 'RELU Codex MCP proxy');
  const getArguments = ['mcp', 'get', serverName, '--json'];
  const inspect = await runBounded(command, getArguments, spawnImpl);
  if (inspect.code === 0) {
    if (!isExactRegistration(inspect.stdout, serverName, node, proxy)) {
      throw new Error(`Codex MCP name '${serverName}' is already owned by a different registration; it was preserved`);
    }
    return {state: 'already-registered', restartRequired: false};
  }
  if (!isMissing(inspect, serverName)) throw new Error('Codex CLI could not inspect its MCP registration');

  const recheck = await runBounded(command, getArguments, spawnImpl);
  if (recheck.code === 0) {
    if (!isExactRegistration(recheck.stdout, serverName, node, proxy)) {
      throw new Error(`Codex MCP name '${serverName}' changed during registration; it was preserved`);
    }
    return {state: 'already-registered', restartRequired: false};
  }
  if (!isMissing(recheck, serverName)) throw new Error('Codex CLI could not recheck its MCP registration');

  const added = await runBounded(command, ['mcp', 'add', serverName, '--', node, proxy], spawnImpl);
  if (added.code !== 0) throw new Error('Codex CLI rejected the user-scope MCP registration');
  const verified = await runBounded(command, getArguments, spawnImpl);
  if (verified.code !== 0 || !isExactRegistration(verified.stdout, serverName, node, proxy)) {
    throw new Error('Codex MCP registration could not be verified exactly');
  }
  return {state: 'registered', restartRequired: true};
}
