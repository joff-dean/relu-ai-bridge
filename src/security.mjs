import fs from 'node:fs/promises';
import path from 'node:path';
import { secureEqual } from './utils.mjs';

function globToRegExp(glob) {
  let result = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      result += '(?:.*/)?';
      i += 2;
    } else if (char === '*' && glob[i + 1] === '*') {
      result += '.*';
      i += 1;
    } else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
  }
  return new RegExp(`${result}$`, 'i');
}

export function isProtectedPath(root, relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  return root.protectedPaths.some((pattern) => globToRegExp(pattern).test(normalized));
}

function isSameOrDescendant(candidate, directory) {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

async function canonicalizePotentialPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (true) {
    try {
      const existing = await fs.realpath(current);
      return path.resolve(existing, ...suffix);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isPathInBridgeReservedPaths(absolutePath, reserved) {
  const candidate = path.resolve(absolutePath);
  return (reserved.configPath !== null && candidate === reserved.configPath)
    || (reserved.dataDir !== null && isSameOrDescendant(candidate, reserved.dataDir));
}

export function isReservedBridgePath(config, absolutePath) {
  return isPathInBridgeReservedPaths(absolutePath, {
    configPath: config?.configPath ? path.resolve(config.configPath) : null,
    dataDir: config?.dataDir ? path.resolve(config.dataDir) : null,
  });
}

export async function canonicalBridgeReservedPaths(config) {
  return {
    configPath: config?.configPath ? await canonicalizePotentialPath(config.configPath) : null,
    dataDir: config?.dataDir ? await canonicalizePotentialPath(config.dataDir) : null,
  };
}

export function findRoot(config, rootId) {
  const root = config.roots.find((item) => item.id === rootId);
  if (!root) throw new Error(`Unknown root: ${rootId}`);
  return root;
}

function assertRelative(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error('path must be a non-empty string');
  if (relativePath.includes('\0') || path.isAbsolute(relativePath)) throw new Error('path must be relative');
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error('path escapes the approved root');
  return normalized;
}

async function nearestExistingParent(candidate) {
  let current = candidate;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function resolveApprovedPath(config, rootId, relativePath, options = {}) {
  const root = findRoot(config, rootId);
  const normalized = assertRelative(relativePath);
  if (isProtectedPath(root, normalized)) throw new Error(`Path is protected: ${relativePath}`);
  const rootReal = await fs.realpath(root.path);
  const candidate = path.resolve(root.path, normalized);
  if (isReservedBridgePath(config, candidate)) throw new Error(`Path is reserved for RELU AI Bridge state: ${relativePath}`);
  const [canonicalCandidate, canonicalReserved] = await Promise.all([
    canonicalizePotentialPath(candidate),
    canonicalBridgeReservedPaths(config),
  ]);
  if (isPathInBridgeReservedPaths(canonicalCandidate, canonicalReserved)) {
    throw new Error(`Path is reserved for RELU AI Bridge state: ${relativePath}`);
  }
  const candidateStat = await fs.lstat(candidate).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (candidateStat?.isSymbolicLink()) throw new Error('Symbolic-link targets are not allowed');
  const parentReal = await nearestExistingParent(options.mustExist ? candidate : path.dirname(candidate));
  const boundary = `${rootReal}${path.sep}`;
  if (parentReal !== rootReal && !parentReal.startsWith(boundary)) throw new Error('resolved path escapes the approved root');
  if (options.mustExist) {
    const targetReal = await fs.realpath(candidate);
    if (targetReal !== rootReal && !targetReal.startsWith(boundary)) throw new Error('resolved path escapes the approved root');
    if (isReservedBridgePath(config, targetReal)) throw new Error(`Path is reserved for RELU AI Bridge state: ${relativePath}`);
  }
  if (options.write && candidateStat) {
    const targetReal = await fs.realpath(candidate);
    if (targetReal !== rootReal && !targetReal.startsWith(boundary)) throw new Error('resolved path escapes the approved root');
    if (isReservedBridgePath(config, targetReal)) throw new Error(`Path is reserved for RELU AI Bridge state: ${relativePath}`);
  }
  if (options.write && (!config.permissions.write || root.readOnly)) {
    throw new Error(`Writes are disabled for root ${rootId}`);
  }
  return { root, absolutePath: candidate, relativePath: normalized.split(path.sep).join('/') };
}

export function authorizeRequest(config, request, mode = config.server.auth, pathname = '') {
  if (mode === 'path') return secureEqual(pathname, `/mcp/${config.server.token}`);
  if (mode !== 'bearer') return false;
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return secureEqual(header.slice(7), config.server.token);
}

export function createRedactor(config) {
  const compiled = config.privacy.redactPatterns.map((pattern) => {
    const inlineInsensitive = pattern.startsWith('(?i)');
    return new RegExp(inlineInsensitive ? pattern.slice(4) : pattern, inlineInsensitive ? 'gi' : 'g');
  });
  const connectorSecrets = (config.connectors?.services ?? []).flatMap((service) => [
    service.token,
    ...service.capabilities.flatMap((capability) => capability.http?.auth?.value ?? []),
  ]);
  const known = [...new Set([
    config.server.token,
    config.perfetto?.token,
    config.goal.apiKeyValue ?? process.env[config.goal.apiKeyEnv],
    ...connectorSecrets,
  ]
    .filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  return (input) => {
    let value = String(input ?? '');
    for (const secret of known) value = value.split(secret).join('[REDACTED]');
    for (const expression of compiled) value = value.replace(expression, '[REDACTED]');
    return value;
  };
}

function configuredCredentialEnvironmentNames(config) {
  const names = new Set(['RELU_AI_BRIDGE_TOKEN']);
  if (config?.perfetto?.tokenEnv) names.add(config.perfetto.tokenEnv);
  if (config?.goal?.apiKeyEnv) names.add(config.goal.apiKeyEnv);
  for (const service of config?.connectors?.services ?? []) {
    if (service.tokenEnv) names.add(service.tokenEnv);
    for (const capability of service.capabilities ?? []) {
      if (capability.http?.auth?.env) names.add(capability.http.auth.env);
    }
  }
  return names;
}

export function safeChildEnvironment(extra = {}, config = null) {
  const result = {};
  const configuredCredentials = configuredCredentialEnvironmentNames(config);
  for (const [key, value] of Object.entries(process.env)) {
    if (configuredCredentials.has(key)) continue;
    if (/token|secret|password|credential|authorization|auth|api[_-]?key|(^|_)key($|_)/i.test(key)) continue;
    result[key] = value;
  }
  return { ...result, ...extra };
}
