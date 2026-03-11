/**
 * State persistence layer for blockchain transactions
 *
 * Supports multiple backends:
 * - File system (default, for single-instance)
 * - Redis (for distributed deployments)
 * - Memory (for testing)
 *
 * Features:
 * - Atomic writes (write to temp file, then rename)
 * - Version control for migrations
 * - Automatic cleanup of old data
 * - Crash recovery
 */

import { writeFile, readFile, rename, unlink, mkdir, access } from 'fs/promises';
import { dirname } from 'path';
import type { Transaction } from './transaction-tracker.js';
import { getLogger } from '../utils/logger.js';

export interface TransactionState {
  transactions: Transaction[];
  lastBlockNumber: number;
  lastBlockHash: string | null;
  lastUpdatedAt: number;
  version: number;
}

export interface IStateStore {
  save(state: TransactionState): Promise<void>;
  load(): Promise<TransactionState | null>;
  getLastKnownBlock(): Promise<number>;
  markBlockProcessed(blockNumber: number, blockHash: string | null): Promise<void>;
  cleanup(maxAgeMs: number): Promise<void>;
  destroy(): void;
}

export interface StateStoreConfig {
  type: 'file' | 'redis' | 'memory';
  filePath?: string;
  redisUrl?: string;
  maxStateAgeMs?: number;
}

const CURRENT_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * File-based state store with atomic writes
 */
export class FileStateStore implements IStateStore {
  private filePath: string;
  private maxAgeMs: number;
  private logger = getLogger().child({ module: 'FileStateStore' });
  private writeLock = Promise.resolve();

  constructor(filePath: string, maxAgeMs: number = DEFAULT_MAX_AGE_MS) {
    this.filePath = filePath;
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Ensure directory exists
   */
  private async ensureDirectory(): Promise<void> {
    const dir = dirname(this.filePath);
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Save state atomically
   */
  async save(state: TransactionState): Promise<void> {
    // Queue writes to prevent race conditions
    this.writeLock = this.writeLock.then(async () => {
      await this.ensureDirectory();

      const tempPath = `${this.filePath}.tmp`;
      const data: TransactionState = {
        ...state,
        version: CURRENT_VERSION,
        lastUpdatedAt: Date.now(),
      };

      try {
        // Write to temp file first
        await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');

        // Atomic rename
        await rename(tempPath, this.filePath);

        this.logger.debug('State saved', {
          transactions: state.transactions.length,
          lastBlockNumber: state.lastBlockNumber,
        });
      } catch (error) {
        // Clean up temp file on error
        try {
          await unlink(tempPath);
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    });

    await this.writeLock;
  }

  /**
   * Load state from file
   */
  async load(): Promise<TransactionState | null> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const state = JSON.parse(data) as TransactionState;

      // Version migration if needed
      if (state.version !== CURRENT_VERSION) {
        return this.migrateState(state);
      }

      this.logger.info('State loaded', {
        transactions: state.transactions.length,
        lastBlockNumber: state.lastBlockNumber,
      });

      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null; // File doesn't exist yet
      }
      this.logger.error('Failed to load state', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get last known block number
   */
  async getLastKnownBlock(): Promise<number> {
    const state = await this.load();
    return state?.lastBlockNumber ?? 0;
  }

  /**
   * Mark a block as processed
   */
  async markBlockProcessed(blockNumber: number, blockHash: string | null): Promise<void> {
    const state = (await this.load()) ?? {
      transactions: [],
      lastBlockNumber: 0,
      lastBlockHash: null,
      lastUpdatedAt: 0,
      version: CURRENT_VERSION,
    };

    state.lastBlockNumber = Math.max(state.lastBlockNumber, blockNumber);
    if (blockHash) {
      state.lastBlockHash = blockHash;
    }
    state.lastUpdatedAt = Date.now();

    await this.save(state);
  }

  /**
   * Clean up old transactions
   */
  async cleanup(maxAgeMs: number = this.maxAgeMs): Promise<void> {
    const state = await this.load();
    if (!state) return;

    const now = Date.now();
    const cutoff = now - maxAgeMs;

    const originalCount = state.transactions.length;
    state.transactions = state.transactions.filter((tx) => {
      // Keep transactions that are not finalized/failed and are recent
      const isComplete =
        tx.status === 'finalized' || tx.status === 'failed' || tx.status === 'expired';
      const lastUpdate = tx.finalizedAt ?? tx.failedAt ?? tx.confirmedAt ?? tx.createdAt;

      return !isComplete || lastUpdate > cutoff;
    });

    const removed = originalCount - state.transactions.length;
    if (removed > 0) {
      await this.save(state);
      this.logger.info(`Cleaned up ${String(removed)} old transactions`);
    }
  }

  /**
   * Migrate old state versions
   */
  private migrateState(oldState: TransactionState): TransactionState {
    this.logger.warn('Migrating state from version', { version: oldState.version });

    // For now, just ensure all required fields exist
    return {
      transactions: oldState.transactions,
      lastBlockNumber: oldState.lastBlockNumber,
      lastBlockHash: oldState.lastBlockHash,
      lastUpdatedAt: oldState.lastUpdatedAt,
      version: CURRENT_VERSION,
    };
  }

  destroy(): void {
    // File store doesn't need explicit cleanup
  }
}

/**
 * Memory-based state store (for testing)
 */
export class MemoryStateStore implements IStateStore {
  private state: TransactionState | null = null;

  save(state: TransactionState): Promise<void> {
    this.state = { ...state, version: CURRENT_VERSION, lastUpdatedAt: Date.now() };
    return Promise.resolve();
  }

  load(): Promise<TransactionState | null> {
    return Promise.resolve(this.state ? { ...this.state } : null);
  }

  getLastKnownBlock(): Promise<number> {
    return Promise.resolve(this.state?.lastBlockNumber ?? 0);
  }

  markBlockProcessed(blockNumber: number, blockHash: string | null): Promise<void> {
    if (!this.state) {
      this.state = {
        transactions: [],
        lastBlockNumber: blockNumber,
        lastBlockHash: blockHash,
        lastUpdatedAt: Date.now(),
        version: CURRENT_VERSION,
      };
    } else {
      this.state.lastBlockNumber = Math.max(this.state.lastBlockNumber, blockNumber);
      if (blockHash) {
        this.state.lastBlockHash = blockHash;
      }
      this.state.lastUpdatedAt = Date.now();
    }
    return Promise.resolve();
  }

  cleanup(maxAgeMs: number): Promise<void> {
    if (!this.state) {
      return Promise.resolve();
    }

    const cutoff = Date.now() - maxAgeMs;
    this.state.transactions = this.state.transactions.filter((tx) => {
      const isComplete =
        tx.status === 'finalized' || tx.status === 'failed' || tx.status === 'expired';
      const lastUpdate = tx.finalizedAt ?? tx.failedAt ?? tx.confirmedAt ?? tx.createdAt;
      return !isComplete || lastUpdate > cutoff;
    });
    return Promise.resolve();
  }

  destroy(): void {
    this.state = null;
  }

  // For testing: directly set state
  setState(state: TransactionState | null): void {
    this.state = state;
  }
}

/**
 * Factory to create appropriate store
 */
export function createStateStore(config: StateStoreConfig): IStateStore {
  switch (config.type) {
    case 'file':
      return new FileStateStore(
        config.filePath ?? './data/transactions.json',
        config.maxStateAgeMs
      );
    case 'memory':
      return new MemoryStateStore();
    case 'redis':
      // For now, fallback to file since Redis would need ioredis dependency
      console.warn('Redis store not yet implemented, using file store');
      return new FileStateStore(
        config.filePath ?? './data/transactions.json',
        config.maxStateAgeMs
      );
    default:
      throw new Error('Unknown state store type');
  }
}
