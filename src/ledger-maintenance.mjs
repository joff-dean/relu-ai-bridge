import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireDataDirectoryLock } from './instance-lock.mjs';
import {
  canonicalJson,
  MAX_OPERATION_LEDGER_FILE_BYTES,
  OPERATION_LEDGER_VERSION,
  operationLedgerHash,
  validateOperationLedgerDocument,
} from './operation-ledger.mjs';
import { ensurePrivateDir, randomId } from './utils.mjs';

async function readLedger(file) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Connector operation ledger must be a regular file');
  if (before.size > BigInt(MAX_OPERATION_LEDGER_FILE_BYTES)) {
    throw new Error('Connector operation ledger exceeds the maintenance size limit');
  }
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const chunks = [];
  let total = 0;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Connector operation ledger changed before maintenance read');
    }
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_OPERATION_LEDGER_FILE_BYTES) {
        throw new Error('Connector operation ledger exceeds the maintenance size limit');
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(file, { bigint: true });
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
      || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error('Connector operation ledger changed during maintenance read');
    }
  } finally {
    await handle.close();
  }
  const raw = Buffer.concat(chunks, total);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Connector operation ledger is not valid JSON');
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Some supported platforms do not expose directory fsync. File fsync and
    // atomic replacement still apply there; POSIX platforms also persist the
    // directory entry before the live ledger is reset.
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeExclusiveDurableJson(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(file, 0o600).catch(() => {});
  await syncDirectory(path.dirname(file));
}

async function writeAtomicDurableJson(file, value) {
  const directory = path.dirname(file);
  await ensurePrivateDir(directory);
  const temporary = `${file}.${randomId('ledger_')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => {});
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function archiveOperationLedger(config) {
  const lock = await acquireDataDirectoryLock(config.dataDir);
  try {
    const ledgerFile = path.join(config.dataDir, 'connector-operations.json');
    const ledger = await readLedger(ledgerFile);
    const validated = validateOperationLedgerDocument(ledger, { terminalOnly: true });
    if (validated.records.length === 0) throw new Error('Connector operation ledger is empty; no archival is required');
    const nextEpoch = config.connectors.policyEpoch;
    if (nextEpoch <= validated.policyEpoch) {
      throw new Error(`connectors.policyEpoch must be increased above ${validated.policyEpoch} before archival`);
    }

    const archivedAt = new Date().toISOString();
    const ledgerSha256 = operationLedgerHash(ledger);
    const archive = {
      version: 1,
      kind: 'relu-ai-bridge.connector-operation-ledger-archive',
      archivedAt,
      fromPolicyEpoch: validated.policyEpoch,
      toPolicyEpoch: nextEpoch,
      recordCount: validated.records.length,
      ledgerSha256,
      ledger,
    };
    const archiveDirectory = path.join(config.dataDir, 'connector-operation-archives');
    await ensurePrivateDir(archiveDirectory);
    const timestamp = archivedAt.replaceAll(/[^0-9]/gu, '');
    const archiveFile = path.join(archiveDirectory, `connector-operations-epoch-${validated.policyEpoch}-${timestamp}-${ledgerSha256.slice(0, 12)}.json`);
    await writeExclusiveDurableJson(archiveFile, archive);

    const persistedArchive = JSON.parse(await fs.readFile(archiveFile, 'utf8'));
    if (canonicalJson(persistedArchive) !== canonicalJson(archive)
      || operationLedgerHash(persistedArchive.ledger) !== ledgerSha256) {
      throw new Error('Connector operation ledger archive verification failed');
    }

    const liveBeforeReset = await readLedger(ledgerFile);
    if (canonicalJson(liveBeforeReset) !== canonicalJson(ledger)) {
      throw new Error('Connector operation ledger changed after archival; live ledger was not reset');
    }

    await writeAtomicDurableJson(ledgerFile, {
      version: OPERATION_LEDGER_VERSION,
      policyEpoch: nextEpoch,
      records: [],
    });
    const reset = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    const resetValidation = validateOperationLedgerDocument(reset);
    if (resetValidation.policyEpoch !== nextEpoch || resetValidation.records.length !== 0) {
      throw new Error('Connector operation ledger reset verification failed');
    }
    return {
      archiveFile,
      ledgerFile,
      recordCount: validated.records.length,
      fromPolicyEpoch: validated.policyEpoch,
      toPolicyEpoch: nextEpoch,
      ledgerSha256,
    };
  } finally {
    await lock.release();
  }
}
