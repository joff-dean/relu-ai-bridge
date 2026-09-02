import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createInitialConfig, loadConfig } from '../src/config.mjs';
import { createRedactor } from '../src/security.mjs';
import { fixture } from './helpers.mjs';

async function configFiles(env) {
  const raw = JSON.parse(await fs.readFile(new URL('../config/example.config.json', import.meta.url), 'utf8'));
  const service = JSON.parse(await fs.readFile(new URL('../config/battery-viewer.service.example.json', import.meta.url), 'utf8'));
  raw.roots[0].path = env.root;
  raw.dataDir = env.dataDir;
  raw.connectors.services = [service];
  raw.commandProfiles = {
    test: { program: 'npm', args: ['test'], allowExtraArgs: false, timeoutMs: 120_000 },
  };
  const file = path.join(env.directory, 'config.json');
  await fs.writeFile(file, JSON.stringify(raw));
  return { raw, service, file };
}

const environment = {
  RELU_AI_BRIDGE_TOKEN: 'main_control_token_that_is_long_enough',
  RELU_PERFETTO_CONNECTOR_TOKEN: 'perfetto_connector_token_that_is_long_enough',
  RELU_BATTERY_CONNECTOR_TOKEN: 'battery_connector_token_that_is_long_enough',
  RELU_LOG_API_AUTHORIZATION: 'Bearer log_api_credential_that_is_long_enough',
};

test('initial config generates separate control and Perfetto connector tokens without persisting them', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const target = path.join(env.directory, 'generated', 'local.json');
  const initialized = await createInitialConfig(target, env.root);
  assert.match(initialized.token, /^relu_[a-f0-9]{32}$/u);
  assert.match(initialized.perfettoToken, /^relu_perfetto_[a-f0-9]{32}$/u);
  assert.notEqual(initialized.token, initialized.perfettoToken);
  const raw = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(raw.perfetto.tokenEnv, 'RELU_PERFETTO_CONNECTOR_TOKEN');
  const serialized = JSON.stringify(raw);
  assert.equal(serialized.includes(initialized.token), false);
  assert.equal(serialized.includes(initialized.perfettoToken), false);
  assert.equal(raw.roots[0].readOnly, true);
  assert.equal(raw.permissions.write, false);
  assert.equal(raw.permissions.commands, false);
  assert.equal(raw.permissions.goalLoop, false);
  assert.equal(raw.permissions.multiAgent, false);
  assert.deepEqual(raw.commandProfiles, {});
  assert.deepEqual(raw.approvals.preapprovedScopes, []);
  assert.equal(raw.limits.maxConcurrentCommands, 4);
  assert.equal(raw.limits.maxConcurrentCommandsPerRoot, 2);
  assert.equal(raw.limits.commandKillGraceMs, 2_000);
  assert.equal(raw.limits.commandSessionTtlMs, 60_000);
});

test('initial config preserves an existing shared parent directory mode', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  if (process.platform === 'win32') return;
  const parent = path.join(env.directory, 'shared-config');
  await fs.mkdir(parent, { mode: 0o755 });
  await fs.chmod(parent, 0o755);
  const target = path.join(parent, 'local.json');

  await createInitialConfig(target, env.root);

  assert.equal((await fs.stat(parent)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

test('config loads a strict service registry with separate connector credential', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { file } = await configFiles(env);
  const config = await loadConfig({ configPath: file, environment });
  assert.equal(config.dataDir, env.dataDir);
  assert.equal(config.connectors.services[0].id, 'battery-viewer');
  assert.equal(config.connectors.services[0].token, environment.RELU_BATTERY_CONNECTOR_TOKEN);
  assert.equal(config.perfetto.token, environment.RELU_PERFETTO_CONNECTOR_TOKEN);
  assert.equal(config.connectors.services[0].capabilities[0].effect, 'read');
  assert.ok(config.connectors.services[0].capabilities[0].maxConcurrent >= 1);
  assert.equal(config.privacy.recordAudit, true);
  assert.equal(config.privacy.recordSessions, false);
  assert.deepEqual(config.connectors.allowedOrigins, ['https://battery.internal.example']);
  assert.equal(config.connectors.services[0].executionGuardMode, 'strict_context_version');
  const http = config.connectors.services[0].capabilities.find((item) => item.transport === 'http');
  assert.equal(http.http.auth.value, environment.RELU_LOG_API_AUTHORIZATION);
  const redacted = createRedactor(config)([
    environment.RELU_BATTERY_CONNECTOR_TOKEN,
    environment.RELU_LOG_API_AUTHORIZATION,
    environment.RELU_PERFETTO_CONNECTOR_TOKEN,
    environment.RELU_AI_BRIDGE_TOKEN,
  ].join(' '));
  assert.equal(redacted.includes('connector_token'), false);
  assert.equal(redacted.includes('log_api_credential'), false);
  assert.equal(redacted.includes('main_control_token'), false);
  assert.equal(redacted.includes('perfetto_connector_token'), false);
});

test('config normalizes exact desktop app clients and separates resource from execution guards', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, service, file } = await configFiles(env);
  service.clientKinds = ['desktop'];
  service.origins = [];
  service.desktopAppIds = ['com.relu.AndroidLogViewer'];
  service.executionGuardFields = ['payloadId', 'view'];
  service.capabilities = service.capabilities.filter((capability) => capability.transport !== 'http');
  for (const capability of service.capabilities) {
    if (capability.transport === 'browser') capability.transport = 'desktop';
  }
  await fs.writeFile(file, JSON.stringify(raw));

  const config = await loadConfig({ configPath: file, environment });
  const normalized = config.connectors.services[0];
  assert.deepEqual(normalized.clientKinds, ['desktop']);
  assert.deepEqual(normalized.desktopAppIds, ['com.relu.AndroidLogViewer']);
  assert.deepEqual(normalized.origins, []);
  assert.deepEqual(normalized.bindingFields, ['payloadId']);
  assert.deepEqual(normalized.executionGuardFields, ['payloadId', 'view']);
  assert.equal(normalized.executionGuardMode, 'projection');
  assert.equal(config.connectors.desktopWebsocketPath, '/relu/desktop/ws');
  assert.ok(normalized.capabilities.some((capability) => capability.transport === 'desktop'));
});

test('desktop connector configuration fails closed on mixed identity and guard policies', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, service, file } = await configFiles(env);
  const makeDesktop = () => {
    const value = structuredClone(service);
    value.clientKinds = ['desktop'];
    value.origins = [];
    value.desktopAppIds = ['com.relu.AndroidLogViewer'];
    value.executionGuardFields = ['payloadId', 'view'];
    value.capabilities = value.capabilities.filter((capability) => capability.transport !== 'http');
    for (const capability of value.capabilities) {
      if (capability.transport === 'browser') capability.transport = 'desktop';
    }
    return value;
  };
  const cases = [
    [(value) => { value.clientKinds = ['browser', 'desktop']; }, /clientKinds/u],
    [(value) => { value.desktopAppIds = []; }, /desktopAppIds/u],
    [(value) => { value.desktopAppIds = ['com.relu.AndroidLogViewer', 'com.relu.OtherViewer']; }, /desktopAppIds/u],
    [(value) => { value.desktopAppIds = ['bad app id']; }, /desktopAppIds/u],
    [(value) => { value.origins = ['https://battery.internal.example']; }, /origins/u],
    [(value) => { value.executionGuardFields = ['view']; }, /include every bindingFields/u],
    [(value) => { value.executionGuardFields = ['payloadId', 'selection']; }, /must be required/u],
    [(value) => { value.capabilities[0].transport = 'browser'; }, /enabled by clientKinds/u],
    [(value) => {
      value.capabilities.push(structuredClone(service.capabilities.find((capability) => capability.transport === 'http')));
    }, /only desktop capabilities/u],
  ];
  for (const [mutate, pattern] of cases) {
    const candidate = makeDesktop();
    mutate(candidate);
    raw.connectors.services = [candidate];
    await fs.writeFile(file, JSON.stringify(raw));
    await assert.rejects(() => loadConfig({ configPath: file, environment }), pattern);
  }

  raw.connectors.services = [makeDesktop()];
  raw.connectors.desktopWebsocketPath = '/relu/ws';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /desktopWebsocketPath is fixed/u);
});

test('WPF Android log viewer desktop service example is accepted by the registry', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, file } = await configFiles(env);
  const desktopService = JSON.parse(await fs.readFile(
    new URL('../config/android-log-viewer.desktop.service.example.json', import.meta.url), 'utf8',
  ));
  raw.connectors.services = [desktopService];
  await fs.writeFile(file, JSON.stringify(raw));
  const config = await loadConfig({
    configPath: file,
    environment: {
      ...environment,
      RELU_ANDROID_LOG_VIEWER_TOKEN: 'android_log_viewer_connector_token_long_enough',
    },
  });
  const [service] = config.connectors.services;
  assert.equal(service.id, 'android-log-viewer');
  assert.deepEqual(service.clientKinds, ['desktop']);
  assert.deepEqual(service.executionGuardFields, [
    'logResourceId', 'datasetRevision', 'selectionId', 'selectionRevision', 'selection',
  ]);
  assert.deepEqual(service.capabilities.map((capability) => capability.name), [
    'get_selection_stats', 'get_selection_series', 'get_log_excerpt',
    'get_extracted_sections', 'find_anomalies',
  ]);
  const series = service.capabilities.find((capability) => capability.name === 'get_selection_series');
  assert.equal(series.outputSchema.properties.series.maxItems, 6);
  assert.equal(series.outputSchema.properties.series.items.properties.points.maxItems, 1000);
});

test('approved root paths are frozen to their canonical target at startup', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  if (process.platform === 'win32') return;
  const target = path.join(env.directory, 'canonical-project');
  const link = path.join(env.directory, 'project-link');
  await fs.mkdir(target);
  await fs.symlink(target, link);
  const { raw, file } = await configFiles(env);
  raw.roots[0].path = link;
  await fs.writeFile(file, JSON.stringify(raw));

  const config = await loadConfig({ configPath: file, environment });
  assert.equal(config.roots[0].path, await fs.realpath(target));
});

test('security-sensitive booleans and connector schema bounds fail closed', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, service, file } = await configFiles(env);
  raw.connectors.allowInsecureHttp = 'false';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /must be booleans/);

  raw.connectors.allowInsecureHttp = false;
  service.capabilities[0].readOnly = 0;
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /must be booleans/);

  delete service.capabilities[0].readOnly;
  service.capabilities[0].inputSchema.properties.query = { type: 'string', maxLength: 100, pattern: '(a+)+$' };
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /pattern is unsupported/);

  service.capabilities[0].inputSchema.properties.query = { type: 'number', minimum: 10, maximum: 1 };
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /must not exceed maximum/);
});

test('command profiles normalize strict booleans, bounded strings, and timeouts', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, file } = await configFiles(env);
  raw.commandProfiles.test.allowExtraArgs = 'false';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /must be booleans/u);

  raw.commandProfiles.test.allowExtraArgs = false;
  raw.commandProfiles.test.interactive = 'false';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /must be booleans/u);

  raw.commandProfiles.test.interactive = false;
  raw.commandProfiles.test.args = [42];
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /invalid args/u);

  raw.commandProfiles.test.args = ['test'];
  raw.commandProfiles.test.timeoutMs = raw.limits.commandTimeoutMs + 1;
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /must be at most/u);
});

test('command concurrency, termination, and completed-session limits are strictly bounded', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, file } = await configFiles(env);
  const validLimits = structuredClone(raw.limits);
  const invalidCases = [
    ['commandTimeoutMs', '120000', /positive integer number/u],
    ['commandTimeoutMs', 86_400_001, /must be at most 86400000/u],
    ['maxConcurrentCommands', '4', /positive integer number/u],
    ['maxConcurrentCommands', 33, /must be at most 32/u],
    ['maxConcurrentCommandsPerRoot', 0, /positive integer number/u],
    ['commandKillGraceMs', 30_001, /must be at most 30000/u],
    ['commandSessionTtlMs', 86_400_001, /must be at most 86400000/u],
  ];
  for (const [key, value, pattern] of invalidCases) {
    raw.limits = { ...validLimits, [key]: value };
    await fs.writeFile(file, JSON.stringify(raw));
    await assert.rejects(() => loadConfig({ configPath: file, environment }), pattern);
  }

  raw.limits = { ...validLimits, maxConcurrentCommands: 2, maxConcurrentCommandsPerRoot: 3 };
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(
    () => loadConfig({ configPath: file, environment }),
    /maxConcurrentCommandsPerRoot must not exceed limits\.maxConcurrentCommands/u,
  );

  raw.limits = { ...validLimits, maxConcurrentCommands: 1 };
  delete raw.limits.maxConcurrentCommandsPerRoot;
  await fs.writeFile(file, JSON.stringify(raw));
  const loaded = await loadConfig({ configPath: file, environment });
  assert.equal(loaded.limits.maxConcurrentCommands, 1);
  assert.equal(loaded.limits.maxConcurrentCommandsPerRoot, 1);
});

test('control, service, and peer connector credentials must all be distinct', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, service, file } = await configFiles(env);
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_BATTERY_CONNECTOR_TOKEN: environment.RELU_AI_BRIDGE_TOKEN },
  }), /pairwise unique/);

  const second = structuredClone(service);
  second.id = 'battery-viewer-two';
  second.tokenEnv = 'RELU_SECOND_CONNECTOR_TOKEN';
  second.origins = ['https://battery-two.internal.example'];
  raw.connectors.services = [service, second];
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_SECOND_CONNECTOR_TOKEN: environment.RELU_BATTERY_CONNECTOR_TOKEN },
  }), /pairwise unique/);

  raw.connectors.services = [service];
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_LOG_API_AUTHORIZATION: environment.RELU_AI_BRIDGE_TOKEN },
  }), /HTTP API credentials/);
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_LOG_API_AUTHORIZATION: environment.RELU_BATTERY_CONNECTOR_TOKEN },
  }), /HTTP API credentials/);

  const duplicateHttp = structuredClone(service.capabilities.find((item) => item.transport === 'http'));
  duplicateHttp.name = 'get_summary_duplicate_credential';
  service.capabilities.push(duplicateHttp);
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /pairwise unique/u);
  service.capabilities.pop();
  await fs.writeFile(file, JSON.stringify(raw));

  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_PERFETTO_CONNECTOR_TOKEN: environment.RELU_AI_BRIDGE_TOKEN },
  }), /Perfetto connector credential/);
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_PERFETTO_CONNECTOR_TOKEN: environment.RELU_BATTERY_CONNECTOR_TOKEN },
  }), /Perfetto connector credential/);

  raw.perfetto.tokenEnv = 'RELU_BATTERY_CONNECTOR_TOKEN';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /tokenEnv must be different/u);
});

test('control and MCP endpoints cannot be configured without authentication', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, file } = await configFiles(env);
  raw.server.auth = 'none';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /server\.auth must be bearer/);

  raw.server.auth = 'bearer';
  raw.server.mcpAuth = 'none';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /server\.mcpAuth must be bearer or path/);
});

test('custom protected paths extend rather than replace mandatory credential patterns', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, file } = await configFiles(env);
  raw.roots[0].protectedPaths = ['custom-private/**'];
  await fs.writeFile(file, JSON.stringify(raw));
  const loaded = await loadConfig({ configPath: file, environment });
  assert.ok(loaded.roots[0].protectedPaths.includes('custom-private/**'));
  assert.ok(loaded.roots[0].protectedPaths.includes('**/.env'));
  assert.ok(loaded.roots[0].protectedPaths.includes('**/.npmrc'));
  assert.ok(loaded.roots[0].protectedPaths.includes('**/*.pem'));

  raw.roots[0].protectedPaths = ['valid/**', 42];
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /protectedPaths/u);
});

test('connector schema rejects unsupported keywords and proxy-shaped fields', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, service, file } = await configFiles(env);
  service.capabilities[0].inputSchema.oneOf = [{ type: 'object' }];
  raw.connectors.services = [service];
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /oneOf is unsupported/);

  delete service.capabilities[0].inputSchema.oneOf;
  service.capabilities[0].inputSchema.properties = { url: { type: 'string', maxLength: 100 } };
  service.capabilities[0].inputSchema.required = ['url'];
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({ configPath: file, environment }), /forbidden field: url/);
});

test('connector service refuses a missing or short service-specific token', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { file } = await configFiles(env);
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_BATTERY_CONNECTOR_TOKEN: 'short' },
  }), /RELU_BATTERY_CONNECTOR_TOKEN/);
});

test('enabled Perfetto connector requires its dedicated token', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { file } = await configFiles(env);
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_PERFETTO_CONNECTOR_TOKEN: 'short' },
  }), /RELU_PERFETTO_CONNECTOR_TOKEN/u);
});

test('disabled Perfetto connector does not require a token value', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, file } = await configFiles(env);
  raw.perfetto.enabled = false;
  await fs.writeFile(file, JSON.stringify(raw));
  const { RELU_PERFETTO_CONNECTOR_TOKEN: _omitted, ...withoutPerfettoToken } = environment;
  const loaded = await loadConfig({ configPath: file, environment: withoutPerfettoToken });
  assert.equal(loaded.perfetto.enabled, false);
  assert.equal(loaded.perfetto.token, undefined);
});

test('remote goal evaluator requires HTTPS and a distinct dedicated credential', async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const { raw, file } = await configFiles(env);
  raw.goal = {
    mode: 'remote',
    endpoint: 'http://goal.internal.example/v1/evaluate',
    model: 'company-goal-evaluator',
    apiKeyEnv: 'RELU_GOAL_TEST_KEY',
  };
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_GOAL_TEST_KEY: 'dedicated_goal_key_that_is_long_enough' },
  }), /credential-free HTTPS/u);

  raw.goal.endpoint = 'https://goal.internal.example/v1/evaluate';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => loadConfig({
    configPath: file,
    environment: { ...environment, RELU_GOAL_TEST_KEY: environment.RELU_AI_BRIDGE_TOKEN },
  }), /must be different/u);

  const loaded = await loadConfig({
    configPath: file,
    environment: { ...environment, RELU_GOAL_TEST_KEY: 'dedicated_goal_key_that_is_long_enough' },
  });
  assert.equal(loaded.goal.endpoint, 'https://goal.internal.example/v1/evaluate');
  assert.equal(loaded.goal.apiKeyValue, 'dedicated_goal_key_that_is_long_enough');
});
