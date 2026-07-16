import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { OrderRequest } from '../api/polymarket-client.js';
import { getErrorMessage } from '../utils/errors.js';

export type IdempotentOrderState = 'claimed' | 'submitted' | 'unknown';

export interface IdempotentOrderRecord {
  key: string;
  requestHash: string;
  state: IdempotentOrderState;
  createdAt: number;
  updatedAt: number;
  exchangeOrderId?: string;
  lastError?: string;
}

export interface OrderIdempotencyPort {
  claim(key: string, order: OrderRequest): IdempotentOrderRecord;
  markSubmitted(key: string, exchangeOrderId: string): void;
  markUnknown(key: string, error: unknown): void;
  get(key: string): IdempotentOrderRecord | undefined;
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
    const normalizedKey = normalizeKey(key);
    const now = Date.now();
    const record: IdempotentOrderRecord = {
      key: normalizedKey,
      requestHash: hashRequest(order),
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
    this.update(key, (record) => ({
      ...record,
      state: 'submitted',
      exchangeOrderId,
      updatedAt: Date.now(),
    }));
  }

  markUnknown(key: string, error: unknown): void {
    this.update(key, (record) => ({
      ...record,
      state: 'unknown',
      lastError: getErrorMessage(error),
      updatedAt: Date.now(),
    }));
  }

  get(key: string): IdempotentOrderRecord | undefined {
    const filePath = this.filePath(normalizeKey(key));
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

  private update(
    key: string,
    updater: (record: IdempotentOrderRecord) => IdempotentOrderRecord
  ): void {
    const normalizedKey = normalizeKey(key);
    const current = this.get(normalizedKey);
    if (!current) {
      throw new Error(`Order idempotency key ${normalizedKey} was not claimed`);
    }
    const next = updater(current);
    const filePath = this.filePath(normalizedKey);
    const tempPath = `${filePath}.${String(process.pid)}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Preserve the original persistence error.
      }
      throw new Error(`Failed to update order idempotency record: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
  }

  private filePath(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }
}

function normalizeKey(key: string): string {
  const normalized = key.trim();
  if (normalized.length < 8 || normalized.length > 200) {
    throw new Error('Order idempotency key must contain between 8 and 200 characters');
  }
  return normalized;
}

function hashRequest(order: OrderRequest): string {
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
  const record = value as Partial<IdempotentOrderRecord>;
  return (
    typeof record.key === 'string' &&
    typeof record.requestHash === 'string' &&
    (record.state === 'claimed' || record.state === 'submitted' || record.state === 'unknown') &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    (record.exchangeOrderId === undefined || typeof record.exchangeOrderId === 'string') &&
    (record.lastError === undefined || typeof record.lastError === 'string')
  );
}
