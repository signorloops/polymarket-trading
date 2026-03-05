/**
 * Blockchain Transaction Tracker
 *
 * Monitors on-chain transaction confirmation with polling,
 * retry logic, and state persistence for crash recovery.
 */

import { getLogger } from '../utils/logger.js';
import { NETWORK_CONFIG } from '../utils/config.js';
import { RpcClient } from './rpc-client.js';
import { getErrorMessage } from '../utils/errors.js';
import { createSingleton } from '../utils/singleton.js';
import {
  type Transaction,
  type TransactionUpdate,
  type TransactionHandler,
  TransactionPersistence,
  DEFAULT_CONFIRMATION_BLOCKS,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  POLL_INTERVAL_MS,
  TRANSACTION_TIMEOUT_MS,
  DEFAULT_STATE_FILE_PATH,
  DISABLE_PERSISTENCE_IN_TEST,
} from './transaction-persistence.js';

// Re-export types so existing imports from this file still work
export type {
  Transaction,
  TransactionUpdate,
  TransactionHandler,
} from './transaction-persistence.js';
export type { TransactionStatus } from './transaction-persistence.js';

/**
 * TransactionTracker monitors on-chain transaction status
 */
export class TransactionTracker {
  private transactions: Map<string, Transaction> = new Map();
  private handlers: Set<TransactionHandler> = new Set();
  private pollInterval: NodeJS.Timeout | null = null;
  private logger = getLogger().child({ module: 'TransactionTracker' });
  private rpcClient: RpcClient | null = null;
  private useRealBlockchain = false;
  private persistence: TransactionPersistence;

  constructor(rpcUrl: string = NETWORK_CONFIG.RPC_URL ?? '', stateFilePath?: string) {
    this.rpcClient = rpcUrl
      ? new RpcClient({
          rpcUrl,
          network: 'mainnet',
          chainId: 137,
          confirmationBlocks: 12,
          finalizationBlocks: 128,
        })
      : null;
    this.useRealBlockchain = !!this.rpcClient;

    const resolvedPath =
      DISABLE_PERSISTENCE_IN_TEST && !stateFilePath
        ? ''
        : (stateFilePath ?? process.env.TX_TRACKER_STATE_PATH ?? DEFAULT_STATE_FILE_PATH);
    this.persistence = new TransactionPersistence(resolvedPath);

    const loaded = this.persistence.loadState();
    if (loaded.length > 0) {
      this.loadState(loaded);
    }
  }

  setRpcClient(client: RpcClient): void {
    this.rpcClient = client;
    this.useRealBlockchain = true;
  }

  setPaperTrading(enabled: boolean): void {
    this.useRealBlockchain = !enabled;
  }

  trackTransaction(hash: string, orderId: string, marketId: string): Transaction {
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
    this.logger.info('Tracking new transaction', { hash, orderId, marketId });
    this.startPolling();
    this.persistence.saveState(this.getAllTransactions());
    return tx;
  }

  updateTransaction(update: TransactionUpdate): void {
    const tx = this.transactions.get(update.hash);
    if (!tx) {
      this.logger.warn('Transaction not found for update', { hash: update.hash });
      return;
    }

    const prevStatus = tx.status;
    tx.status = update.status;

    if (update.blockNumber !== undefined) tx.blockNumber = update.blockNumber;
    if (update.confirmations !== undefined) tx.confirmations = update.confirmations;
    if (update.gasUsed !== undefined) tx.gasUsed = update.gasUsed;
    if (update.error !== undefined) {
      tx.lastError = update.error;
      tx.failedAt = Date.now();
    }

    if (update.status === 'submitted' && !tx.submittedAt) tx.submittedAt = Date.now();
    else if (update.status === 'confirmed' && !tx.confirmedAt) tx.confirmedAt = Date.now();
    else if (update.status === 'finalized' && !tx.finalizedAt) tx.finalizedAt = Date.now();

    this.logger.debug('Transaction status updated', {
      hash: update.hash,
      prevStatus,
      newStatus: update.status,
      confirmations: tx.confirmations,
    });

    this.emit(tx);
    this.persistence.saveState(this.getAllTransactions());

    if (update.status === 'finalized' || update.status === 'failed') {
      this.scheduleCleanup(update.hash);
    }
  }

  getTransaction(hash: string): Transaction | undefined {
    return this.transactions.get(hash);
  }

  getTransactionByOrderId(orderId: string): Transaction | undefined {
    for (const tx of this.transactions.values()) {
      if (tx.orderId === orderId) return tx;
    }
    return undefined;
  }

  getPendingTransactions(): Transaction[] {
    return Array.from(this.transactions.values()).filter(
      (tx) => tx.status === 'pending' || tx.status === 'submitted'
    );
  }

  getMarketTransactions(marketId: string): Transaction[] {
    return Array.from(this.transactions.values()).filter((tx) => tx.marketId === marketId);
  }

  getAllTransactions(): Transaction[] {
    return Array.from(this.transactions.values());
  }

  subscribe(handler: TransactionHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

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

    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, tx.retryCount - 1);
    this.logger.info('Scheduling transaction retry', { hash, attempt: tx.retryCount, delay });
    await new Promise((resolve) => setTimeout(resolve, delay));

    this.emit(tx);
    this.persistence.saveState(this.getAllTransactions());
    return true;
  }

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
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Transaction ${hash} confirmation timeout`));
          return;
        }
        if (tx.status === 'confirmed' && tx.confirmations >= confirmations) {
          resolve(tx);
          return;
        }
        if (tx.status === 'finalized') {
          resolve(tx);
          return;
        }
        if (tx.status === 'failed' || tx.status === 'expired') {
          reject(new Error(`Transaction ${hash} failed: ${tx.lastError ?? 'Unknown error'}`));
          return;
        }
        setTimeout(checkStatus, POLL_INTERVAL_MS);
      };
      checkStatus();
    });
  }

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
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Transaction ${hash} finalization timeout`));
          return;
        }
        if (tx.status === 'finalized') {
          resolve(tx);
          return;
        }
        if (tx.status === 'failed' || tx.status === 'expired') {
          reject(new Error(`Transaction ${hash} failed: ${tx.lastError ?? 'Unknown error'}`));
          return;
        }
        setTimeout(checkStatus, POLL_INTERVAL_MS);
      };
      checkStatus();
    });
  }

  removeTransaction(hash: string): boolean {
    const existed = this.transactions.delete(hash);
    if (existed) {
      this.logger.debug('Transaction removed from tracking', { hash });
      this.persistence.saveState(this.getAllTransactions());
    }
    return existed;
  }

  clearOldTransactions(maxAgeMs = 3600000): number {
    const now = Date.now();
    let removed = 0;

    for (const [hash, tx] of this.transactions.entries()) {
      const isComplete =
        tx.status === 'finalized' || tx.status === 'failed' || tx.status === 'expired';
      if (isComplete) {
        const lastUpdate = tx.finalizedAt ?? tx.failedAt ?? tx.confirmedAt ?? tx.createdAt;
        if (now - lastUpdate > maxAgeMs) {
          this.transactions.delete(hash);
          removed++;
        }
      }
    }

    if (removed > 0) {
      this.logger.info(`Cleared ${String(removed)} old transactions`);
      this.persistence.saveState(this.getAllTransactions());
    }
    return removed;
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.persistence.saveState(this.getAllTransactions());
    this.logger.info('Transaction tracker stopped');
  }

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

    if (this.useRealBlockchain && this.rpcClient) {
      for (const tx of this.transactions.values()) {
        try {
          const status = await this.rpcClient.getTransactionStatus(tx.hash);
          if (status.receipt && tx.status !== status.status) {
            const update: TransactionUpdate = { hash: tx.hash, status: status.status };
            if (status.blockNumber !== undefined) update.blockNumber = status.blockNumber;
            update.confirmations = status.confirmations;
            if (status.receipt.gasUsed) update.gasUsed = status.receipt.gasUsed;
            this.updateTransaction(update);
          }
        } catch (error) {
          this.logger.error('Failed to query transaction status', {
            hash: tx.hash,
            error: getErrorMessage(error),
          });
        }
      }
    }

    for (const tx of this.transactions.values()) {
      if (tx.status === 'pending' && now - tx.createdAt > TRANSACTION_TIMEOUT_MS) {
        if (tx.retryCount < MAX_RETRY_ATTEMPTS) {
          this.logger.warn('Transaction pending timeout, triggering retry', {
            hash: tx.hash,
            pendingTime: now - tx.createdAt,
          });
          await this.retryTransaction(tx.hash);
        } else {
          this.logger.error('Transaction pending timeout, max retries reached', { hash: tx.hash });
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
        this.logger.error('Error in transaction handler', { error: getErrorMessage(error) });
      }
    }
  }

  private scheduleCleanup(hash: string): void {
    setTimeout(() => {
      this.removeTransaction(hash);
    }, 3600000).unref();
  }

  loadState(transactions: Transaction[]): void {
    for (const tx of transactions) {
      this.transactions.set(tx.hash, tx);
    }
    this.logger.info(`Loaded ${String(transactions.length)} transactions from storage`);
    this.startPolling();
  }
}

// Singleton instance
const transactionTrackerSingleton = createSingleton(() => new TransactionTracker());

export function getTransactionTracker(_rpcUrl?: string): TransactionTracker {
  return transactionTrackerSingleton.get();
}

export function resetTransactionTracker(): void {
  transactionTrackerSingleton.get().stop();
  transactionTrackerSingleton.reset();
}
