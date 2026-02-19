/**
 * Unit tests for Transaction Tracker
 */

import { jest } from '@jest/globals';
import type { TransactionTracker, Transaction } from '../../src/blockchain/transaction-tracker.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  getLogger: jest.fn(() => mockLogger),
  createSilentLogger: jest.fn(() => mockLogger),
}));

jest.unstable_mockModule('../../src/utils/config.js', () => ({
  NETWORK_CONFIG: {
    RPC_URL: 'https://test-rpc.com',
  },
}));

const { TransactionTracker: TransactionTrackerClass, getTransactionTracker, resetTransactionTracker } = await import('../../src/blockchain/transaction-tracker.js');

describe('TransactionTracker', () => {
  let tracker: InstanceType<typeof TransactionTrackerClass>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();

    resetTransactionTracker();
    tracker = new TransactionTrackerClass('https://test-rpc.com');
  });

  afterEach(() => {
    tracker?.stop();
    resetTransactionTracker();
    jest.useRealTimers();
  });

  describe('trackTransaction', () => {
    it('should start tracking a new transaction', () => {
      const tx = tracker.trackTransaction(
        '0xabc123',
        'order-1',
        'market-1'
      );

      expect(tx.hash).toBe('0xabc123');
      expect(tx.orderId).toBe('order-1');
      expect(tx.marketId).toBe('market-1');
      expect(tx.status).toBe('pending');
      expect(tx.confirmations).toBe(0);
      expect(tx.retryCount).toBe(0);
    });

    it('should store transaction for retrieval', () => {
      tracker.trackTransaction('0xabc123', 'order-1', 'market-1');

      const retrieved = tracker.getTransaction('0xabc123');
      expect(retrieved).toBeDefined();
      expect(retrieved?.hash).toBe('0xabc123');
    });
  });

  describe('updateTransaction', () => {
    it('should update transaction status', () => {
      tracker.trackTransaction('0xabc123', 'order-1', 'market-1');

      tracker.updateTransaction({
        hash: '0xabc123',
        status: 'submitted',
      });

      const tx = tracker.getTransaction('0xabc123');
      expect(tx?.status).toBe('submitted');
      expect(tx?.submittedAt).toBeDefined();
    });

    it('should update confirmations', () => {
      tracker.trackTransaction('0xabc123', 'order-1', 'market-1');

      tracker.updateTransaction({
        hash: '0xabc123',
        status: 'confirmed',
        blockNumber: 12345,
        confirmations: 12,
      });

      const tx = tracker.getTransaction('0xabc123');
      expect(tx?.status).toBe('confirmed');
      expect(tx?.blockNumber).toBe(12345);
      expect(tx?.confirmations).toBe(12);
      expect(tx?.confirmedAt).toBeDefined();
    });

    it('should handle failed transactions', () => {
      tracker.trackTransaction('0xabc123', 'order-1', 'market-1');

      tracker.updateTransaction({
        hash: '0xabc123',
        status: 'failed',
        error: 'Out of gas',
      });

      const tx = tracker.getTransaction('0xabc123');
      expect(tx?.status).toBe('failed');
      expect(tx?.lastError).toBe('Out of gas');
      expect(tx?.failedAt).toBeDefined();
    });

    it('should warn when updating unknown transaction', () => {
      tracker.updateTransaction({
        hash: '0xunknown',
        status: 'confirmed',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Transaction not found for update',
        expect.objectContaining({ hash: '0xunknown' })
      );
    });
  });

  describe('getPendingTransactions', () => {
    it('should return only pending and submitted transactions', () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');
      tracker.trackTransaction('0xtx2', 'order-2', 'market-1');
      tracker.trackTransaction('0xtx3', 'order-3', 'market-2');

      tracker.updateTransaction({ hash: '0xtx2', status: 'confirmed' });
      tracker.updateTransaction({ hash: '0xtx3', status: 'failed' });

      const pending = tracker.getPendingTransactions();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.hash).toBe('0xtx1');
    });
  });

  describe('getMarketTransactions', () => {
    it('should return transactions for specific market', () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');
      tracker.trackTransaction('0xtx2', 'order-2', 'market-1');
      tracker.trackTransaction('0xtx3', 'order-3', 'market-2');

      const marketTxs = tracker.getMarketTransactions('market-1');
      expect(marketTxs).toHaveLength(2);
      expect(marketTxs.map((t) => t.hash)).toContain('0xtx1');
      expect(marketTxs.map((t) => t.hash)).toContain('0xtx2');
    });
  });

  describe('getTransactionByOrderId', () => {
    it('should find transaction by order ID', () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      const tx = tracker.getTransactionByOrderId('order-1');
      expect(tx?.hash).toBe('0xtx1');
    });

    it('should return undefined for unknown order', () => {
      const tx = tracker.getTransactionByOrderId('unknown-order');
      expect(tx).toBeUndefined();
    });
  });

  describe('subscribe', () => {
    it('should notify subscribers of updates', () => {
      const handler = jest.fn();
      tracker.subscribe(handler);

      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      // trackTransaction does not emit - only updateTransaction emits
      // So handler should not be called yet
      expect(handler).not.toHaveBeenCalled();

      // Now update the transaction - this should emit
      tracker.updateTransaction({
        hash: '0xtx1',
        status: 'submitted',
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          hash: '0xtx1',
          status: 'submitted',
        })
      );
    });

    it('should allow unsubscribing', () => {
      const handler = jest.fn();
      const unsubscribe = tracker.subscribe(handler);

      unsubscribe();

      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      // Should not be called after unsubscribe
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('retryTransaction', () => {
    it('should retry failed transaction', async () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');
      tracker.updateTransaction({ hash: '0xtx1', status: 'failed', error: 'Network error' });

      // Run retry and advance timers to handle the setTimeout inside retryTransaction
      const retryPromise = tracker.retryTransaction('0xtx1');
      jest.advanceTimersByTime(2000); // Advance past retry delay
      const result = await retryPromise;

      expect(result).toBe(true);
      const tx = tracker.getTransaction('0xtx1');
      expect(tx?.status).toBe('pending');
      expect(tx?.retryCount).toBe(1);
      expect(tx?.lastError).toBeUndefined();
    });

    it('should fail after max retry attempts', async () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      // Simulate 5 failed retries (max is 5, so 6th should fail)
      for (let i = 0; i < 5; i++) {
        tracker.updateTransaction({ hash: '0xtx1', status: 'failed' });
        const retryPromise = tracker.retryTransaction('0xtx1');
        // Advance by more time for each retry (exponential backoff: 1s, 2s, 4s, 8s, 16s)
        jest.advanceTimersByTime(20000);
        await retryPromise;
      }

      // 6th retry should fail immediately (before retrying)
      tracker.updateTransaction({ hash: '0xtx1', status: 'failed' });
      // No need to advance time - this should fail immediately
      const result = await tracker.retryTransaction('0xtx1');

      expect(result).toBe(false);
      const tx = tracker.getTransaction('0xtx1');
      expect(tx?.status).toBe('expired');
    }, 15000);

    it('should return false for unknown transaction', async () => {
      const result = await tracker.retryTransaction('0xunknown');
      expect(result).toBe(false);
    });
  });

  describe('waitForConfirmation', () => {
    it('should resolve when transaction is confirmed', async () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      // Simulate confirmation after 100ms
      setTimeout(() => {
        tracker.updateTransaction({
          hash: '0xtx1',
          status: 'confirmed',
          confirmations: 12,
        });
      }, 100);

      // Advance timers to trigger the setTimeout
      jest.advanceTimersByTime(200);

      const tx = await tracker.waitForConfirmation('0xtx1', 12, 5000);
      expect(tx.status).toBe('confirmed');
      expect(tx.confirmations).toBe(12);
    });

    it('should resolve when transaction is finalized', async () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      setTimeout(() => {
        tracker.updateTransaction({
          hash: '0xtx1',
          status: 'finalized',
        });
      }, 100);

      // Advance timers to trigger the setTimeout
      jest.advanceTimersByTime(200);

      const tx = await tracker.waitForConfirmation('0xtx1', 12, 5000);
      expect(tx.status).toBe('finalized');
    });

    it('should reject on timeout', async () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      const promise = tracker.waitForConfirmation('0xtx1', 12, 100);

      // Need to run all timers to let the internal polling work
      jest.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow('confirmation timeout');
    });

    it('should reject on failure', async () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      setTimeout(() => {
        tracker.updateTransaction({
          hash: '0xtx1',
          status: 'failed',
          error: 'Out of gas',
        });
      }, 100);

      // Advance timers to trigger the setTimeout
      jest.advanceTimersByTime(200);

      const promise = tracker.waitForConfirmation('0xtx1', 12, 5000);

      await expect(promise).rejects.toThrow('Out of gas');
    });
  });

  describe('waitForFinalization', () => {
    it('should resolve when transaction is finalized', async () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      setTimeout(() => {
        tracker.updateTransaction({
          hash: '0xtx1',
          status: 'finalized',
        });
      }, 100);

      // Advance timers to trigger the setTimeout
      jest.advanceTimersByTime(200);

      const tx = await tracker.waitForFinalization('0xtx1', 5000);
      expect(tx.status).toBe('finalized');
    });

    it('should reject on timeout', async () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      const promise = tracker.waitForFinalization('0xtx1', 100);

      // Need to run all timers to let the internal polling work
      jest.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow('finalization timeout');
    });
  });

  describe('clearOldTransactions', () => {
    it('should remove old completed transactions', () => {
      // First advance time to set a baseline
      const startTime = Date.now();
      jest.setSystemTime(startTime);

      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');
      tracker.trackTransaction('0xtx2', 'order-2', 'market-1');

      // Finalize transactions immediately
      tracker.updateTransaction({ hash: '0xtx1', status: 'finalized' });
      tracker.updateTransaction({ hash: '0xtx2', status: 'failed' });

      // Advance time by 2 hours from the current time
      jest.setSystemTime(startTime + 7200000);

      const removed = tracker.clearOldTransactions(3600000); // 1 hour max age

      expect(removed).toBe(2);
      expect(tracker.getTransaction('0xtx1')).toBeUndefined();
      expect(tracker.getTransaction('0xtx2')).toBeUndefined();
    });

    it('should not remove recent transactions', () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');
      tracker.updateTransaction({ hash: '0xtx1', status: 'finalized' });

      const removed = tracker.clearOldTransactions(3600000);

      expect(removed).toBe(0);
      expect(tracker.getTransaction('0xtx1')).toBeDefined();
    });

    it('should not remove pending transactions', () => {
      // Set a fixed start time
      const startTime = Date.now();
      jest.setSystemTime(startTime);

      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');

      // Advance time by 2 hours from the fixed start time
      jest.setSystemTime(startTime + 7200000);

      const removed = tracker.clearOldTransactions(3600000);

      expect(removed).toBe(0);
      expect(tracker.getTransaction('0xtx1')).toBeDefined();
    });
  });

  describe('getStats', () => {
    it('should return transaction statistics', () => {
      tracker.trackTransaction('0xtx1', 'order-1', 'market-1');
      tracker.trackTransaction('0xtx2', 'order-2', 'market-1');
      tracker.trackTransaction('0xtx3', 'order-3', 'market-1');
      tracker.trackTransaction('0xtx4', 'order-4', 'market-1');

      tracker.updateTransaction({ hash: '0xtx2', status: 'confirmed' });
      tracker.updateTransaction({ hash: '0xtx3', status: 'finalized' });
      tracker.updateTransaction({ hash: '0xtx4', status: 'failed' });

      const stats = tracker.getStats();

      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(1);
      expect(stats.confirmed).toBe(1);
      expect(stats.finalized).toBe(1);
      expect(stats.failed).toBe(1);
    });
  });

  describe('loadState', () => {
    it('should load transactions from storage', () => {
      const savedTxs: Transaction[] = [
        {
          hash: '0xtx1',
          orderId: 'order-1',
          marketId: 'market-1',
          status: 'confirmed',
          createdAt: Date.now(),
          confirmedAt: Date.now(),
          confirmations: 12,
          retryCount: 0,
        },
        {
          hash: '0xtx2',
          orderId: 'order-2',
          marketId: 'market-1',
          status: 'pending',
          createdAt: Date.now(),
          confirmations: 0,
          retryCount: 1,
        },
      ];

      tracker.loadState(savedTxs);

      expect(tracker.getTransaction('0xtx1')).toBeDefined();
      expect(tracker.getTransaction('0xtx2')).toBeDefined();
      expect(tracker.getStats().total).toBe(2);
    });
  });

  describe('persistence', () => {
    it('should persist transactions to disk and recover on restart', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-tracker-'));
      const stateFile = path.join(tempDir, 'state.json');

      const trackerA = new TransactionTrackerClass('https://test-rpc.com', stateFile);
      trackerA.trackTransaction('0xpersist1', 'order-1', 'market-1');
      trackerA.updateTransaction({
        hash: '0xpersist1',
        status: 'confirmed',
        confirmations: 3,
      });
      trackerA.stop();

      const trackerB = new TransactionTrackerClass('https://test-rpc.com', stateFile);
      const restored = trackerB.getTransaction('0xpersist1');

      expect(restored).toBeDefined();
      expect(restored?.status).toBe('confirmed');
      expect(restored?.confirmations).toBe(3);

      trackerB.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should ignore invalid persisted state payload', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-tracker-'));
      const stateFile = path.join(tempDir, 'state.json');
      fs.writeFileSync(stateFile, '{"transactions":[{"bad":"payload"}]}', 'utf8');

      const restoredTracker = new TransactionTrackerClass('https://test-rpc.com', stateFile);

      expect(restoredTracker.getStats().total).toBe(0);

      restoredTracker.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('singleton', () => {
    it('should return same instance from getTransactionTracker', () => {
      const tracker1 = getTransactionTracker();
      const tracker2 = getTransactionTracker();

      expect(tracker1).toBe(tracker2);
    });

    it('should create new instance after reset', () => {
      const tracker1 = getTransactionTracker();
      resetTransactionTracker();
      const tracker2 = getTransactionTracker();

      expect(tracker1).not.toBe(tracker2);
    });
  });
});
