import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-ai-bridge-test-'));
  const root = path.join(directory, 'project');
  const dataDir = path.join(directory, 'data');
  await fs.mkdir(root, { recursive: true });
  const config = {
    configPath: path.join(directory, 'config.json'),
    server: {
      host: '127.0.0.1', port: 0, auth: 'bearer', mcpAuth: 'bearer',
      token: 'relu_test_token_that_is_long_enough', maxRequestBytes: 1024 * 1024,
      allowedHttpOrigins: [], allowedChromeExtensionIds: [],
    },
    dataDir,
    perfetto: {
      enabled: true,
      tokenEnv: 'RELU_PERFETTO_CONNECTOR_TOKEN',
      token: 'perfetto_connector_token_that_is_long_enough',
      websocketPath: '/perfetto/ws',
      allowedOrigins: ['http://127.0.0.1:10000'],
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 8,
      maxWebSocketMessageBytes: 1024 * 1024,
      maxQueryBytes: 64 * 1024,
      maxQueryRows: 5_000,
      maxClients: 32,
      maxSessions: 100,
      allowedPluginIds: ['io.company.RELUPerfettoBridge'],
      allowedSqlFunctions: ['abs', 'avg', 'cast', 'coalesce', 'count', 'extract_arg', 'ifnull', 'max', 'min', 'round', 'sum'],
    },
    connectors: {
      enabled: true,
      websocketPath: '/relu/ws',
      desktopWebsocketPath: '/relu/desktop/ws',
      allowInsecureHttp: false,
      requestTimeoutMs: 5000,
      maxWebSocketMessageBytes: 1024 * 1024,
      maxContextBytes: 64 * 1024,
      maxResultBytes: 512 * 1024,
      maxSessions: 64,
      policyEpoch: 1,
      services: [],
      allowedOrigins: [],
    },
    roots: [{
      id: 'project',
      path: root,
      readOnly: false,
      protectedPaths: [
        '.git/**', '**/.env', '**/.env.*', '**/.npmrc', '**/.netrc', '**/.pypirc',
        '**/.yarnrc', '**/.yarnrc.yml', '**/.git-credentials', '**/.authinfo',
        '**/.authinfo.gpg', '**/.ssh/**', '**/.aws/**', '**/.kube/config',
        '**/.docker/config.json', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
        '**/*.jks', '**/*.keystore', '**/id_rsa', '**/id_dsa', '**/id_ecdsa',
        '**/id_ed25519', '**/*secret*', '**/*credential*', 'protected/**',
      ],
    }],
    permissions: {
      read: true,
      write: true,
      commands: true,
      sessions: true,
      goalLoop: true,
      multiAgent: true,
      allowArbitraryCommands: false,
    },
    approvals: {
      policy: 'manual',
      enforceMutatingToolGrants: true,
      allowPersistentGrants: true,
      preapprovedScopes: [],
    },
    limits: {
      maxReadBytes: 512 * 1024,
      maxWriteBytes: 1024 * 1024,
      maxSearchResults: 200,
      maxCommandOutputBytes: 1024 * 1024,
      commandTimeoutMs: 30_000,
      commandKillGraceMs: 100,
      commandSessionTtlMs: 60_000,
      maxConcurrentCommands: 4,
      maxConcurrentCommandsPerRoot: 2,
      sessionRetentionDays: 30,
      maxWorkers: 2,
      maxGoalTurns: 3,
    },
    commandProfiles: {
      echo: { program: process.execPath, args: ['-e', 'process.stdout.write("ok")'], allowExtraArgs: false, timeoutMs: 5000 },
    },
    goal: {
      mode: 'local',
      continuePrompt: 'Continue.',
      completionMarkers: ['[GOAL_COMPLETE]'],
      apiKeyEnv: 'RELU_AI_BRIDGE_GOAL_API_KEY',
    },
    privacy: { recordAudit: true, recordSessions: true, recordToolArguments: false, recordToolResults: false, maxRecordedResultBytes: 64 * 1024, redactPatterns: [] },
  };
  Object.assign(config.permissions, options.permissions ?? {});
  Object.assign(config.approvals, options.approvals ?? {});
  return {
    directory,
    root,
    dataDir,
    config,
    async cleanup() { await fs.rm(directory, { recursive: true, force: true }); },
  };
}
