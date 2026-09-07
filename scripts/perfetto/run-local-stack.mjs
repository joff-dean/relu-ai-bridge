#!/usr/bin/env node

import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {ensureCodexRegistration} from '../../src/codex-registration.mjs';
import {
  perfettoRuntimeFile,
  publishPerfettoRuntime,
  removePerfettoRuntime,
} from '../../src/perfetto-codex-runtime.mjs';
import {createPerfettoLocalProxy} from '../../src/perfetto-local-stack.mjs';
import {createApplication} from '../../src/server.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 5 * 60_000;

function parsePositiveInteger(value, name, maximum = 65_535) {
  if (!/^[1-9][0-9]*$/u.test(String(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return parsed;
}

export function parseLocalStackArgs(argv) {
  if (argv.length < 1) throw new Error('PERFETTO_DIR is required');
  const result = {
    perfettoDir: path.resolve(argv[0]),
    instances: 1,
    uiPort: 10_000,
    upstreamPort: 11_000,
    bridgePort: 5_746,
    codexCli: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === '--instances') {
      result.instances = parsePositiveInteger(value, option, 8);
    } else if (option === '--ui-port') {
      result.uiPort = parsePositiveInteger(value, option);
    } else if (option === '--upstream-port') {
      result.upstreamPort = parsePositiveInteger(value, option);
    } else if (option === '--bridge-port') {
      result.bridgePort = parsePositiveInteger(value, option);
    } else if (option === '--codex-cli') {
      if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${option} requires an absolute path`);
      result.codexCli = path.resolve(value);
    } else {
      throw new Error(`Unsupported option: ${option}`);
    }
    index += 1;
  }
  const ports = new Set([result.bridgePort, result.upstreamPort]);
  if (ports.size !== 2) throw new Error('Local stack ports overlap or exceed 65535');
  for (let index = 0; index < result.instances; index += 1) {
    const port = result.uiPort + index;
    if (port > 65_535 || ports.has(port)) throw new Error('Local stack ports overlap or exceed 65535');
    ports.add(port);
  }
  return result;
}

function randomCredential(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

function waitForHttp(port, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onExit = (code, signal) => fail(new Error(
      `Perfetto UI exited during startup (${signal ?? code ?? 'unknown'})`,
    ));
    child.once('exit', onExit);
    const probe = () => {
      if (settled) return;
      const request = http.get({
        host: LOOPBACK_HOST,
        port,
        path: '/',
        timeout: 1000,
      }, (response) => {
        response.resume();
        if (settled) return;
        settled = true;
        child.off('exit', onExit);
        resolve();
      });
      request.once('timeout', () => request.destroy());
      request.once('error', () => {
        if (Date.now() >= deadline) {
          fail(new Error(`Perfetto UI startup timed out on port ${port}`));
        } else {
          setTimeout(probe, 250);
        }
      });
    };
    probe();
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const options = parseLocalStackArgs(process.argv.slice(2));
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-perfetto-stack-'));
  await fs.chmod(runtimeDir, 0o700);
  const configPath = path.join(runtimeDir, 'config.json');
  const controlToken = randomCredential('relu_runtime_');
  const connectorToken = randomCredential('relu_perfetto_runtime_');
  const instanceId = crypto.randomBytes(16).toString('hex');
  const runtimeFile = perfettoRuntimeFile();
  const proxyPath = fileURLToPath(new URL('./codex-mcp-proxy.mjs', import.meta.url));
  const analysisSchemaPath = fileURLToPath(new URL('./analysis-output.schema.json', import.meta.url));
  const origins = Array.from({length: options.instances}, (_, index) =>
    `http://${LOOPBACK_HOST}:${options.uiPort + index}`);
  const config = {
    server: {
      host: LOOPBACK_HOST,
      port: options.bridgePort,
      auth: 'bearer',
      mcpAuth: 'bearer',
      allowedHttpOrigins: origins,
      allowedChromeExtensionIds: [],
    },
    dataDir: path.join(runtimeDir, 'data'),
    connectors: {enabled: false, services: []},
    perfetto: {
      enabled: true,
      tokenEnv: 'RELU_PERFETTO_CONNECTOR_TOKEN',
      allowedOrigins: origins,
      allowedPluginIds: ['io.company.RELUPerfettoBridge'],
    },
    roots: [{id: 'perfetto', path: options.perfettoDir, readOnly: true}],
    permissions: {
      read: true,
      write: false,
      commands: false,
      sessions: true,
      goalLoop: false,
      multiAgent: false,
      allowArbitraryCommands: false,
    },
    approvals: {policy: 'trusted_always', allowPersistentGrants: false},
    privacy: {
      recordAudit: false,
      recordSessions: false,
      recordToolArguments: false,
      recordToolResults: false,
    },
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });

  const perfettoNode = path.join(
    options.perfettoDir,
    'ui',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  if (options.codexCli) {
    const registration = await ensureCodexRegistration({
      codexCli: options.codexCli,
      nodePath: perfettoNode,
      proxyPath,
    });
    process.stdout.write(registration.restartRequired
      ? 'Codex MCP registered; restart Codex once to load relu-perfetto\n'
      : 'Codex MCP registration already matches relu-perfetto\n');
  }

  let app;
  try {
    app = await createApplication({
      configPath,
      perfettoAnalysis: options.codexCli ? {
        codexCli: options.codexCli,
        nodePath: perfettoNode,
        proxyPath,
        schemaPath: analysisSchemaPath,
        cwd: path.join(runtimeDir, 'analysis-workspace'),
        outputDir: path.join(runtimeDir, 'analysis-output'),
      } : null,
      environment: {
        ...process.env,
        RELU_AI_BRIDGE_TOKEN: controlToken,
        RELU_PERFETTO_CONNECTOR_TOKEN: connectorToken,
      },
    });
  } catch (error) {
    await fs.rm(runtimeDir, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
  const children = [];
  const proxies = [];
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled(proxies.map((proxy) => proxy.close()));
    await Promise.allSettled(children.map(stopChild));
    await removePerfettoRuntime(instanceId, runtimeFile).catch(() => {});
    await app.close().catch(() => {});
    await fs.rm(runtimeDir, {recursive: true, force: true}).catch(() => {});
  };

  try {
    await app.listen();
    await publishPerfettoRuntime({
      version: 1,
      instanceId,
      pid: process.pid,
      bridgeUrl: `http://${LOOPBACK_HOST}:${options.bridgePort}/mcp`,
      bridgeVersion: '0.7.0',
      token: controlToken,
      createdAt: new Date().toISOString(),
    }, runtimeFile);
    const child = spawn(
      perfettoNode,
      [
        path.join(options.perfettoDir, 'ui', 'build.mjs'),
        '--only-wasm-memory64',
        '--serve',
        '--watch',
        '--serve-host', LOOPBACK_HOST,
        '--serve-port', String(options.upstreamPort),
        '--bundle',
        '--title', 'RELU Perfetto',
      ],
      {stdio: ['ignore', 'inherit', 'inherit'], shell: false},
    );
    children.push(child);
    await waitForHttp(options.upstreamPort, child);
    for (let index = 0; index < options.instances; index += 1) {
      const proxy = createPerfettoLocalProxy({
        publicPort: options.uiPort + index,
        upstreamPort: options.upstreamPort,
        bridgePort: options.bridgePort,
        connectorToken,
      });
      await proxy.listen();
      proxies.push(proxy);
    }
    process.stdout.write('RELU Perfetto local stack ready (token input is not required)\n');
    for (const origin of origins) process.stdout.write(`${origin}\n`);
    process.once('SIGINT', () => void stop().then(() => process.exit(0)));
    process.once('SIGTERM', () => void stop().then(() => process.exit(0)));
    await new Promise((resolve, reject) => {
      for (const child of children) {
        child.once('exit', (code, signal) => {
          if (!stopping) reject(new Error(
            `Perfetto UI stopped unexpectedly (${signal ?? code ?? 'unknown'})`,
          ));
        });
      }
    });
  } finally {
    await stop();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`RELU Perfetto local stack failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
