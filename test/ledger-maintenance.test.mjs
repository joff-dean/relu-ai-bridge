import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { archiveOperationLedger } from '../src/ledger-maintenance.mjs';
import {
  OPERATION_LEDGER_VERSION,
  operationLedgerHash,
  operationLedgerId,
  validateOperationLedgerDocument,
} from '../src/operation-ledger.mjs';
import { createApplication } from '../src/server.mjs';
import { fixture } from './helpers.mjs';

const epochOne = 1;
const execFileAsync = promisify(execFile);

function operationRecord(overrides = {}) {
  const timestamp = '2026-09-02T00:00:00.000Z';
  const record = {
    serviceId: 'perfetto',
    origin: 'http://127.0.0.1:10000',
    pageBinding: '1'.repeat(64),
    contextBinding: '2'.repeat(64),
    capability: 'select_range',
    operationId: 'archive-operation-0001',
    argsHash: '3'.repeat(64),
    status: 'completed',
    reason: null,
    lateOutcome: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
  return { id: operationLedgerId(epochOne, record), ...record };
}

function ledger(records) {
  return { version: OPERATION_LEDGER_VERSION, policyEpoch: epochOne, records };
}

async function writeLedger(env, value) {
  await fs.mkdir(env.dataDir, { recursive: true });
  const file = path.join(env.dataDir, 'connector-operations.json');
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

async function assertMissing(target) {
  await assert.rejects(fs.access(target), (error) => error?.code === 'ENOENT');
}

test('archive-ledger preserves a verified terminal ledger and resets it into the configured policy epoch', async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  env.config.connectors.policyEpoch = 2;
  const original = ledger([
    operationRecord(),
    operationRecord({
      operationId: 'archive-operation-0002',
      status: 'confirmed_applied',
      updatedAt: '2026-09-02T00:01:00.000Z',
    }),
  ]);
  const ledgerFile = await writeLedger(env, original);

  const result = await archiveOperationLedger(env.config);

  assert.equal(result.ledgerFile, ledgerFile);
  assert.equal(result.recordCount, 2);
  assert.equal(result.fromPolicyEpoch, 1);
  assert.equal(result.toPolicyEpoch, 2);
  assert.equal(result.ledgerSha256, operationLedgerHash(original));
  assert.equal(path.dirname(result.archiveFile), path.join(env.dataDir, 'connector-operation-archives'));
  assert.match(path.basename(result.archiveFile), /^connector-operations-epoch-1-\d+-[a-f0-9]{12}\.json$/u);

  const archived = JSON.parse(await fs.readFile(result.archiveFile, 'utf8'));
  assert.equal(archived.kind, 'relu-ai-bridge.connector-operation-ledger-archive');
  assert.equal(archived.fromPolicyEpoch, 1);
  assert.equal(archived.toPolicyEpoch, 2);
  assert.equal(archived.recordCount, 2);
  assert.equal(archived.ledgerSha256, operationLedgerHash(archived.ledger));
  assert.deepEqual(archived.ledger, original);
  assert.equal((await fs.stat(result.archiveFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(result.archiveFile))).mode & 0o777, 0o700);

  const reset = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  assert.deepEqual(reset, { version: OPERATION_LEDGER_VERSION, policyEpoch: 2, records: [] });
  assert.deepEqual(validateOperationLedgerDocument(reset), { legacy: false, policyEpoch: 2, records: [] });
  assert.equal((await fs.stat(ledgerFile)).mode & 0o777, 0o600);
  await assertMissing(path.join(env.dataDir, '.instance-lock'));

  const downgradedConfig = {
    ...env.config,
    connectors: { ...env.config.connectors, policyEpoch: 1 },
  };
  await assert.rejects(
    createApplication({ config: downgradedConfig }),
    /policyEpoch rollback is forbidden; configured 1, durable ledger requires at least 2/u,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(ledgerFile, 'utf8')), reset);
  await assertMissing(path.join(env.dataDir, '.instance-lock'));
});

test('archive-ledger CLI loads the configured epoch and reports the verifiable archive metadata', async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const rawConfig = JSON.parse(await fs.readFile(new URL('../config/example.config.json', import.meta.url), 'utf8'));
  rawConfig.dataDir = env.dataDir;
  rawConfig.roots[0].path = env.root;
  rawConfig.connectors.policyEpoch = 2;
  const configFile = path.join(env.directory, 'maintenance-config.json');
  await fs.writeFile(configFile, `${JSON.stringify(rawConfig, null, 2)}\n`, { mode: 0o600 });
  const original = ledger([operationRecord()]);
  await writeLedger(env, original);

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    fileURLToPath(new URL('../bin/relu-ai-bridge.mjs', import.meta.url)),
    'archive-ledger',
  ], {
    env: {
      ...process.env,
      RELU_AI_BRIDGE_CONFIG: configFile,
      RELU_AI_BRIDGE_TOKEN: env.config.server.token,
      RELU_PERFETTO_CONNECTOR_TOKEN: env.config.perfetto.token,
    },
  });

  assert.equal(stderr, '');
  assert.match(stdout, /Archived 1 terminal operation records\./u);
  assert.match(stdout, /Policy epoch: 1 -> 2/u);
  assert.match(stdout, new RegExp(`SHA-256: ${operationLedgerHash(original)}`, 'u'));
  assert.match(stdout, /connector-operation-archives\/connector-operations-epoch-1-/u);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(env.dataDir, 'connector-operations.json'), 'utf8')),
    { version: OPERATION_LEDGER_VERSION, policyEpoch: 2, records: [] },
  );
});

test('archive-ledger rejects pending and ambiguous records without writing an archive or resetting the ledger', async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  env.config.connectors.policyEpoch = 2;
  const archiveDirectory = path.join(env.dataDir, 'connector-operation-archives');

  for (const status of ['pending', 'ambiguous']) {
    const original = ledger([operationRecord({ status })]);
    const ledgerFile = await writeLedger(env, original);
    await assert.rejects(
      archiveOperationLedger(env.config),
      /pending or ambiguous records; reconcile them before archival/u,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(ledgerFile, 'utf8')), original);
    await assertMissing(archiveDirectory);
    await assertMissing(path.join(env.dataDir, '.instance-lock'));
  }
});

test('archive-ledger refuses maintenance while a bridge process holds the data directory lock', async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const original = ledger([operationRecord()]);
  const ledgerFile = await writeLedger(env, original);
  const app = await createApplication({ config: env.config });
  t.after(() => app.close());
  const maintenanceConfig = {
    ...env.config,
    connectors: { ...env.config.connectors, policyEpoch: 2 },
  };

  await assert.rejects(
    archiveOperationLedger(maintenanceConfig),
    /instance lock is already held/u,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(ledgerFile, 'utf8')), original);
  await assertMissing(path.join(env.dataDir, 'connector-operation-archives'));
});

test('archive-ledger rejects an identity-field tamper that no longer matches the record id', async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  env.config.connectors.policyEpoch = 2;
  const record = operationRecord();
  record.contextBinding = 'f'.repeat(64);
  const tampered = ledger([record]);
  const ledgerFile = await writeLedger(env, tampered);

  await assert.rejects(
    archiveOperationLedger(env.config),
    /record id does not match its immutable fields/u,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(ledgerFile, 'utf8')), tampered);
  await assertMissing(path.join(env.dataDir, 'connector-operation-archives'));
  await assertMissing(path.join(env.dataDir, '.instance-lock'));
});
