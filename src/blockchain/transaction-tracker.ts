/**
 * Blockchain Transaction Tracker
 *
 * Handles on-chain transaction confirmation with:
 * - Transaction hash tracking
 * - Block confirmation waiting
 * - Status polling (Pending -> Confirmed -> Finalized)
 * - Retry logic with exponential backoff
 * - State persistence for crash recovery
 */

import { getLogger } from '../utils/logger.js';
import { NETWORK_CONFIG } from '../utils/config.js';
import { RpcClient } from './rpc-client.js';
import fs from 'node:fs';
import path from 'node:path';

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

type TransactionHandler = (tx: Transaction) => void;

// Configuration
const DEFAULT_CONFIRMATION_BLOCKS = 12; // Polygon recommended
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1000;
const POLL_INTERVAL_MS = 2000;
const TRANSACTION_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_STATE_FILE_PATH = path.join(process.cwd(), '.state', 'transaction-tracker.json');
const DISABLE_PERSISTENCE_IN_TEST = process.env.NODE_ENV === 'test';

interface PersistedState {
  transactions: Transaction[];
  savedAt: number;
}

/**
 * TransactionTracker monitors on-chain transaction status
 */
export class TransactionTracker {
  private transactions: Map<string, Transaction> = new Map();
  private handlers: Set<TransactionHandler> = new Set();
  private pollInterval: NodeJS.Timeout | null = null;
  private logger = getLogger().child({ module: 'TransactionTracker' });
  private rpcUrl: string;
  private rpcClient: RpcClient | null = null;
  private useRealBlockchain = false;
  private stateFilePath: string;

  constructor(rpcUrl: string = NETWORK_CONFIG.RPC_URL ?? '', stateFilePath?: string) {
    this.rpcUrl = rpcUrl;
    this.rpcClient = rpcUrl ? new RpcClient({
      rpcUrl,
      network: 'mainnet',
      chainId: 137,
      confirmationBlocks: 12,
      finalizationBlocks: 128,
    }) : null;
    this.useRealBlockchain = !!this.rpcClient;
    this.stateFilePath = DISABLE_PERSISTENCE_IN_TEST && !stateFilePath
      ? ''
      : (stateFilePath ?? process.env.TX_TRACKER_STATE_PATH ?? DEFAULT_STATE_FILE_PATH);

    this.loadStateFromDisk();
  }

  /**
   * Set RPC client for blockchain queries
   */
  setRpcClient(client: RpcClient): void {
    this.rpcClient = client;
    this.useRealBlockchain = true;
  }

  /**
   * Enable/disable paper trading mode
   */
  setPaperTrading(enabled: boolean): void {
    this.useRealBlockchain = !enabled;
  }

  /**
   * Start tracking a new transaction
   */
  trackTransaction(
    hash: string,
    orderId: string,
    marketId: string
  ): Transaction {
    const tx: Transaction = {
      hash,
      orderId,
      marketId,
      status: 'pending',
      createdAt: Date.now(),
      confirmations: 0,
      retryCount: 0,
    };

    this.transactions.set(hash, tx);
    this.logger.info('Tracking new transaction', {
      hash,
      orderId,
      marketId,
    });

    this.startPolling();
    this.saveState();

    return tx;
  }

  /**
   * Update transaction status
   */
  updateTransaction(update: TransactionUpdate): void {
    const tx = this.transactions.get(update.hash);
    if (!tx) {
      this.logger.warn('Transaction not found for update', { hash: update.hash });
      return;
    }

    const prevStatus = tx.status;
    tx.status = update.status;

    if (update.blockNumber !== undefined) {
      tx.blockNumber = update.blockNumber;
    }
    if (update.confirmations !== undefined) {
      tx.confirmations = update.confirmations;
    }
    if (update.gasUsed !== undefined) {
      tx.gasUsed = update.gasUsed;
    }
    if (update.error !== undefined) {
      tx.lastError = update.error;
      tx.failedAt = Date.now();
    }

    // Update timestamps based on status transitions
    if (update.status === 'submitted' && !tx.submittedAt) {
      tx.submittedAt = Date.now();
    } else if (update.status === 'confirmed' && !tx.confirmedAt) {
      tx.confirmedAt = Date.now();
    } else if (update.status === 'finalized' && !tx.finalizedAt) {
      tx.finalizedAt = Date.now();
    }

    this.logger.debug('Transaction status updated', {
      hash: update.hash,
      prevStatus,
      newStatus: update.status,
      confirmations: tx.confirmations,
    });

    this.emit(tx);
    this.saveState();

    // Clean up finalized or failed transactions after a delay
    if (update.status === 'finalized' || update.status === 'failed') {
      this.scheduleCleanup(update.hash);
    }
  }

  /**
   * Get transaction by hash
   */
  getTransaction(hash: string): Transaction | undefined {
    return this.transactions.get(hash);
  }

  /**
   * Get transaction by order ID
   */
  getTransactionByOrderId(orderId: string): Transaction | undefined {
    for (const tx of this.transactions.values()) {
      if (tx.orderId === orderId) {
        return tx;
      }
    }
    return undefined;
  }

  /**
   * Get all pending transactions
   */
  getPendingTransactions(): Transaction[] {
    return Array.from(this.transactions.values()).filter(
      (tx) => tx.status === 'pending' || tx.status === 'submitted'
    );
  }

  /**
   * Get all transactions for a market
   */
  getMarketTransactions(marketId: string): Transaction[] {
    return Array.from(this.transactions.values()).filter(
      (tx) => tx.marketId === marketId
    );
  }

  /**
   * Get all transactions
   */
  getAllTransactions(): Transaction[] {
    return Array.from(this.transactions.values());
  }

  /**
   * Subscribe to transaction updates
   */
  subscribe(handler: TransactionHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Retry a failed transaction
   */
  async retryTransaction(hash: string): Promise<boolean> {
    const tx = this.transactions.get(hash);
    if (!tx) {
      this.logger.warn('Cannot retry unknown transaction', { hash });
      return false;
    }

    if (tx.retryCount >= MAX_RETRY_ATTEMPTS) {
      this.logger.error('Max retry attempts reached for transaction', {
        hash,
        retryCount: tx.retryCount,
      });
      tx.status = 'expired';
      this.emit(tx);
      return false;
    }

    tx.retryCount++;
    tx.status = 'pending';
    delete tx.lastError;

    // Calculate exponential backoff delay
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, tx.retryCount - 1);
    this.logger.info(`Scheduling transaction retry`, {
      hash,
      attempt: tx.retryCount,
      delay,
    });

    await new Promise((resolve) => setTimeout(resolve, delay));

    // Emit for external handling (the actual resubmission must be done by the caller)
    this.emit(tx);
    this.saveState();

    return true;
  }

  /**
   * Wait for transaction confirmation
   */
  async waitForConfirmation(
    hash: string,
    confirmations: number = DEFAULT_CONFIRMATION_BLOCKS,
    timeoutMs: number = TRANSACTION_TIMEOUT_MS
  ): Promise<Transaction> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkStatus = () => {
        const tx = this.transactions.get(hash);

        if (!tx) {
          reject(new Error(`Transaction ${hash} not found`));
          return;
        }

        // Check for timeout
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Transaction ${hash} confirmation timeout`));
          return;
        }

        // Check if confirmed with enough blocks
        if (
          tx.status === 'confirmed' &&
          tx.confirmations >= confirmations
        ) {
          resolve(tx);
          return;
        }

        // Check if finalized
        if (tx.status === 'finalized') {
          resolve(tx);
          return;
        }

        // Check if failed
        if (tx.status === 'failed' || tx.status === 'expired') {
          reject(new Error(`Transaction ${hash} failed: ${tx.lastError ?? 'Unknown error'}`));
          return;
        }

        // Continue waiting
        setTimeout(checkStatus, POLL_INTERVAL_MS);
      };

      checkStatus();
    });
  }

  /**
   * Wait for transaction finalization
   */
  async waitForFinalization(
    hash: string,
    timeoutMs: number = TRANSACTION_TIMEOUT_MS * 2
  ): Promise<Transaction> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkStatus = () => {
        const tx = this.transactions.get(hash);

        if (!tx) {
          reject(new Error(`Transaction ${hash} not found`));
          return;
        }

        // Check for timeout
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Transaction ${hash} finalization timeout`));
          return;
        }

        // Check if finalized
        if (tx.status === 'finalized') {
          resolve(tx);
          return;
        }

        // Check if failed
        if (tx.status === 'failed' || tx.status === 'expired') {
          reject(new Error(`Transaction ${hash} failed: ${tx.lastError ?? 'Unknown error'}`));
          return;
        }

        // Continue waiting
        setTimeout(checkStatus, POLL_INTERVAL_MS);
      };

      checkStatus();
    });
  }

  /**
   * Remove a transaction from tracking
   */
  removeTransaction(hash: string): boolean {
    const existed = this.transactions.delete(hash);
    if (existed) {
      this.logger.debug('Transaction removed from tracking', { hash });
      this.saveState();
    }
    return existed;
  }

  /**
   * Clear old completed transactions
   */
  clearOldTransactions(maxAgeMs = 3600000): number {
    const now = Date.now();
    let removed = 0;

    for (const [hash, tx] of this.transactions.entries()) {
      const isComplete =
        tx.status === 'finalized' ||
        tx.status === 'failed' ||
        tx.status === 'expired';

      if (isComplete) {
        const lastUpdate =
          tx.finalizedAt ?? tx.failedAt ?? tx.confirmedAt ?? tx.createdAt;

        if (now - lastUpdate > maxAgeMs) {
          this.transactions.delete(hash);
          removed++;
        }
      }
    }

    if (removed > 0) {
      this.logger.info(`Cleared ${String(removed)} old transactions`);
      this.saveState();
    }

    return removed;
  }

  /**
   * Stop the tracker and cleanup
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.saveState();
    this.logger.info('Transaction tracker stopped');
  }

  /**
   * Get tracker statistics
   */
  getStats(): {
    total: number;
    pending: number;
    submitted: number;
    confirmed: number;
    finalized: number;
    failed: number;
    expired: number;
  } {
    const stats = {
      total: this.transactions.size,
      pending: 0,
      submitted: 0,
      confirmed: 0,
      finalized: 0,
      failed: 0,
      expired: 0,
    };

    for (const tx of this.transactions.values()) {
      switch (tx.status) {
        case 'pending':
          stats.pending++;
          break;
        case 'submitted':
          stats.submitted++;
          break;
        case 'confirmed':
          stats.confirmed++;
          break;
        case 'finalized':
          stats.finalized++;
          break;
        case 'failed':
          stats.failed++;
          break;
        case 'expired':
          stats.expired++;
          break;
      }
    }

    return stats;
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
      void this.pollTransactions();
    }, POLL_INTERVAL_MS);

    this.pollInterval.unref();
  }

  private async pollTransactions(): Promise<void> {
    const now = Date.now();

    // Query blockchain if RPC client is available
    if (this.useRealBlockchain && this.rpcClient) {
      for (const tx of this.transactions.values()) {
        try {
          const status = await this.rpcClient.getTransactionStatus(tx.hash);

          if (status.receipt && tx.status !== status.status) {
            const update: TransactionUpdate = {
              hash: tx.hash,
              status: status.status,
            };
            if (status.blockNumber !== undefined) {
              update.blockNumber = status.blockNumber;
            }
            update.confirmations = status.confirmations;
            if (status.receipt.gasUsed) {
              update.gasUsed = status.receipt.gasUsed;
            }
            this.updateTransaction(update);
          }
        } catch (error) {
          this.logger.error('Failed to query transaction status', {
            hash: tx.hash,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Check for pending transaction timeouts
    for (const tx of this.transactions.values()) {
      if (tx.status === 'pending' && now - tx.createdAt > TRANSACTION_TIMEOUT_MS) {
        if (tx.retryCount < MAX_RETRY_ATTEMPTS) {
          this.logger.warn('Transaction pending timeout, triggering retry', {
            hash: tx.hash,
            pendingTime: now - tx.createdAt,
          });
          await this.retryTransaction(tx.hash);
        } else {
          this.logger.error('Transaction pending timeout, max retries reached', {
            hash: tx.hash,
          });
          this.updateTransaction({
            hash: tx.hash,
            status: 'expired',
            error: 'Transaction timeout - max retries reached',
          });
        }
      }
    }
  }

  private emit(tx: Transaction): void {
    for (const handler of this.handlers) {
      try {
        handler(tx);
      } catch (error) {
        this.logger.error('Error in transaction handler', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private scheduleCleanup(hash: string): void {
    // Remove finalized/failed transactions after 1 hour
    setTimeout(
      () => {
        this.removeTransaction(hash);
      },
      3600000
    ).unref();
  }

  /**
   * Save state for crash recovery
   */
  private saveState(): void {
    if (!this.stateFilePath) {
      return;
    }

    const state: PersistedState = {
      transactions: this.getAllTransactions(),
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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private loadStateFromDisk(): void {
    if (!this.stateFilePath) {
      return;
    }

    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return;
      }

      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      if (!raw.trim()) {
        return;
      }

      const parsed: unknown = JSON.parse(raw);
      const transactions = this.extractTransactions(parsed);

      if (transactions.length > 0) {
        this.loadState(transactions);
      }
    } catch (error) {
      this.logger.error('Failed to load transaction tracker state', {
        file: this.stateFilePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private extractTransactions(parsed: unknown): Transaction[] {
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is Transaction => this.isValidTransaction(value));
    }

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'transactions' in parsed &&
      Array.isArray((parsed as PersistedState).transactions)
    ) {
      return (parsed as PersistedState).transactions.filter((value): value is Transaction =>
        this.isValidTransaction(value)
      );
    }

    return [];
  }

  private isValidTransaction(value: unknown): value is Transaction {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const tx = value as Partial<Transaction>;
    return (
      typeof tx.hash === 'string' &&
      typeof tx.orderId === 'string' &&
      typeof tx.marketId === 'string' &&
      typeof tx.createdAt === 'number' &&
      typeof tx.confirmations === 'number' &&
      typeof tx.retryCount === 'number' &&
      typeof tx.status === 'string' &&
      this.isTransactionStatus(tx.status)
    );
  }

  private isTransactionStatus(status: string): status is TransactionStatus {
    return (
      status === 'pending' ||
      status === 'submitted' ||
      status === 'confirmed' ||
      status === 'finalized' ||
      status === 'failed' ||
      status === 'expired'
    );
  }

  /**
   * Load state from persistent storage
   */
  loadState(transactions: Transaction[]): void {
    for (const tx of transactions) {
      this.transactions.set(tx.hash, tx);
    }
    this.logger.info(`Loaded ${String(transactions.length)} transactions from storage`);
    this.startPolling();
  }
}

// Singleton instance
let globalTracker: TransactionTracker | null = null;

export function getTransactionTracker(rpcUrl?: string): TransactionTracker {
  globalTracker ??= new TransactionTracker(rpcUrl);
  return globalTracker;
}

export function resetTransactionTracker(): void {
  globalTracker?.stop();
  globalTracker = null;
}
