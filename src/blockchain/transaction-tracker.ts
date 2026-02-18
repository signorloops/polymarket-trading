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
import type { IRpcClient, TransactionReceipt } from './rpc-client.js';
import type { IStateStore } from './state-store.js';

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
  blockHash?: string;
  confirmations: number;
  retryCount: number;
  lastError?: string;
  gasPrice?: string;
  gasUsed?: string;
}

export interface ReorgEvent {
  depth: number;
  oldBlockHash: string;
  newBlockHash: string;
  affectedTransactions: string[];
  blockNumber: number;
}

export interface GasPriceAlert {
  thresholdGwei: number;
  currentGasPrice: string;
  timestamp: number;
}

type ReorgHandler = (event: ReorgEvent) => void;
type GasPriceHandler = (alert: GasPriceAlert) => void;

export interface TransactionUpdate {
  hash: string;
  status: TransactionStatus;
  blockNumber?: number;
  confirmations?: number;
  gasUsed?: string;
  error?: string;
}

type TransactionHandler = (tx: Transaction) => void;

// Configuration
const DEFAULT_CONFIRMATION_BLOCKS = 12; // Polygon recommended
const DEFAULT_FINALIZATION_BLOCKS = 128; // ~4 minutes on Polygon
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1000;
const POLL_INTERVAL_MS = 2000;
const TRANSACTION_TIMEOUT_MS = 300000; // 5 minutes

/**
 * TransactionTracker monitors on-chain transaction status
 */
export class TransactionTracker {
  private transactions: Map<string, Transaction> = new Map();
  private handlers: Set<TransactionHandler> = new Set();
  private reorgHandlers: Set<ReorgHandler> = new Set();
  private gasPriceHandlers: Map<number, GasPriceHandler> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private logger = getLogger().child({ module: 'TransactionTracker' });
  private rpcUrl: string;
  private rpcClient: IRpcClient | null = null;
  private stateStore: IStateStore | null = null;
  private lastBlockNumber = 0;
  private lastBlockHash: string | null = null;
  private confirmationBlocks: number;
  private finalizationBlocks: number;
  private stuckThresholdMs: number;
  private gasPriceThresholdGwei: number | null = null;
  private isDestroyed = false;

  constructor(
    rpcUrl: string = NETWORK_CONFIG.RPC_URL ?? '',
    options: {
      rpcClient?: IRpcClient;
      stateStore?: IStateStore;
      confirmationBlocks?: number;
      finalizationBlocks?: number;
      stuckThresholdMs?: number;
      gasPriceThresholdGwei?: number;
    } = {}
  ) {
    this.rpcUrl = rpcUrl;
    this.rpcClient = options.rpcClient ?? null;
    this.stateStore = options.stateStore ?? null;
    this.confirmationBlocks = options.confirmationBlocks ?? DEFAULT_CONFIRMATION_BLOCKS;
    this.finalizationBlocks = options.finalizationBlocks ?? DEFAULT_FINALIZATION_BLOCKS;
    this.stuckThresholdMs = options.stuckThresholdMs ?? TRANSACTION_TIMEOUT_MS;
    this.gasPriceThresholdGwei = options.gasPriceThresholdGwei ?? null;
  }

  /**
   * Set RPC client for blockchain queries
   */
  setRpcClient(client: IRpcClient): void {
    this.rpcClient = client;
  }

  /**
   * Set state store for persistence
   */
  setStateStore(store: IStateStore): void {
    this.stateStore = store;
  }

  /**
   * Initialize tracker and restore state
   */
  async initialize(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('TransactionTracker has been destroyed');
    }

    if (this.stateStore) {
      try {
        const state = await this.stateStore.load();
        if (state?.transactions?.length) {
          for (const tx of state.transactions) {
            this.transactions.set(tx.hash, tx);
          }
          this.lastBlockNumber = state.lastBlockNumber ?? 0;
          this.lastBlockHash = state.lastBlockHash ?? null;
          this.logger.info('Restored state from storage', {
            transactions: state.transactions.length,
            lastBlockNumber: this.lastBlockNumber,
          });
        }
      } catch (error) {
        this.logger.error('Failed to load state', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.startPolling();
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
  clearOldTransactions(maxAgeMs: number = 3600000): number {
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
      this.logger.info(`Cleared ${removed} old transactions`);
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
      this.pollTransactions();
    }, POLL_INTERVAL_MS);

    this.pollInterval.unref?.();
  }

  private async pollTransactions(): Promise<void> {
    if (this.isDestroyed) return;

    const now = Date.now();

    // If RPC client is available, query blockchain for transaction status
    if (this.rpcClient) {
      try {
        const currentBlock = await this.rpcClient.getBlockNumber();

        // Update our tracking of the chain tip
        if (currentBlock > this.lastBlockNumber) {
          this.lastBlockNumber = currentBlock;

          // Check for reorgs if we have a previous block hash
          if (this.lastBlockHash) {
            await this.detectReorg(currentBlock);
          }

          // Update last block hash
          try {
            const block = await this.rpcClient.getBlock('latest');
            this.lastBlockHash = block.hash;
            await this.stateStore?.markBlockProcessed(currentBlock, block.hash);
          } catch {
            // Non-critical, continue
          }
        }

        // Check gas price thresholds
        await this.checkGasPrice();

        // Query pending and submitted transactions
        for (const tx of this.getPendingTransactions()) {
          await this.queryTransactionStatus(tx, currentBlock);
        }

      } catch (error) {
        this.logger.error('Error polling blockchain', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Check for stuck transactions (local timeout logic)
    for (const tx of this.transactions.values()) {
      if (tx.status === 'pending' && now - tx.createdAt > this.stuckThresholdMs) {
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

    // Persist state after polling
    await this.saveState();
  }

  /**
   * Query transaction status from blockchain
   */
  private async queryTransactionStatus(tx: Transaction, currentBlock: number): Promise<void> {
    if (!this.rpcClient) return;

    try {
      const receipt = await this.rpcClient.getTransactionReceipt(tx.hash);

      if (!receipt) {
        // Transaction is still pending (not yet mined)
        return;
      }

      // Calculate confirmations
      const confirmations = currentBlock - receipt.blockNumber + 1;

      // Update transaction with receipt data
      const update: TransactionUpdate = {
        hash: tx.hash,
        status: tx.status,
        blockNumber: receipt.blockNumber,
        confirmations,
        gasUsed: receipt.gasUsed,
      };

      if (receipt.status === 'failed') {
        update.status = 'failed';
        update.error = 'Transaction reverted on-chain';
      } else if (confirmations >= this.finalizationBlocks) {
        update.status = 'finalized';
      } else if (confirmations >= this.confirmationBlocks) {
        update.status = 'confirmed';
      } else if (receipt.blockNumber) {
        update.status = 'submitted';
      }

      // Store block hash for reorg detection
      if (receipt.blockHash && !tx.blockHash) {
        tx.blockHash = receipt.blockHash;
      }

      this.updateTransaction(update);

    } catch (error) {
      this.logger.error('Failed to query transaction status', {
        hash: tx.hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Detect blockchain reorganization
   */
  private async detectReorg(currentBlock: number): Promise<void> {
    if (!this.rpcClient || !this.lastBlockHash) return;

    try {
      // Get the block at our last known height
      // If the hash changed, a reorg occurred
      const block = await this.rpcClient.getBlock(this.lastBlockNumber);

      if (block.hash !== this.lastBlockHash) {
        const depth = currentBlock - this.lastBlockNumber;

        this.logger.warn('Blockchain reorganization detected', {
          depth,
          oldBlockHash: this.lastBlockHash,
          newBlockHash: block.hash,
          blockNumber: this.lastBlockNumber,
        });

        // Find affected transactions
        const affectedTransactions: string[] = [];

        for (const [hash, tx] of this.transactions.entries()) {
          // Transactions confirmed in the reorged blocks need to be rechecked
          if (tx.blockNumber &&
              tx.blockNumber >= this.lastBlockNumber - depth &&
              tx.blockNumber <= this.lastBlockNumber) {

            // Check if this transaction is in the new chain
            try {
              const receipt = await this.rpcClient.getTransactionReceipt(hash);
              if (!receipt || receipt.blockHash !== tx.blockHash) {
                // Transaction was affected by reorg
                affectedTransactions.push(hash);

                // Reset to pending for re-checking
                this.updateTransaction({
                  hash,
                  status: 'pending',
                  error: `Block reorganization detected at block ${this.lastBlockNumber}`,
                });
              }
            } catch {
              affectedTransactions.push(hash);
            }
          }
        }

        // Emit reorg event
        const event: ReorgEvent = {
          depth,
          oldBlockHash: this.lastBlockHash,
          newBlockHash: block.hash,
          affectedTransactions,
          blockNumber: this.lastBlockNumber,
        };

        this.emitReorg(event);

        // Update our tracking
        this.lastBlockHash = block.hash;
      }
    } catch (error) {
      this.logger.error('Error detecting reorg', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check gas price and trigger alerts
   */
  private async checkGasPrice(): Promise<void> {
    if (!this.rpcClient || !this.gasPriceThresholdGwei || this.gasPriceHandlers.size === 0) {
      return;
    }

    try {
      const gasPrice = await this.rpcClient.getGasPrice();
      const currentGwei = parseInt(gasPrice.standard) / 1e9;

      if (currentGwei > this.gasPriceThresholdGwei) {
        const alert: GasPriceAlert = {
          thresholdGwei: this.gasPriceThresholdGwei,
          currentGasPrice: gasPrice.standard,
          timestamp: Date.now(),
        };

        this.emitGasPriceAlert(alert);
      }
    } catch {
      // Non-critical, skip
    }
  }

  /**
   * Subscribe to reorg events
   */
  onReorg(handler: ReorgHandler): () => void {
    this.reorgHandlers.add(handler);
    return () => this.reorgHandlers.delete(handler);
  }

  /**
   * Subscribe to gas price alerts
   */
  onHighGasPrice(thresholdGwei: number, handler: GasPriceHandler): () => void {
    this.gasPriceThresholdGwei = thresholdGwei;
    this.gasPriceHandlers.set(thresholdGwei, handler);
    return () => this.gasPriceHandlers.delete(thresholdGwei);
  }

  private emitReorg(event: ReorgEvent): void {
    for (const handler of this.reorgHandlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error('Error in reorg handler', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private emitGasPriceAlert(alert: GasPriceAlert): void {
    for (const handler of this.gasPriceHandlers.values()) {
      try {
        handler(alert);
      } catch (error) {
        this.logger.error('Error in gas price handler', {
          error: error instanceof Error ? error.message : String(error),
        });
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
    ).unref?.();
  }

  /**
   * Save state for crash recovery
   */
  async saveState(): Promise<void> {
    if (!this.stateStore || this.isDestroyed) return;

    try {
      await this.stateStore.save({
        transactions: this.getAllTransactions(),
        lastBlockNumber: this.lastBlockNumber,
        lastBlockHash: this.lastBlockHash,
        lastUpdatedAt: Date.now(),
        version: 1,
      });
    } catch (error) {
      this.logger.error('Failed to save state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load state from persistent storage
   * @deprecated Use initialize() instead
   */
  loadState(transactions: Transaction[]): void {
    for (const tx of transactions) {
      this.transactions.set(tx.hash, tx);
    }
    this.logger.info(`Loaded ${transactions.length} transactions from storage`);
    this.startPolling();
  }

  /**
   * Get recently confirmed transactions (for reorg detection)
   */
  getRecentlyConfirmedTransactions(): Transaction[] {
    return Array.from(this.transactions.values()).filter(
      tx => (tx.status === 'confirmed' || tx.status === 'finalized') &&
            tx.blockNumber !== undefined &&
            this.lastBlockNumber - tx.blockNumber < this.finalizationBlocks
    );
  }

  /**
   * Wait for critical transactions to confirm before shutting down
   */
  async waitForCriticalTransactions(timeoutMs: number): Promise<void> {
    const criticalStatuses = ['pending', 'submitted'];
    const critical = this.getAllTransactions().filter(
      tx => criticalStatuses.includes(tx.status)
    );

    if (critical.length === 0) return;

    this.logger.info(`Waiting for ${critical.length} critical transactions`, {
      timeoutMs,
      hashes: critical.map(tx => tx.hash),
    });

    const startTime = Date.now();

    return new Promise((resolve) => {
      const check = () => {
        const pending = this.getAllTransactions().filter(
          tx => criticalStatuses.includes(tx.status)
        );

        if (pending.length === 0 || Date.now() - startTime > timeoutMs) {
          resolve();
          return;
        }

        setTimeout(check, 1000);
      };

      check();
    });
  }

  /**
   * Gracefully destroy the tracker
   */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;

    this.logger.info('Destroying TransactionTracker...');
    this.isDestroyed = true;

    // Stop polling
    this.stop();

    // Final state save
    await this.saveState();

    // Clean up handlers
    this.handlers.clear();
    this.reorgHandlers.clear();
    this.gasPriceHandlers.clear();

    // Clean up RPC client
    this.rpcClient?.destroy();

    // Clean up state store
    this.stateStore?.destroy();

    this.logger.info('TransactionTracker destroyed');
  }
}

// Singleton instance
let globalTracker: TransactionTracker | null = null;

export function getTransactionTracker(
  rpcUrl?: string,
  options?: {
    rpcClient?: IRpcClient;
    stateStore?: IStateStore;
    confirmationBlocks?: number;
    finalizationBlocks?: number;
  }
): TransactionTracker {
  if (!globalTracker) {
    globalTracker = new TransactionTracker(rpcUrl, options);
  }
  return globalTracker;
}

export async function initializeTransactionTracker(): Promise<TransactionTracker> {
  if (!globalTracker) {
    throw new Error('TransactionTracker not created. Call getTransactionTracker first.');
  }
  await globalTracker.initialize();
  return globalTracker;
}

export async function resetTransactionTracker(): Promise<void> {
  if (globalTracker) {
    await globalTracker.destroy();
    globalTracker = null;
  }
}
