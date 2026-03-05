/**
 * Transaction types, constants, and persistence logic for crash recovery.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';

export type TransactionStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'finalized'
  | 'failed'
  | 'expired';

export interface Transaction {
  hash: string;
  orderId: string;
  marketId: string;
  status: TransactionStatus;
  createdAt: number;
  submittedAt?: number;
  confirmedAt?: number;
  finalizedAt?: number;
  failedAt?: number;
  blockNumber?: number;
  confirmations: number;
  retryCount: number;
  lastError?: string;
  gasPrice?: string;
  gasUsed?: string;
}

export interface TransactionUpdate {
  hash: string;
  status: TransactionStatus;
  blockNumber?: number | undefined;
  confirmations?: number | undefined;
  gasUsed?: string | undefined;
  error?: string | undefined;
}

export type TransactionHandler = (tx: Transaction) => void;

// Configuration
export const DEFAULT_CONFIRMATION_BLOCKS = 12;
export const MAX_RETRY_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 1000;
export const POLL_INTERVAL_MS = 2000;
export const TRANSACTION_TIMEOUT_MS = 300000; // 5 minutes
export const DEFAULT_STATE_FILE_PATH = path.join(
  process.cwd(),
  '.state',
  'transaction-tracker.json'
);
export const DISABLE_PERSISTENCE_IN_TEST = process.env.NODE_ENV === 'test';

interface PersistedState {
  transactions: Transaction[];
  savedAt: number;
}

/**
 * Handles transaction state persistence and recovery.
 */
export class TransactionPersistence {
  private stateFilePath: string;
  private logger = getLogger().child({ module: 'TransactionPersistence' });

  constructor(stateFilePath: string) {
    this.stateFilePath = stateFilePath;
  }

  get enabled(): boolean {
    return this.stateFilePath !== '';
  }

  saveState(transactions: Transaction[]): void {
    if (!this.stateFilePath) return;

    const state: PersistedState = {
      transactions,
      savedAt: Date.now(),
    };

    try {
      const stateDir = path.dirname(this.stateFilePath);
      fs.mkdirSync(stateDir, { recursive: true });

      const tempPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (error) {
      this.logger.error('Failed to persist transaction tracker state', {
        file: this.stateFilePath,
        error: getErrorMessage(error),
      });
    }
  }

  loadState(): Transaction[] {
    if (!this.stateFilePath) return [];

    try {
      if (!fs.existsSync(this.stateFilePath)) return [];

      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      if (!raw.trim()) return [];

      const parsed: unknown = JSON.parse(raw);
      return this.extractTransactions(parsed);
    } catch (error) {
      this.logger.error('Failed to load transaction tracker state', {
        file: this.stateFilePath,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  private extractTransactions(parsed: unknown): Transaction[] {
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is Transaction => isValidTransaction(value));
    }

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'transactions' in parsed &&
      Array.isArray((parsed as PersistedState).transactions)
    ) {
      return (parsed as PersistedState).transactions.filter((value): value is Transaction =>
        isValidTransaction(value)
      );
    }

    return [];
  }
}

function isValidTransaction(value: unknown): value is Transaction {
  if (typeof value !== 'object' || value === null) return false;

  const tx = value as Partial<Transaction>;
  return (
    typeof tx.hash === 'string' &&
    typeof tx.orderId === 'string' &&
    typeof tx.marketId === 'string' &&
    typeof tx.createdAt === 'number' &&
    typeof tx.confirmations === 'number' &&
    typeof tx.retryCount === 'number' &&
    typeof tx.status === 'string' &&
    isTransactionStatus(tx.status)
  );
}

function isTransactionStatus(status: string): status is TransactionStatus {
  return (
    status === 'pending' ||
    status === 'submitted' ||
    status === 'confirmed' ||
    status === 'finalized' ||
    status === 'failed' ||
    status === 'expired'
  );
}
