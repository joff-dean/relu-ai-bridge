#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {
  perfettoRuntimeFile,
  publishPerfettoRuntime,
  removePerfettoRuntime,
} from '../../src/perfetto-runtime.mjs';
import {createApplication} from '../../src/server.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PORT = 5746;
const EXTENSION_ID = /^[a-p]{32}$/u;

function parsePort(value) {
  if (!/^[1-9][0-9]{0,4}$/u.test(String(value))) throw new Error('--bridge-port is invalid');
  const port = Number(value);
  if (port > 65_535) throw new Error('--bridge-port is invalid');
  return port;
}

function parseOrigin(value) {
  const parsed = new URL(String(value));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) {
    throw new Error('--origin must be an exact HTTP(S) origin');
  }
  return parsed.origin;
}

export function parseExtensionBridgeArgs(argv) {
  const result = {extensionId: '', origin: '', bridgePort: DEFAULT_BRIDGE_PORT};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string') throw new Error(`${option ?? 'option'} requires a value`);
    if (option === '--extension-id') {
      if (result.extensionId) throw new Error('--extension-id may be specified only once');
      result.extensionId = value;
    } else if (option === '--origin') {
      if (result.origin) throw new Error('--origin may be specified only once');
      result.origin = parseOrigin(value);
    }
    else if (option === '--bridge-port') result.bridgePort = parsePort(value);
    else throw new Error(`Unsupported option: ${option}`);
  }
  if (!EXTENSION_ID.test(result.extensionId)) throw new Error('--extension-id is invalid');
  if (!result.origin) throw new Error('Exactly one --origin is required');
  return Object.freeze(result);
}

function credential(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

export async function runExtensionBridge(
  argv,
  {input = process.stdin, output = process.stdout, environment = process.env} = {},
) {
  const options = parseExtensionBridgeArgs(argv);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-perfetto-extension-'));
  await fs.chmod(temporaryDirectory, 0o700);
  const workspace = path.join(temporaryDirectory, 'workspace');
  await fs.mkdir(workspace, {mode: 0o700});
  const configPath = path.join(temporaryDirectory, 'config.json');
  const controlToken = credential('relu_control_');
  const connectorToken = credential('relu_perfetto_');
  const instanceId = crypto.randomBytes(16).toString('hex');
  const runtimeFile = perfettoRuntimeFile();
  const config = {
    server: {
      host: LOOPBACK_HOST,
      port: options.bridgePort,
      auth: 'bearer',
      mcpAuth: 'bearer',
      allowedHttpOrigins: [],
      allowedChromeExtensionIds: [options.extensionId],
    },
    dataDir: path.join(temporaryDirectory, 'data'),
    connectors: {enabled: false, services: []},
    perfetto: {
      enabled: true,
      tokenEnv: 'RELU_PERFETTO_CONNECTOR_TOKEN',
      allowedOrigins: [options.origin],
      allowedPluginIds: ['io.company.RELUPerfettoBridge'],
    },
    roots: [{id: 'runtime', path: workspace, readOnly: true}],
    permissions: {
      read: false,
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
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, {mode: 0o600, flag: 'wx'});

  let app;
  let published = false;
  try {
    app = await createApplication({
      configPath,
      environment: {
        ...environment,
        RELU_AI_BRIDGE_TOKEN: controlToken,
        RELU_PERFETTO_CONNECTOR_TOKEN: connectorToken,
      },
    });
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
    published = true;
    output.write(`${JSON.stringify({
      version: 1,
      endpoint: `ws://${LOOPBACK_HOST}:${options.bridgePort}/perfetto/extension-ws`,
      token: connectorToken,
    })}\n`);
    await new Promise((resolve, reject) => {
      input.once('end', resolve);
      input.once('close', resolve);
      input.once('error', reject);
      input.resume();
    });
  } finally {
    if (published) await removePerfettoRuntime(instanceId, runtimeFile).catch(() => {});
    await app?.close().catch(() => {});
    await fs.rm(temporaryDirectory, {recursive: true, force: true}).catch(() => {});
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runExtensionBridge(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`RELU Perfetto Extension bridge failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
