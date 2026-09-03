import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandHome, parsePositiveInteger, randomId, readJson, writeJsonAtomic } from './utils.mjs';

const DEFAULT_PROTECTED = [
  '.git/**',
  '.github/workflows/**',
  '**/.env',
  '**/.env.*',
  '**/.npmrc',
  '**/.netrc',
  '**/.pypirc',
  '**/.yarnrc',
  '**/.yarnrc.yml',
  '**/.git-credentials',
  '**/.authinfo',
  '**/.authinfo.gpg',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.kube/config',
  '**/.docker/config.json',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa',
  '**/id_dsa',
  '**/id_ecdsa',
  '**/id_ed25519',
  '**/*secret*',
  '**/*credential*',
];

const DEFAULT_SAFE_PERFETTO_SQL_FUNCTIONS = [
  'abs', 'avg', 'cast', 'coalesce', 'count', 'date', 'datetime',
  'dense_rank', 'extract_arg', 'first_value', 'glob',
  'ifnull', 'iif', 'instr', 'julianday', 'lag',
  'last_value', 'lead', 'length', 'like', 'likely', 'lower', 'ltrim',
  'max', 'min', 'nth_value', 'ntile', 'nullif', 'percent_rank',
  'rank', 'round', 'row_number', 'rtrim',
  'sign', 'strftime', 'str_split', 'substr', 'substring', 'sum', 'time',
  'total', 'trim', 'typeof', 'unicode', 'unixepoch', 'unlikely', 'upper',
];

const CONNECTOR_ID = /^[a-z][a-z0-9_-]{1,63}$/u;
const CAPABILITY_NAME = /^[a-z][a-z0-9_.-]{0,63}$/u;
const DESKTOP_APP_ID = /^[a-zA-Z][a-zA-Z0-9._-]{2,127}$/u;
const HEADER_NAME = /^[a-z0-9-]{1,64}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const APPROVAL_POLICIES = new Set(['trusted_always', 'manual']);
const APPROVAL_CONFIG_KEYS = new Set([
  'policy',
  'allowPersistentGrants',
  'preapprovedScopes',
  'pendingTtlMs',
  'maxPending',
]);
const INITIAL_APPROVAL_POLICY = 'trusted_always';
const FORBIDDEN_OUTBOUND_HEADERS = new Set([
  'connection', 'content-length', 'cookie', 'host', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const FORBIDDEN_CAPABILITY_FIELDS = /^(?:url|uri|method|headers?|authorization|cookie|selector|script|javascript|code|command|program|redirect)$/iu;
const SCHEMA_COMMON_KEYS = new Set(['type', 'description', 'enum']);

function validateConnectorSchema(schema, name, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 12) {
    throw new Error(`${name} must be a bounded JSON Schema object`);
  }
  const allowedByType = {
    object: new Set([...SCHEMA_COMMON_KEYS, 'properties', 'required', 'additionalProperties']),
    array: new Set([...SCHEMA_COMMON_KEYS, 'items', 'minItems', 'maxItems']),
    string: new Set([...SCHEMA_COMMON_KEYS, 'minLength', 'maxLength']),
    integer: new Set([...SCHEMA_COMMON_KEYS, 'minimum', 'maximum']),
    number: new Set([...SCHEMA_COMMON_KEYS, 'minimum', 'maximum']),
    boolean: SCHEMA_COMMON_KEYS,
  };
  const allowed = allowedByType[schema.type];
  if (!allowed) throw new Error(`${name}.type is unsupported`);
  for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new Error(`${name}.${key} is unsupported`);
  if (schema.description !== undefined && (typeof schema.description !== 'string' || Buffer.byteLength(schema.description) > 500)) {
    throw new Error(`${name}.description is invalid`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100)) {
    throw new Error(`${name}.enum is invalid`);
  }
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) throw new Error(`${name}.additionalProperties must be false`);
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new Error(`${name}.properties must be an object`);
    }
    if (Object.keys(schema.properties).length > 100) throw new Error(`${name}.properties has too many entries`);
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(key) || FORBIDDEN_CAPABILITY_FIELDS.test(key)) {
        throw new Error(`${name}.properties contains a forbidden field: ${key}`);
      }
      validateConnectorSchema(child, `${name}.properties.${key}`, depth + 1);
    }
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.length > Object.keys(schema.properties).length
      || required.some((key) => !Object.hasOwn(schema.properties, key))) {
      throw new Error(`${name}.required must list declared properties`);
    }
  }
  if (schema.type === 'array') {
    if (!Number.isSafeInteger(schema.maxItems) || schema.maxItems < 0 || schema.maxItems > 1000) {
      throw new Error(`${name}.maxItems must be between 0 and 1000`);
    }
    if (schema.minItems !== undefined && (!Number.isSafeInteger(schema.minItems) || schema.minItems < 0 || schema.minItems > schema.maxItems)) {
      throw new Error(`${name}.minItems is invalid`);
    }
    validateConnectorSchema(schema.items, `${name}.items`, depth + 1);
  }
  if (schema.type === 'string') {
    if (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 0 || schema.maxLength > 65_536) {
      throw new Error(`${name}.maxLength must be between 0 and 65536`);
    }
    if (schema.minLength !== undefined && (!Number.isSafeInteger(schema.minLength) || schema.minLength < 0 || schema.minLength > schema.maxLength)) {
      throw new Error(`${name}.minLength is invalid`);
    }
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && (typeof schema.minimum !== 'number' || !Number.isFinite(schema.minimum))) {
      throw new Error(`${name}.minimum must be a finite number`);
    }
    if (schema.maximum !== undefined && (typeof schema.maximum !== 'number' || !Number.isFinite(schema.maximum))) {
      throw new Error(`${name}.maximum must be a finite number`);
    }
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
      throw new Error(`${name}.minimum must not exceed maximum`);
    }
  }
  return schema;
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Security-sensitive configuration flags must be booleans');
  return value;
}

function normalizeApprovals(value) {
  const approvals = value === undefined ? {} : value;
  if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) {
    throw new Error('approvals must be an object');
  }
  for (const key of Object.keys(approvals)) {
    if (!APPROVAL_CONFIG_KEYS.has(key)) throw new Error(`approvals.${key} is unsupported`);
  }
  const policy = approvals.policy === undefined
    ? INITIAL_APPROVAL_POLICY
    : approvals.policy;
  if (typeof policy !== 'string' || !APPROVAL_POLICIES.has(policy)) {
    throw new Error('approvals.policy must be trusted_always or manual');
  }
  return { approvals, policy };
}

function boundedPositiveInteger(value, fallback, maximum, name) {
  const parsed = parsePositiveInteger(value, fallback, name);
  if (parsed > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return parsed;
}

function strictBoundedPositiveInteger(value, fallback, maximum, name) {
  const parsed = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer number`);
  if (parsed > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return parsed;
}

function normalizeRoot(root, index) {
  if (!root || typeof root !== 'object') throw new Error(`roots[${index}] must be an object`);
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(root.id ?? '')) throw new Error(`roots[${index}].id is invalid`);
  if (!path.isAbsolute(root.path ?? '')) throw new Error(`roots[${index}].path must be absolute`);
  const customProtected = root.protectedPaths ?? [];
  if (!Array.isArray(customProtected) || customProtected.length > 200 || customProtected.some((pattern) => (
    typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 512 || pattern.includes('\0')
  ))) throw new Error(`roots[${index}].protectedPaths must contain at most 200 bounded strings`);
  return {
    id: root.id,
    path: path.resolve(root.path),
    readOnly: bool(root.readOnly, false),
    protectedPaths: [...new Set([...DEFAULT_PROTECTED, ...customProtected])],
  };
}

function exactHttpOrigin(value, name) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2048) {
    throw new Error(`${name} must be a bounded exact HTTP(S) origin`);
  }
  const parsed = new URL(String(value));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== String(value)) {
    throw new Error(`${name} must be an exact HTTP(S) origin: ${value}`);
  }
  return parsed.origin;
}

function normalizeCapability(capability, serviceId, index, allowInsecureHttp, environment) {
  const prefix = `connectors.services[${serviceId}].capabilities[${index}]`;
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new Error(`${prefix} must be an object`);
  }
  const name = String(capability.name ?? '');
  if (!CAPABILITY_NAME.test(name)) throw new Error(`${prefix}.name is invalid`);
  const transport = capability.transport ?? 'browser';
  if (!['browser', 'desktop', 'http'].includes(transport)) {
    throw new Error(`${prefix}.transport must be browser, desktop, or http`);
  }
  const description = String(capability.description ?? name);
  if (!description || Buffer.byteLength(description) > 500) throw new Error(`${prefix}.description is invalid`);
  const inputSchema = capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false };
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema) || inputSchema.type !== 'object') {
    throw new Error(`${prefix}.inputSchema must be an object JSON Schema`);
  }
  validateConnectorSchema(inputSchema, `${prefix}.inputSchema`);
  const outputSchema = capability.outputSchema ?? { type: 'object', properties: {}, required: [], additionalProperties: false };
  validateConnectorSchema(outputSchema, `${prefix}.outputSchema`);
  const normalized = {
    name,
    description,
    transport,
    readOnly: bool(capability.readOnly, true),
    effect: capability.effect ?? (capability.readOnly === false ? 'external_side_effect' : 'read'),
    inputSchema: structuredClone(inputSchema),
    outputSchema: structuredClone(outputSchema),
    timeoutMs: boundedPositiveInteger(capability.timeoutMs, 30_000, 60_000, `${prefix}.timeoutMs`),
    maxConcurrent: boundedPositiveInteger(
      capability.maxConcurrent,
      (capability.effect ?? (capability.readOnly === false ? 'external_side_effect' : 'read')) === 'read' ? 4 : 1,
      16,
      `${prefix}.maxConcurrent`,
    ),
  };
  if (!['read', 'ui_mutation', 'data_mutation', 'external_side_effect'].includes(normalized.effect)) {
    throw new Error(`${prefix}.effect is invalid`);
  }
  if (normalized.effect !== 'read') normalized.readOnly = false;
  if (transport === 'http') {
    const http = capability.http;
    if (!http || typeof http !== 'object' || Array.isArray(http)) throw new Error(`${prefix}.http is required`);
    const endpoint = new URL(String(http.url ?? ''));
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error(`${prefix}.http.url must be an absolute HTTP(S) URL without credentials or a fragment`);
    }
    if (endpoint.protocol === 'http:' && !allowInsecureHttp) {
      throw new Error(`${prefix}.http.url requires HTTPS unless connectors.allowInsecureHttp is true`);
    }
    const method = String(http.method ?? 'POST').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new Error(`${prefix}.http.method must be GET or POST`);
    let auth = null;
    if (http.auth !== undefined) {
      const header = String(http.auth?.header ?? 'authorization').toLowerCase();
      const env = String(http.auth?.env ?? '');
      if (!HEADER_NAME.test(header) || FORBIDDEN_OUTBOUND_HEADERS.has(header)) {
        throw new Error(`${prefix}.http.auth.header is not allowed`);
      }
      if (!ENV_NAME.test(env)) throw new Error(`${prefix}.http.auth.env is invalid`);
      const value = environment[env];
      if (typeof value !== 'string' || value.length === 0) throw new Error(`${env} must contain the connector API credential`);
      auth = { header, env, value };
    }
    normalized.http = {
      url: endpoint.toString(),
      method,
      auth,
      timeoutMs: boundedPositiveInteger(http.timeoutMs, 15_000, 60_000, `${prefix}.http.timeoutMs`),
    };
  }
  return normalized;
}

function normalizeConnectorService(service, index, allowInsecureHttp, environment) {
  const prefix = `connectors.services[${index}]`;
  if (!service || typeof service !== 'object' || Array.isArray(service)) throw new Error(`${prefix} must be an object`);
  const id = String(service.id ?? '');
  if (!CONNECTOR_ID.test(id)) throw new Error(`${prefix}.id is invalid`);
  const displayName = String(service.displayName ?? id);
  if (!displayName || Buffer.byteLength(displayName) > 200) throw new Error(`${prefix}.displayName is invalid`);
  const tokenEnv = String(service.tokenEnv ?? '');
  if (!ENV_NAME.test(tokenEnv)) throw new Error(`${prefix}.tokenEnv is invalid`);
  const token = String(environment[tokenEnv] ?? '');
  if (token.length < 24) throw new Error(`${tokenEnv} must contain at least 24 characters for connector service ${id}`);
  const clientKinds = service.clientKinds ?? ['browser'];
  if (!Array.isArray(clientKinds) || clientKinds.length !== 1
    || clientKinds.some((kind) => !['browser', 'desktop'].includes(kind))
    || new Set(clientKinds).size !== clientKinds.length) {
    throw new Error(`${prefix}.clientKinds must contain exactly one of browser or desktop`);
  }
  const origins = service.origins ?? [];
  if (!Array.isArray(origins) || origins.length > 32
    || (clientKinds.includes('browser') && origins.length === 0)
    || (!clientKinds.includes('browser') && origins.length > 0)) {
    throw new Error(`${prefix}.origins must contain 1 to 32 exact origins only for browser clients`);
  }
  const desktopAppIds = service.desktopAppIds ?? [];
  if (!Array.isArray(desktopAppIds) || desktopAppIds.length > 1
    || (clientKinds.includes('desktop') && desktopAppIds.length !== 1)
    || (!clientKinds.includes('desktop') && desktopAppIds.length > 0)
    || desktopAppIds.some((appId) => typeof appId !== 'string' || !DESKTOP_APP_ID.test(appId))
    || new Set(desktopAppIds).size !== desktopAppIds.length) {
    throw new Error(`${prefix}.desktopAppIds must contain exactly one exact app id only for a desktop client trust domain`);
  }
  const capabilities = service.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 64) {
    throw new Error(`${prefix}.capabilities must contain 1 to 64 entries`);
  }
  const normalizedCapabilities = capabilities.map((item, capabilityIndex) => normalizeCapability(
    item, id, capabilityIndex, allowInsecureHttp, environment,
  ));
  if (new Set(normalizedCapabilities.map((item) => item.name)).size !== normalizedCapabilities.length) {
    throw new Error(`${prefix}.capability names must be unique`);
  }
  if (normalizedCapabilities.some((capability) => (
    ['browser', 'desktop'].includes(capability.transport) && !clientKinds.includes(capability.transport)
  ))) {
    throw new Error(`${prefix}.capability transport must be enabled by clientKinds`);
  }
  if (clientKinds.includes('desktop')
    && normalizedCapabilities.some((capability) => capability.transport !== 'desktop')) {
    throw new Error(`${prefix}.desktop services may contain only desktop capabilities`);
  }
  const contextSchema = structuredClone(validateConnectorSchema(
    service.contextSchema ?? { type: 'object', properties: {}, required: [], additionalProperties: false },
    `${prefix}.contextSchema`,
  ));
  const bindingFields = service.bindingFields ?? [];
  if (!Array.isArray(bindingFields) || bindingFields.length === 0 || bindingFields.length > 8
    || bindingFields.some((field) => typeof field !== 'string' || !Object.hasOwn(contextSchema.properties, field))
    || new Set(bindingFields).size !== bindingFields.length) {
    throw new Error(`${prefix}.bindingFields must contain 1 to 8 unique top-level context properties`);
  }
  const requiredContext = new Set(contextSchema.required ?? []);
  if (bindingFields.some((field) => !requiredContext.has(field))) {
    throw new Error(`${prefix}.bindingFields must be required context properties`);
  }
  const executionGuardMode = service.executionGuardFields === undefined
    ? 'strict_context_version'
    : 'projection';
  const executionGuardFields = service.executionGuardFields ?? bindingFields;
  if (!Array.isArray(executionGuardFields) || executionGuardFields.length === 0 || executionGuardFields.length > 8
    || executionGuardFields.some((field) => typeof field !== 'string' || !Object.hasOwn(contextSchema.properties, field))
    || new Set(executionGuardFields).size !== executionGuardFields.length) {
    throw new Error(`${prefix}.executionGuardFields must contain 1 to 8 unique top-level context properties`);
  }
  if (executionGuardFields.some((field) => !requiredContext.has(field))) {
    throw new Error(`${prefix}.executionGuardFields must be required context properties`);
  }
  if (bindingFields.some((field) => !executionGuardFields.includes(field))) {
    throw new Error(`${prefix}.executionGuardFields must include every bindingFields entry`);
  }
  return {
    id,
    displayName,
    tokenEnv,
    token,
    contextSchema,
    bindingFields: [...bindingFields],
    executionGuardFields: [...executionGuardFields],
    executionGuardMode,
    clientKinds: [...clientKinds],
    origins: [...new Set(origins.map((origin) => exactHttpOrigin(origin, `${prefix}.origins`)))],
    desktopAppIds: [...desktopAppIds],
    capabilities: normalizedCapabilities,
  };
}

export async function loadConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? os.homedir();
  const environment = options.environment ?? process.env;
  const configPath = path.resolve(options.configPath
    ?? environment.RELU_AI_BRIDGE_CONFIG
    ?? path.join(cwd, 'config', 'local.json'));
  let raw;
  try {
    raw = await readJson(configPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    raw = {
      roots: [{ id: 'project', path: cwd, readOnly: true }],
      permissions: { write: false, commands: false, sessions: true, goalLoop: false, multiAgent: false },
    };
  }

  const roots = (raw.roots ?? []).map(normalizeRoot);
  if (roots.length === 0) throw new Error('At least one approved root is required');
  if (new Set(roots.map((root) => root.id)).size !== roots.length) throw new Error('Root ids must be unique');
  for (const root of roots) {
    const canonicalPath = await fs.realpath(root.path).catch(() => null);
    const stat = canonicalPath ? await fs.stat(canonicalPath).catch(() => null) : null;
    if (!stat?.isDirectory()) throw new Error(`Approved root does not exist or is not a directory: ${root.path}`);
    // Freeze a symlinked configuration path to its canonical target for this
    // process.  A retarget on restart changes the approval policy fingerprint.
    root.path = canonicalPath;
  }

  const server = raw.server ?? {};
  const host = server.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new Error('server.host must be an explicit loopback address (127.0.0.1 or ::1)');
  }
  const auth = server.auth ?? 'bearer';
  if (auth !== 'bearer') throw new Error('server.auth must be bearer');
  const mcpAuth = server.mcpAuth ?? auth;
  if (!['bearer', 'path'].includes(mcpAuth)) throw new Error('server.mcpAuth must be bearer or path');
  const token = options.token
    ?? environment.RELU_AI_BRIDGE_TOKEN
    ?? '';
  const allowedHttpOrigins = (server.allowedHttpOrigins ?? []).map((origin) => {
    const parsed = new URL(String(origin));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== String(origin)) {
      throw new Error(`server.allowedHttpOrigins must contain exact HTTP(S) origins: ${origin}`);
    }
    return parsed.origin;
  });
  const allowedChromeExtensionIds = (server.allowedChromeExtensionIds ?? []).map(String);
  if (allowedChromeExtensionIds.some((id) => !/^[a-p]{32}$/u.test(id))) {
    throw new Error('server.allowedChromeExtensionIds must contain 32-character Chrome extension ids');
  }
  const perfettoEnabled = bool(raw.perfetto?.enabled, true);
  const connectorEnabled = bool(raw.connectors?.enabled, true);
  if (token.length < 24) {
    throw new Error('RELU_AI_BRIDGE_TOKEN must contain at least 24 characters');
  }

  const dataDir = path.resolve(expandHome(raw.dataDir ?? '~/.relu-ai-bridge', home));
  const permissions = raw.permissions ?? {};
  const limits = raw.limits ?? {};
  const privacy = raw.privacy ?? {};
  const { approvals, policy: approvalPolicy } = normalizeApprovals(raw.approvals);
  const perfetto = raw.perfetto ?? {};
  const connectors = raw.connectors ?? {};
  if ((connectors.websocketPath ?? '/relu/ws') !== '/relu/ws') {
    throw new Error('connectors.websocketPath is fixed to /relu/ws by the connector security contract');
  }
  if ((connectors.desktopWebsocketPath ?? '/relu/desktop/ws') !== '/relu/desktop/ws') {
    throw new Error('connectors.desktopWebsocketPath is fixed to /relu/desktop/ws by the desktop connector security contract');
  }
  const allowInsecureHttp = bool(connectors.allowInsecureHttp, false);
  const connectorServices = (connectors.services ?? []).map((service, index) => normalizeConnectorService(service, index, allowInsecureHttp, environment));
  if (new Set(connectorServices.map((service) => service.id)).size !== connectorServices.length) {
    throw new Error('connectors.services ids must be unique');
  }
  if (new Set(connectorServices.map((service) => service.tokenEnv)).size !== connectorServices.length) {
    throw new Error('connectors.services tokenEnv values must be unique');
  }
  if (new Set(connectorServices.map((service) => service.token)).size !== connectorServices.length
    || connectorServices.some((service) => service.token === token)) {
    throw new Error('Connector service tokens must be pairwise unique and different from RELU_AI_BRIDGE_TOKEN');
  }
  const connectorTokens = new Set(connectorServices.map((service) => service.token));
  const httpCredentials = connectorServices.flatMap((service) => service.capabilities
    .map((capability) => capability.http?.auth?.value)
    .filter((value) => typeof value === 'string' && value.length > 0));
  const httpCredentialEnvironments = connectorServices.flatMap((service) => service.capabilities
    .map((capability) => capability.http?.auth?.env)
    .filter((value) => typeof value === 'string' && value.length > 0));
  if (new Set(httpCredentials).size !== httpCredentials.length
    || new Set(httpCredentialEnvironments).size !== httpCredentialEnvironments.length
    || httpCredentials.some((credential) => credential === token || connectorTokens.has(credential))) {
    throw new Error('Connector HTTP API credentials and environments must be pairwise unique and different from control and service tokens');
  }
  const perfettoTokenEnv = String(perfetto.tokenEnv ?? 'RELU_PERFETTO_CONNECTOR_TOKEN');
  if (!ENV_NAME.test(perfettoTokenEnv)) throw new Error('perfetto.tokenEnv is invalid');
  const connectorCredentialEnvironments = new Set(connectorServices.flatMap((service) => [
    service.tokenEnv,
    ...service.capabilities.map((capability) => capability.http?.auth?.env).filter(Boolean),
  ]));
  if (perfettoTokenEnv === 'RELU_AI_BRIDGE_TOKEN' || connectorCredentialEnvironments.has(perfettoTokenEnv)) {
    throw new Error('Perfetto connector tokenEnv must be different from every control and connector credential environment');
  }
  const perfettoTokenValue = environment[perfettoTokenEnv];
  if (perfettoEnabled && (typeof perfettoTokenValue !== 'string' || perfettoTokenValue.length < 24)) {
    throw new Error(`Perfetto connector requires ${perfettoTokenEnv} with at least 24 characters`);
  }
  if (perfettoEnabled && (perfettoTokenValue === token
    || connectorTokens.has(perfettoTokenValue)
    || httpCredentials.includes(perfettoTokenValue))) {
    throw new Error('Perfetto connector credential must be different from every control and connector credential');
  }
  const goalConfig = raw.goal ?? {};
  const goalMode = goalConfig.mode ?? 'local';
  if (!['local', 'remote'].includes(goalMode)) throw new Error('goal.mode must be local or remote');
  const goalApiKeyEnv = goalConfig.apiKeyEnv ?? 'RELU_AI_BRIDGE_GOAL_API_KEY';
  if (!ENV_NAME.test(goalApiKeyEnv)) throw new Error('goal.apiKeyEnv is invalid');
  const goalApiKeyValue = environment[goalApiKeyEnv];
  let goalEndpoint;
  let goalModel;
  if (goalMode === 'remote') {
    const endpoint = new URL(String(goalConfig.endpoint ?? ''));
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('Remote goal.endpoint must be a credential-free HTTPS URL');
    }
    goalEndpoint = endpoint.toString();
    goalModel = String(goalConfig.model ?? '');
    if (!goalModel || Buffer.byteLength(goalModel) > 200) throw new Error('Remote goal.model is required and must be bounded');
    if (typeof goalApiKeyValue !== 'string' || goalApiKeyValue.length < 24) {
      throw new Error(`Remote goal evaluator requires ${goalApiKeyEnv} with at least 24 characters`);
    }
    if (goalApiKeyEnv === perfettoTokenEnv || goalApiKeyValue === token
      || goalApiKeyValue === perfettoTokenValue
      || connectorTokens.has(goalApiKeyValue)
      || httpCredentials.includes(goalApiKeyValue)) {
      throw new Error('Remote goal evaluator credential must be different from every bridge and connector credential');
    }
  }
  if ((perfetto.websocketPath ?? '/perfetto/ws') !== '/perfetto/ws') {
    throw new Error('perfetto.websocketPath is fixed to /perfetto/ws by the v58 plugin security contract');
  }
  const allowedPluginIds = (perfetto.allowedPluginIds ?? ['io.company.RELUPerfettoBridge']).map(String);
  if (allowedPluginIds.length === 0 || allowedPluginIds.some((id) => !/^[a-zA-Z0-9._-]{3,200}$/u.test(id))) {
    throw new Error('perfetto.allowedPluginIds must contain valid plugin ids');
  }
  const allowedSqlFunctions = (perfetto.allowedSqlFunctions ?? DEFAULT_SAFE_PERFETTO_SQL_FUNCTIONS)
    .map((name) => String(name).toLowerCase());
  if (allowedSqlFunctions.some((name) => !/^[a-z_][a-z0-9_]*$/u.test(name))) {
    throw new Error('perfetto.allowedSqlFunctions contains an invalid function name');
  }
  const allowedPerfettoOriginsRaw = perfetto.allowedOrigins ?? [
    'http://127.0.0.1:10000',
    'http://localhost:10000',
  ];
  if (!Array.isArray(allowedPerfettoOriginsRaw) || allowedPerfettoOriginsRaw.length === 0 || allowedPerfettoOriginsRaw.length > 32) {
    throw new Error('perfetto.allowedOrigins must contain 1 to 32 exact origins');
  }
  const allowedPerfettoOrigins = allowedPerfettoOriginsRaw.map((origin) => {
    if (typeof origin !== 'string' || Buffer.byteLength(origin) > 2048) {
      throw new Error('perfetto.allowedOrigins must contain bounded exact HTTP(S) origins');
    }
    const parsed = new URL(String(origin));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== String(origin)) {
      throw new Error(`perfetto.allowedOrigins must contain exact HTTP(S) origins: ${origin}`);
    }
    return parsed.origin;
  });
  const commandTimeoutMs = strictBoundedPositiveInteger(
    limits.commandTimeoutMs, 120_000, 86_400_000, 'limits.commandTimeoutMs',
  );
  const maxConcurrentCommands = strictBoundedPositiveInteger(
    limits.maxConcurrentCommands, 4, 32, 'limits.maxConcurrentCommands',
  );
  const maxConcurrentCommandsPerRoot = strictBoundedPositiveInteger(
    limits.maxConcurrentCommandsPerRoot,
    Math.min(2, maxConcurrentCommands),
    32,
    'limits.maxConcurrentCommandsPerRoot',
  );
  if (maxConcurrentCommandsPerRoot > maxConcurrentCommands) {
    throw new Error('limits.maxConcurrentCommandsPerRoot must not exceed limits.maxConcurrentCommands');
  }
  const commandProfiles = {};
  for (const [name, profile] of Object.entries(raw.commandProfiles ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(name)) throw new Error(`Invalid command profile name: ${name}`);
    if (!profile || typeof profile.program !== 'string' || !Array.isArray(profile.args ?? [])) {
      throw new Error(`Command profile ${name} requires program and args`);
    }
    if (!profile.program || profile.program.includes('\0') || profile.program.length > 4096) {
      throw new Error(`Command profile ${name} has an invalid program`);
    }
    const args = profile.args ?? [];
    if (args.length > 100 || args.some((argument) => (
      typeof argument !== 'string' || argument.includes('\0') || argument.length > 4096
    ))) throw new Error(`Command profile ${name} has invalid args`);
    commandProfiles[name] = {
      program: profile.program,
      args: [...args],
      allowExtraArgs: bool(profile.allowExtraArgs, false),
      interactive: bool(profile.interactive, false),
      timeoutMs: boundedPositiveInteger(profile.timeoutMs, commandTimeoutMs, commandTimeoutMs, `commandProfiles.${name}.timeoutMs`),
    };
  }

  return {
    configPath,
    server: {
      host,
      port: boundedPositiveInteger(server.port, 5746, 65_535, 'server.port'),
      auth,
      mcpAuth,
      token,
      allowedHttpOrigins: [...new Set(allowedHttpOrigins)],
      allowedChromeExtensionIds: [...new Set(allowedChromeExtensionIds)],
      maxRequestBytes: boundedPositiveInteger(server.maxRequestBytes, 1024 * 1024, 2 * 1024 * 1024, 'server.maxRequestBytes'),
    },
    dataDir,
    roots,
    permissions: {
      read: bool(permissions.read, true),
      write: bool(permissions.write, false),
      commands: bool(permissions.commands, false),
      sessions: bool(permissions.sessions, true),
      goalLoop: bool(permissions.goalLoop, false),
      multiAgent: bool(permissions.multiAgent, false),
      allowArbitraryCommands: bool(permissions.allowArbitraryCommands, false),
    },
    approvals: {
      policy: approvalPolicy,
      allowPersistentGrants: bool(approvals.allowPersistentGrants, true),
      preapprovedScopes: Array.isArray(approvals.preapprovedScopes) ? approvals.preapprovedScopes.map(String) : [],
      pendingTtlMs: boundedPositiveInteger(approvals.pendingTtlMs, 10 * 60_000, 60 * 60_000, 'approvals.pendingTtlMs'),
      maxPending: boundedPositiveInteger(approvals.maxPending, 200, 1000, 'approvals.maxPending'),
    },
    perfetto: {
      enabled: perfettoEnabled,
      tokenEnv: perfettoTokenEnv,
      token: perfettoEnabled ? perfettoTokenValue : undefined,
      websocketPath: '/perfetto/ws',
      allowedOrigins: [...new Set(allowedPerfettoOrigins)],
      requestTimeoutMs: boundedPositiveInteger(perfetto.requestTimeoutMs, 30_000, 60_000, 'perfetto.requestTimeoutMs'),
      maxConcurrentRequests: boundedPositiveInteger(perfetto.maxConcurrentRequests, 32, 64, 'perfetto.maxConcurrentRequests'),
      maxWebSocketMessageBytes: boundedPositiveInteger(perfetto.maxWebSocketMessageBytes, 2 * 1024 * 1024, 2 * 1024 * 1024, 'perfetto.maxWebSocketMessageBytes'),
      maxQueryBytes: boundedPositiveInteger(perfetto.maxQueryBytes, 64 * 1024, 64 * 1024, 'perfetto.maxQueryBytes'),
      maxQueryRows: boundedPositiveInteger(perfetto.maxQueryRows, 5_000, 5_000, 'perfetto.maxQueryRows'),
      maxClients: boundedPositiveInteger(perfetto.maxClients, 32, 128, 'perfetto.maxClients'),
      maxSessions: boundedPositiveInteger(perfetto.maxSessions, 100, 1_000, 'perfetto.maxSessions'),
      allowedPluginIds: [...new Set(allowedPluginIds)],
      allowedSqlFunctions: [...new Set(allowedSqlFunctions)],
    },
    connectors: {
      enabled: connectorEnabled,
      websocketPath: '/relu/ws',
      desktopWebsocketPath: '/relu/desktop/ws',
      allowInsecureHttp,
      requestTimeoutMs: boundedPositiveInteger(connectors.requestTimeoutMs, 30_000, 60_000, 'connectors.requestTimeoutMs'),
      maxWebSocketMessageBytes: boundedPositiveInteger(connectors.maxWebSocketMessageBytes, 1024 * 1024, 2 * 1024 * 1024, 'connectors.maxWebSocketMessageBytes'),
      maxContextBytes: boundedPositiveInteger(connectors.maxContextBytes, 64 * 1024, 256 * 1024, 'connectors.maxContextBytes'),
      maxResultBytes: boundedPositiveInteger(connectors.maxResultBytes, 512 * 1024, 2 * 1024 * 1024, 'connectors.maxResultBytes'),
      maxSessions: boundedPositiveInteger(connectors.maxSessions, 64, 256, 'connectors.maxSessions'),
      policyEpoch: boundedPositiveInteger(connectors.policyEpoch, 1, 1_000_000, 'connectors.policyEpoch'),
      services: connectorServices,
      allowedOrigins: [...new Set(connectorServices.flatMap((service) => service.origins))],
    },
    limits: {
      maxReadBytes: parsePositiveInteger(limits.maxReadBytes, 512 * 1024, 'limits.maxReadBytes'),
      maxWriteBytes: parsePositiveInteger(limits.maxWriteBytes, 1024 * 1024, 'limits.maxWriteBytes'),
      maxSearchResults: parsePositiveInteger(limits.maxSearchResults, 200, 'limits.maxSearchResults'),
      maxCommandOutputBytes: parsePositiveInteger(limits.maxCommandOutputBytes, 1024 * 1024, 'limits.maxCommandOutputBytes'),
      commandTimeoutMs,
      commandKillGraceMs: strictBoundedPositiveInteger(
        limits.commandKillGraceMs, 2_000, 30_000, 'limits.commandKillGraceMs',
      ),
      commandSessionTtlMs: strictBoundedPositiveInteger(
        limits.commandSessionTtlMs, 60_000, 86_400_000, 'limits.commandSessionTtlMs',
      ),
      maxConcurrentCommands,
      maxConcurrentCommandsPerRoot,
      sessionRetentionDays: parsePositiveInteger(limits.sessionRetentionDays, 30, 'limits.sessionRetentionDays'),
      maxWorkers: parsePositiveInteger(limits.maxWorkers, 4, 'limits.maxWorkers'),
      maxGoalTurns: parsePositiveInteger(limits.maxGoalTurns, 50, 'limits.maxGoalTurns'),
    },
    commandProfiles,
    goal: {
      mode: goalMode,
      continuePrompt: goalConfig.continuePrompt ?? 'Continue working toward the saved goal. Verify remaining work and do not stop until the goal is complete. When it is fully complete, end the final answer with [GOAL_COMPLETE].',
      completionMarkers: goalConfig.completionMarkers ?? ['[GOAL_COMPLETE]', '[목표_완료]'],
      endpoint: goalEndpoint,
      model: goalModel,
      apiKeyEnv: goalApiKeyEnv,
      apiKeyValue: goalMode === 'remote' ? goalApiKeyValue : undefined,
    },
    privacy: {
      recordAudit: bool(privacy.recordAudit, true),
      recordSessions: bool(privacy.recordSessions, false),
      recordToolArguments: bool(privacy.recordToolArguments, false),
      recordToolResults: bool(privacy.recordToolResults, false),
      maxRecordedResultBytes: parsePositiveInteger(privacy.maxRecordedResultBytes, 64 * 1024, 'privacy.maxRecordedResultBytes'),
      redactPatterns: privacy.redactPatterns ?? [],
    },
  };
}

export async function createInitialConfig(target, projectRoot) {
  const resolvedTarget = path.resolve(target);
  try {
    await fs.access(resolvedTarget);
    throw new Error(`Refusing to overwrite existing config: ${resolvedTarget}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const example = JSON.parse(await fs.readFile(new URL('../config/example.config.json', import.meta.url), 'utf8'));
  example.roots[0].path = path.resolve(projectRoot);
  example.approvals.policy = INITIAL_APPROVAL_POLICY;
  await writeJsonAtomic(resolvedTarget, example, 0o600, { preserveExistingParentMode: true });
  return {
    configPath: resolvedTarget,
    token: randomId('relu_'),
    perfettoToken: randomId('relu_perfetto_'),
  };
}
