import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';
import { acquireFileLock } from '../utils/file-lock.js';

export type CanaryTradeRecordStatus =
  | 'dry-run'
  | 'intent'
  | 'submitted'
  | 'open'
  | 'partial'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'timed_out'
  | 'unknown'
  | 'failed';

export interface CanaryTradeRecord {
  runId: string;
  requestedAt: number;
  updatedAt: number;
  dryRun: boolean;
  submitted: boolean;
  submissionAttempted?: boolean;
  tokenId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  notionalUsd: number;
  orderId?: string;
  status: CanaryTradeRecordStatus;
  lastError?: string;
  cancelAttempted?: boolean;
  cancelSucceeded?: boolean;
  cancelConfirmed?: boolean;
  cancelError?: string;
  manualInterventionRequired?: boolean;
  manualInterventionReason?: string;
}

interface PersistedCanaryTrades {
  records: CanaryTradeRecord[];
  savedAt: number;
}

export const DEFAULT_CANARY_STATE_FILE_PATH = path.join(
  process.cwd(),
  '.state',
  'canary-trades.json'
);

export interface CanaryTradePersistencePort {
  saveRecord(record: CanaryTradeRecord): void;
  loadRecords?(): CanaryTradeRecord[];
}

export class CanaryTradePersistence implements CanaryTradePersistencePort {
  private readonly logger = getLogger().child({ module: 'CanaryTradePersistence' });

  constructor(private readonly stateFilePath: string = DEFAULT_CANARY_STATE_FILE_PATH) {}

  saveRecord(record: CanaryTradeRecord): void {
    if (!this.stateFilePath) {
      return;
    }
    if (!isCanaryTradeRecord(record)) {
      throw new Error('Cannot persist an invalid canary trade record');
    }

    const lockPath = `${this.stateFilePath}.lock`;
    let lock: ReturnType<typeof acquireFileLock> | undefined;
    let tempPath: string | undefined;
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true, mode: 0o700 });
      lock = acquireFileLock(lockPath);
      const records = this.loadRecords();
      const nextRecords = upsertRecord(records, record);
      tempPath = `${this.stateFilePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify(
          { records: nextRecords, savedAt: Date.now() } satisfies PersistedCanaryTrades,
          null,
          2
        ),
        { encoding: 'utf8', mode: 0o600 }
      );
      const temp = fs.openSync(tempPath, 'r');
      try {
        fs.fsyncSync(temp);
      } finally {
        fs.closeSync(temp);
      }
      fs.renameSync(tempPath, this.stateFilePath);
      fsyncDirectory(path.dirname(this.stateFilePath));
    } catch (error) {
      this.logger.error('Failed to persist canary trade state', {
        file: this.stateFilePath,
        error: getErrorMessage(error),
      });
      throw new Error(`Failed to persist canary trade state: ${getErrorMessage(error)}`, {
        cause: error,
      });
    } finally {
      if (tempPath) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Preserve the persistence result.
        }
      }
      lock?.release();
    }
  }

  loadRecords(): CanaryTradeRecord[] {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      if (!raw.trim()) {
        throw new Error('Canary trade state file is empty');
      }

      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'records' in parsed &&
        Array.isArray((parsed as PersistedCanaryTrades).records)
      ) {
        const records = (parsed as PersistedCanaryTrades).records;
        if (!records.every(isCanaryTradeRecord)) {
          throw new Error('Canary trade state file contains an invalid record');
        }
        return records;
      }
      throw new Error('Canary trade state file has an invalid schema');
    } catch (error) {
      this.logger.error('Failed to load canary trade state', {
        file: this.stateFilePath,
        error: getErrorMessage(error),
      });
      throw new Error(`Failed to load canary trade state: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

function upsertRecord(
  records: CanaryTradeRecord[],
  record: CanaryTradeRecord
): CanaryTradeRecord[] {
  const index = records.findIndex((existing) => existing.runId === record.runId);
  if (index === -1) {
    return [...records, record];
  }

  const next = [...records];
  next[index] = record;
  return next;
}

function isCanaryTradeRecord(value: unknown): value is CanaryTradeRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Partial<CanaryTradeRecord>;
  return (
    typeof record.runId === 'string' &&
    record.runId.trim() !== '' &&
    typeof record.requestedAt === 'number' &&
    Number.isFinite(record.requestedAt) &&
    record.requestedAt >= 0 &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    record.updatedAt >= record.requestedAt &&
    typeof record.dryRun === 'boolean' &&
    typeof record.submitted === 'boolean' &&
    (record.submissionAttempted === undefined || typeof record.submissionAttempted === 'boolean') &&
    typeof record.tokenId === 'string' &&
    /^\d+$/.test(record.tokenId) &&
    (record.side === 'buy' || record.side === 'sell') &&
    typeof record.size === 'number' &&
    Number.isFinite(record.size) &&
    record.size > 0 &&
    typeof record.price === 'number' &&
    Number.isFinite(record.price) &&
    record.price > 0 &&
    record.price < 1 &&
    typeof record.notionalUsd === 'number' &&
    Number.isFinite(record.notionalUsd) &&
    record.notionalUsd > 0 &&
    Math.abs(record.notionalUsd - record.size * record.price) <= 1e-8 &&
    isCanaryTradeRecordStatus(record.status) &&
    (record.orderId === undefined ||
      (typeof record.orderId === 'string' && record.orderId.trim() !== '')) &&
    (record.lastError === undefined || typeof record.lastError === 'string') &&
    (record.cancelAttempted === undefined || typeof record.cancelAttempted === 'boolean') &&
    (record.cancelSucceeded === undefined || typeof record.cancelSucceeded === 'boolean') &&
    (record.cancelConfirmed === undefined || typeof record.cancelConfirmed === 'boolean') &&
    (record.cancelError === undefined || typeof record.cancelError === 'string') &&
    (record.manualInterventionRequired === undefined ||
      typeof record.manualInterventionRequired === 'boolean') &&
    (record.manualInterventionReason === undefined ||
      typeof record.manualInterventionReason === 'string') &&
    (!record.submitted || record.orderId !== undefined) &&
    (record.status !== 'dry-run' || (record.dryRun && !record.submitted)) &&
    (!requiresConfirmedOrder(record.status) || (record.submitted && record.orderId !== undefined))
  );
}

function requiresConfirmedOrder(status: CanaryTradeRecordStatus): boolean {
  return (
    status === 'submitted' ||
    status === 'open' ||
    status === 'partial' ||
    status === 'filled' ||
    status === 'cancelled' ||
    status === 'rejected' ||
    status === 'timed_out'
  );
}

function isCanaryTradeRecordStatus(value: unknown): value is CanaryTradeRecordStatus {
  return (
    value === 'dry-run' ||
    value === 'intent' ||
    value === 'submitted' ||
    value === 'open' ||
    value === 'partial' ||
    value === 'filled' ||
    value === 'cancelled' ||
    value === 'rejected' ||
    value === 'timed_out' ||
    value === 'unknown' ||
    value === 'failed'
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
