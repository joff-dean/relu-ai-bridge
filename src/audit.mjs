import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir, sanitizeObject, truncateUtf8 } from './utils.mjs';

const MAX_AUDIT_STRING_BYTES = 4096;
const MAX_AUDIT_DEPTH = 12;
const MAX_AUDIT_ARRAY_ITEMS = 500;
const MAX_AUDIT_OBJECT_KEYS = 200;

function boundAuditValue(value, depth = 0) {
  if (depth > MAX_AUDIT_DEPTH) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return truncateUtf8(value, MAX_AUDIT_STRING_BYTES).text;
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_AUDIT_ARRAY_ITEMS).map((item) => boundAuditValue(item, depth + 1));
    if (value.length > MAX_AUDIT_ARRAY_ITEMS) bounded.push(`[${value.length - MAX_AUDIT_ARRAY_ITEMS} ITEMS OMITTED]`);
    return bounded;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, MAX_AUDIT_OBJECT_KEYS);
    const bounded = Object.fromEntries(entries.map(([key, item]) => [key.slice(0, 200), boundAuditValue(item, depth + 1)]));
    if (Object.keys(value).length > MAX_AUDIT_OBJECT_KEYS) bounded._omittedKeys = true;
    return bounded;
  }
  return value;
}

export class AuditLog {
  constructor(config, redactor) {
    this.config = config;
    this.redactor = redactor;
    this.directory = path.join(config.dataDir, 'audit');
  }

  async append(event) {
    if (!this.config.privacy.recordAudit) return;
    await ensurePrivateDir(this.directory);
    const date = new Date();
    const filename = path.join(this.directory, `${date.toISOString().slice(0, 10)}.ndjson`);
    const cleaned = sanitizeObject(boundAuditValue({
      at: date.toISOString(),
      ...event,
    }), this.redactor);
    if (!this.config.privacy.recordToolArguments && 'arguments' in cleaned) cleaned.arguments = '[NOT_RECORDED]';
    if (!this.config.privacy.recordToolResults && 'result' in cleaned) cleaned.result = '[NOT_RECORDED]';
    if ('result' in cleaned) {
      const serialized = JSON.stringify(cleaned.result);
      const truncated = truncateUtf8(serialized, this.config.privacy.maxRecordedResultBytes);
      cleaned.result = truncated.truncated ? { truncated: true, value: truncated.text } : cleaned.result;
    }
    await fs.appendFile(filename, `${JSON.stringify(cleaned)}\n`, { mode: 0o600 });
    await fs.chmod(filename, 0o600).catch(() => {});
  }

  async prune() {
    await ensurePrivateDir(this.directory);
    const cutoff = Date.now() - this.config.limits.sessionRetentionDays * 86_400_000;
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue;
      const file = path.join(this.directory, entry.name);
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) await fs.unlink(file);
    }
  }
}
