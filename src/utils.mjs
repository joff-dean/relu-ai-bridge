import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomBytes(16).toString('hex')}`;
}

export class AsyncMutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async runExclusive(operation) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = gate;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function expandHome(value, homeDir) {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

export async function ensurePrivateDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
}

export async function writeJsonAtomic(file, value, mode = 0o600, options = {}) {
  const directory = path.dirname(file);
  if (options.preserveExistingParentMode === true) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } else {
    await ensurePrivateDir(directory);
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
  await fs.rename(temporary, file);
  await fs.chmod(file, mode).catch(() => {});
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

export function sendJson(response, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(payload);
}

export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false, originalBytes: bytes };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return {
    text: `${text.slice(0, low)}\n...[truncated ${bytes - maxBytes} bytes]`,
    truncated: true,
    originalBytes: bytes,
  };
}

export function sanitizeObject(value, redactor) {
  if (typeof value === 'string') return redactor(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeObject(item, redactor));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/token|secret|password|authorization|api[-_]?key/i.test(key)) return [key, '[REDACTED]'];
      return [key, sanitizeObject(item, redactor)];
    }));
  }
  return value;
}

export function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
