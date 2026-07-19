import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { OrderRequest } from '../api/polymarket-client.js';
import { getErrorMessage } from '../utils/errors.js';
import { acquireFileLock } from '../utils/file-lock.js';

export type IdempotentOrderState = 'claimed' | 'submitted' | 'unknown' | 'terminal';

export interface IdempotentOrderRecord {
  key: string;
  requestHash: string;
  state: IdempotentOrderState;
  createdAt: number;
  updatedAt: number;
  exchangeOrderId?: string;
  terminalStatus?: 'filled' | 'cancelled' | 'rejected';
  lastError?: string;
}

export type MaybePromise<T> = T | Promise<T>;

export interface OrderIdempotencyPort {
  claim(key: string, order: OrderRequest): MaybePromise<IdempotentOrderRecord>;
  markSubmitted(key: string, exchangeOrderId: string): MaybePromise<void>;
  markUnknown(key: string, error: unknown): MaybePromise<void>;
  markTerminal?(key: string, status: 'filled' | 'cancelled' | 'rejected'): MaybePromise<void>;
  get(key: string): MaybePromise<IdempotentOrderRecord | undefined>;
  listUnresolved?(): MaybePromise<IdempotentOrderRecord[]>;
}

export const DEFAULT_ORDER_IDEMPOTENCY_DIRECTORY = path.join(
  process.cwd(),
  '.state',
  'order-idempotency'
);

/**
 * A filesystem-backed idempotency journal. The initial claim uses O_EXCL (`wx`),
 * which is atomic across processes sharing the state volume. Once a key exists it
 * is never reusable: an ambiguous network failure must be reconciled, not retried
 * with the same logical order key.
 */
export class FileOrderIdempotencyStore implements OrderIdempotencyPort {
  constructor(private readonly directory = DEFAULT_ORDER_IDEMPOTENCY_DIRECTORY) {
    if (directory.trim() === '') {
      throw new Error('Order idempotency directory is required');
    }
  }

  claim(key: string, order: OrderRequest): IdempotentOrderRecord {
    const normalizedKey = normalizeIdempotencyKey(key);
    const now = Date.now();
    const record: IdempotentOrderRecord = {
      key: normalizedKey,
      requestHash: hashOrderRequest(order),
      state: 'claimed',
      createdAt: now,
      updatedAt: now,
    };

    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(normalizedKey);
    let file: number | undefined;
    try {
      file = fs.openSync(filePath, 'wx', 0o600);
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.fsyncSync(file);
      fsyncDirectory(this.directory);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = this.get(normalizedKey);
        const details = existing
          ? `state=${existing.state}${existing.exchangeOrderId ? `, exchangeOrderId=${existing.exchangeOrderId}` : ''}`
          : 'state=unreadable';
        throw new Error(
          `Duplicate logical order blocked (idempotencyKey=${normalizedKey}, ${details}). Reconcile the existing order instead of resubmitting.`,
          { cause: error }
        );
      }
      throw new Error(`Failed to claim order idempotency key: ${getErrorMessage(error)}`, {
        cause: error,
      });
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }

  markSubmitted(key: string, exchangeOrderId: string): void {
    if (exchangeOrderId.trim() === '') {
      throw new Error('Exchange order id is required for idempotency journal update');
    }
    this.update(key, (record) => {
      if (record.state !== 'claimed') {
        throw new Error(`Cannot mark ${record.state} order ${record.key} submitted`);
      }
      return {
        ...record,
        state: 'submitted',
        exchangeOrderId,
        updatedAt: Date.now(),
      };
    });
  }

  markUnknown(key: string, error: unknown): void {
    this.update(key, (record) =>
      record.state === 'submitted' || record.state === 'terminal'
        ? record
        : {
            ...record,
            state: 'unknown',
            lastError: getErrorMessage(error),
            updatedAt: Date.now(),
          }
    );
  }

  markTerminal(key: string, status: 'filled' | 'cancelled' | 'rejected'): void {
    this.update(key, (record) => {
      if (record.state !== 'submitted' && record.state !== 'terminal') {
        throw new Error(`Cannot mark ${record.state} order ${record.key} terminal`);
      }
      if (record.state === 'terminal') {
        if (record.terminalStatus !== status) {
          throw new Error(
            `Cannot change terminal order ${record.key} from ${record.terminalStatus ?? 'unknown'} to ${status}`
          );
        }
        return record;
      }
      return {
        ...record,
        state: 'terminal',
        terminalStatus: status,
        updatedAt: Date.now(),
      };
    });
  }

  get(key: string): IdempotentOrderRecord | undefined {
    const filePath = this.filePath(normalizeIdempotencyKey(key));
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (!isIdempotentOrderRecord(parsed)) {
        throw new Error('invalid journal record');
      }
      return parsed;
    } catch (error) {
      throw new Error(`Failed to read order idempotency record: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
  }

  listUnresolved(): IdempotentOrderRecord[] {
    if (!fs.existsSync(this.directory)) return [];
    const records: IdempotentOrderRecord[] = [];
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(this.directory, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (!isIdempotentOrderRecord(parsed)) throw new Error('invalid journal record');
        if (parsed.state !== 'terminal') records.push(parsed);
      } catch (error) {
        throw new Error(
          `Failed to read order idempotency record ${entry.name}: ${getErrorMessage(error)}`,
          { cause: error }
        );
      }
    }
    return records.sort((left, right) => left.createdAt - right.createdAt);
  }

  private update(
    key: string,
    updater: (record: IdempotentOrderRecord) => IdempotentOrderRecord
  ): void {
    const normalizedKey = normalizeIdempotencyKey(key);
    const filePath = this.filePath(normalizedKey);
    const lockPath = `${filePath}.lock`;
    const tempPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    let lock: ReturnType<typeof acquireFileLock> | undefined;
    try {
      lock = acquireFileLock(lockPath);
      const current = this.get(normalizedKey);
      if (!current) {
        throw new Error(`Order idempotency key ${normalizedKey} was not claimed`);
      }
      const next = updater(current);
      fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      const temp = fs.openSync(tempPath, 'r');
      try {
        fs.fsyncSync(temp);
      } finally {
        fs.closeSync(temp);
      }
      fs.renameSync(tempPath, filePath);
      fsyncDirectory(this.directory);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Preserve the original persistence error.
      }
      throw new Error(`Failed to update order idempotency record: ${getErrorMessage(error)}`, {
        cause: error,
      });
    } finally {
      lock?.release();
    }
  }

  private filePath(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }
}

export function normalizeIdempotencyKey(key: string): string {
  const normalized = key.trim();
  if (normalized.length < 8 || normalized.length > 200) {
    throw new Error('Order idempotency key must contain between 8 and 200 characters');
  }
  return normalized;
}

export function hashOrderRequest(order: OrderRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        marketId: order.marketId,
        side: order.side,
        size: order.size,
        price: order.price,
        orderType: order.orderType ?? 'limit',
        timeInForce: order.timeInForce ?? 'GTC',
      })
    )
    .digest('hex');
}

function isIdempotentOrderRecord(value: unknown): value is IdempotentOrderRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === 'string' &&
    typeof record.requestHash === 'string' &&
    (record.state === 'claimed' ||
      record.state === 'submitted' ||
      record.state === 'unknown' ||
      record.state === 'terminal') &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    (record.exchangeOrderId === undefined || typeof record.exchangeOrderId === 'string') &&
    (record.terminalStatus === undefined ||
      (typeof record.terminalStatus === 'string' &&
        ['filled', 'cancelled', 'rejected'].includes(record.terminalStatus))) &&
    (record.lastError === undefined || typeof record.lastError === 'string') &&
    (record.state === 'submitted' || record.state === 'terminal'
      ? typeof record.exchangeOrderId === 'string' && record.exchangeOrderId.trim() !== ''
      : record.exchangeOrderId === undefined) &&
    (record.state === 'terminal'
      ? record.terminalStatus !== undefined
      : record.terminalStatus === undefined)
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
