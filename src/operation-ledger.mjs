import crypto from 'node:crypto';

export const OPERATION_LEDGER_VERSION = 2;
export const MAX_OPERATION_LEDGER_RECORDS = 4096;
export const MAX_OPERATION_LEDGER_FILE_BYTES = 32 * 1024 * 1024;

const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const SERVICE_ID = /^[a-z][a-z0-9_-]{1,63}$/u;
const CAPABILITY = /^[a-z][a-z0-9_.-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RECORD_ID = /^op_[a-f0-9]{32}$/u;
const TERMINAL_STATUSES = new Set([
  'completed', 'completed_no_result', 'confirmed_applied', 'failed',
]);
const ALL_STATUSES = new Set([...TERMINAL_STATUSES, 'pending', 'ambiguous']);
const RECORD_KEYS = new Set([
  'id', 'serviceId', 'origin', 'pageBinding', 'contextBinding', 'capability',
  'operationId', 'argsHash', 'status', 'reason', 'lateOutcome', 'createdAt', 'updatedAt',
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function operationLedgerHash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

export function operationLedgerKey(policyEpoch, record) {
  return canonicalJson([
    policyEpoch, record.serviceId, record.origin, record.contextBinding,
    record.capability, record.operationId,
  ]);
}

export function operationLedgerId(policyEpoch, record, options = {}) {
  const key = options.legacy === true
    ? canonicalJson([record.serviceId, record.origin, record.contextBinding, record.capability, record.operationId])
    : operationLedgerKey(policyEpoch, record);
  return `op_${operationLedgerHash(key).slice(0, 32)}`;
}

function isExactHttpOrigin(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2048) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value;
  } catch {
    return false;
  }
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function validateRecord(record, policyEpoch, options) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== RECORD_KEYS.size
    || Object.keys(record).some((key) => !RECORD_KEYS.has(key))) {
    throw new Error('Connector operation ledger contains an invalid record shape');
  }
  if (!RECORD_ID.test(record.id)
    || !SERVICE_ID.test(record.serviceId)
    || !isExactHttpOrigin(record.origin)
    || !SHA256.test(record.pageBinding)
    || !SHA256.test(record.contextBinding)
    || !CAPABILITY.test(record.capability)
    || !OPERATION_ID.test(record.operationId)
    || !SHA256.test(record.argsHash)
    || !ALL_STATUSES.has(record.status)
    || !isIsoTimestamp(record.createdAt)
    || !isIsoTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)
    || !(record.reason === null || (typeof record.reason === 'string' && Buffer.byteLength(record.reason) <= 256))
    || !(record.lateOutcome === null || ['success', 'failure'].includes(record.lateOutcome))) {
    throw new Error('Connector operation ledger contains an invalid record');
  }
  if (options.terminalOnly && !TERMINAL_STATUSES.has(record.status)) {
    throw new Error('Connector operation ledger contains pending or ambiguous records; reconcile them before archival');
  }
  const expectedId = operationLedgerId(policyEpoch, record, { legacy: options.legacy });
  if (record.id !== expectedId) throw new Error('Connector operation ledger record id does not match its immutable fields');
}

export function validateOperationLedgerDocument(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Connector operation ledger is invalid');
  }
  const legacy = value.version === 1;
  const allowedKeys = legacy ? new Set(['version', 'records']) : new Set(['version', 'policyEpoch', 'records']);
  if ((!legacy && value.version !== OPERATION_LEDGER_VERSION)
    || Object.keys(value).length !== allowedKeys.size
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || (!legacy && (!Number.isSafeInteger(value.policyEpoch) || value.policyEpoch < 1 || value.policyEpoch > 1_000_000))
    || !Array.isArray(value.records)
    || value.records.length > MAX_OPERATION_LEDGER_RECORDS) {
    throw new Error('Connector operation ledger is invalid');
  }
  const policyEpoch = legacy ? 1 : value.policyEpoch;
  const keys = new Set();
  for (const record of value.records) {
    validateRecord(record, policyEpoch, { legacy, terminalOnly: options.terminalOnly === true });
    const key = operationLedgerKey(policyEpoch, record);
    if (keys.has(key)) throw new Error('Connector operation ledger contains a duplicate record');
    keys.add(key);
  }
  return { legacy, policyEpoch, records: value.records };
}
