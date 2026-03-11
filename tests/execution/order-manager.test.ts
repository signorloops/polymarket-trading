/**
 * Order Manager Tests
 *
 * Comprehensive test suite for OrderManager class.
 * Targets 80%+ branch coverage.
 */

import { jest } from '@jest/globals';
import { OrderManager } from '../../src/execution/order-manager.js';
import type { TradeOrder, OrderStatus } from '../../src/execution/types.js';
import { initLogger } from '../../src/utils/logger.js';

describe('OrderManager', () => {
  let orderManager: OrderManager;

  beforeEach(() => {
    // Initialize logger with debug level for testing
    initLogger('debug', false);
    orderManager = new OrderManager();
  });

  afterEach(() => {
    // Clean up after each test - suppress logs during cleanup
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    orderManager.clearAll();
    jest.restoreAllMocks();
  });

  describe('addPending', () => {
    it('should add a pending order', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);

      expect(orderManager.getPending('order-1')).toEqual(order);
    });

    it('should overwrite existing order with same id', () => {
      const order1: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      const order2: TradeOrder = {
        id: 'order-1',
        marketId: 'market-2',
        side: 'sell',
        size: 200,
        price: 0.6,
        orderType: 'market',
      };

      orderManager.addPending(order1);
      orderManager.addPending(order2);

      expect(orderManager.getPending('order-1')).toEqual(order2);
      expect(orderManager.getPendingCount()).toBe(1);
    });
  });

  describe('removePending', () => {
    it('should remove a pending order', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);
      orderManager.removePending('order-1');

      expect(orderManager.getPending('order-1')).toBeUndefined();
      expect(orderManager.getPendingCount()).toBe(0);
    });

    it('should not throw when removing non-existent order', () => {
      expect(() => {
        orderManager.removePending('non-existent');
      }).not.toThrow();
    });
  });

  describe('getPending', () => {
    it('should return undefined for non-existent order', () => {
      expect(orderManager.getPending('non-existent')).toBeUndefined();
    });

    it('should return the correct order', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);

      expect(orderManager.getPending('order-1')).toEqual(order);
    });
  });

  describe('getAllPending', () => {
    it('should return empty array when no pending orders', () => {
      expect(orderManager.getAllPending()).toEqual([]);
    });

    it('should return all pending orders', () => {
      const order1: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      const order2: TradeOrder = {
        id: 'order-2',
        marketId: 'market-2',
        side: 'sell',
        size: 200,
        price: 0.6,
        orderType: 'market',
      };

      orderManager.addPending(order1);
      orderManager.addPending(order2);

      const allPending = orderManager.getAllPending();

      expect(allPending).toHaveLength(2);
      expect(allPending).toContainEqual(order1);
      expect(allPending).toContainEqual(order2);
    });
  });

  describe('updateStatus', () => {
    it('should add new status', () => {
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      orderManager.updateStatus(status);

      expect(orderManager.getStatus('order-1')).toEqual(status);
    });

    it('should update existing status', () => {
      const status1: OrderStatus = {
        orderId: 'order-1',
        status: 'pending',
        filledSize: 0,
        remainingSize: 100,
        avgPrice: 0,
        timestamp: Date.now(),
      };

      const status2: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      orderManager.updateStatus(status1);
      orderManager.updateStatus(status2);

      expect(orderManager.getStatus('order-1')).toEqual(status2);
    });
  });

  describe('getStatus', () => {
    it('should return undefined for non-existent status', () => {
      expect(orderManager.getStatus('non-existent')).toBeUndefined();
    });

    it('should return the correct status', () => {
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      orderManager.updateStatus(status);

      expect(orderManager.getStatus('order-1')).toEqual(status);
    });
  });

  describe('getAllStatuses', () => {
    it('should return empty array when no statuses', () => {
      expect(orderManager.getAllStatuses()).toEqual([]);
    });

    it('should return all statuses', () => {
      const status1: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      const status2: OrderStatus = {
        orderId: 'order-2',
        status: 'cancelled',
        filledSize: 0,
        remainingSize: 100,
        avgPrice: 0,
        timestamp: Date.now(),
      };

      orderManager.updateStatus(status1);
      orderManager.updateStatus(status2);

      const allStatuses = orderManager.getAllStatuses();

      expect(allStatuses).toHaveLength(2);
      expect(allStatuses).toContainEqual(status1);
      expect(allStatuses).toContainEqual(status2);
    });
  });

  describe('clearOldOrders', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-01T12:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should clear completed orders older than maxAgeMs', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000; // 2 hours ago

      const oldStatus: OrderStatus = {
        orderId: 'old-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldStatus);

      // Clear orders older than 1 hour
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-order')).toBeUndefined();
    });

    it('should not clear orders newer than maxAgeMs', () => {
      const now = Date.now();
      const recentTimestamp = now - 1800000; // 30 minutes ago

      const recentStatus: OrderStatus = {
        orderId: 'recent-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: recentTimestamp,
      };

      orderManager.updateStatus(recentStatus);

      // Clear orders older than 1 hour
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('recent-order')).toEqual(recentStatus);
    });

    it('should not clear pending orders even if old', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000; // 2 hours ago

      const oldPendingStatus: OrderStatus = {
        orderId: 'old-pending',
        status: 'pending',
        filledSize: 0,
        remainingSize: 100,
        avgPrice: 0,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldPendingStatus);
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-pending')).toEqual(oldPendingStatus);
    });

    it('should not clear open orders even if old', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000; // 2 hours ago

      const oldOpenStatus: OrderStatus = {
        orderId: 'old-open',
        status: 'open',
        filledSize: 50,
        remainingSize: 50,
        avgPrice: 0.5,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldOpenStatus);
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-open')).toEqual(oldOpenStatus);
    });

    it('should clear filled orders that are old', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000;

      const oldFilledStatus: OrderStatus = {
        orderId: 'old-filled',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldFilledStatus);
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-filled')).toBeUndefined();
    });

    it('should clear partial orders that are old', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000;

      const oldPartialStatus: OrderStatus = {
        orderId: 'old-partial',
        status: 'partial',
        filledSize: 50,
        remainingSize: 50,
        avgPrice: 0.5,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldPartialStatus);
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-partial')).toBeUndefined();
    });

    it('should clear cancelled orders that are old', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000;

      const oldCancelledStatus: OrderStatus = {
        orderId: 'old-cancelled',
        status: 'cancelled',
        filledSize: 0,
        remainingSize: 100,
        avgPrice: 0,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldCancelledStatus);
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-cancelled')).toBeUndefined();
    });

    it('should clear error orders that are old', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000;

      const oldErrorStatus: OrderStatus = {
        orderId: 'old-error',
        status: 'error',
        filledSize: 0,
        remainingSize: 100,
        avgPrice: 0,
        timestamp: oldTimestamp,
        error: 'Some error',
      };

      orderManager.updateStatus(oldErrorStatus);
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-error')).toBeUndefined();
    });

    it('should use default maxAgeMs of 1 hour when not specified', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000; // 2 hours ago

      const oldStatus: OrderStatus = {
        orderId: 'old-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldStatus);
      orderManager.clearOldOrders(); // Use default

      expect(orderManager.getStatus('old-order')).toBeUndefined();
    });

    it('should log debug message when orders are cleared', () => {
      const consoleSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

      const now = Date.now();
      const oldTimestamp = now - 7200000;

      const oldStatus: OrderStatus = {
        orderId: 'old-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldStatus);
      orderManager.clearOldOrders(3600000);

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0]?.[0]).toContain('Cleared');

      consoleSpy.mockRestore();
    });

    it('should not log when no orders are cleared', () => {
      const consoleSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

      // Only add a recent order
      const now = Date.now();
      const recentStatus: OrderStatus = {
        orderId: 'recent-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: now,
      };

      orderManager.updateStatus(recentStatus);
      orderManager.clearOldOrders(3600000);

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle empty order statuses', () => {
      expect(() => {
        orderManager.clearOldOrders(3600000);
      }).not.toThrow();
    });

    it('should clear multiple old orders at once', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000;

      const oldStatus1: OrderStatus = {
        orderId: 'old-order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: oldTimestamp,
      };

      const oldStatus2: OrderStatus = {
        orderId: 'old-order-2',
        status: 'cancelled',
        filledSize: 0,
        remainingSize: 100,
        avgPrice: 0,
        timestamp: oldTimestamp,
      };

      orderManager.updateStatus(oldStatus1);
      orderManager.updateStatus(oldStatus2);
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-order-1')).toBeUndefined();
      expect(orderManager.getStatus('old-order-2')).toBeUndefined();
    });

    it('should only clear old orders and keep recent ones', () => {
      const now = Date.now();
      const oldTimestamp = now - 7200000;
      const recentTimestamp = now - 1800000;

      const oldStatus: OrderStatus = {
        orderId: 'old-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: oldTimestamp,
      };

      const recentStatus: OrderStatus = {
        orderId: 'recent-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: recentTimestamp,
      };

      orderManager.updateStatus(oldStatus);
      orderManager.updateStatus(recentStatus);
      orderManager.clearOldOrders(3600000);

      expect(orderManager.getStatus('old-order')).toBeUndefined();
      expect(orderManager.getStatus('recent-order')).toEqual(recentStatus);
    });
  });

  describe('hasOrder', () => {
    it('should return true for pending order', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);

      expect(orderManager.hasOrder('order-1')).toBe(true);
    });

    it('should return true for order with status', () => {
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      orderManager.updateStatus(status);

      expect(orderManager.hasOrder('order-1')).toBe(true);
    });

    it('should return false for non-existent order', () => {
      expect(orderManager.hasOrder('non-existent')).toBe(false);
    });

    it('should return true when order is both pending and has status', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      orderManager.addPending(order);
      orderManager.updateStatus(status);

      expect(orderManager.hasOrder('order-1')).toBe(true);
    });
  });

  describe('getPendingCount', () => {
    it('should return 0 when no pending orders', () => {
      expect(orderManager.getPendingCount()).toBe(0);
    });

    it('should return correct count of pending orders', () => {
      const order1: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      const order2: TradeOrder = {
        id: 'order-2',
        marketId: 'market-2',
        side: 'sell',
        size: 200,
        price: 0.6,
        orderType: 'market',
      };

      orderManager.addPending(order1);
      orderManager.addPending(order2);

      expect(orderManager.getPendingCount()).toBe(2);
    });

    it('should decrease count after removing order', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);
      expect(orderManager.getPendingCount()).toBe(1);

      orderManager.removePending('order-1');
      expect(orderManager.getPendingCount()).toBe(0);
    });
  });

  describe('getStatusCount', () => {
    it('should return 0 when no statuses', () => {
      expect(orderManager.getStatusCount()).toBe(0);
    });

    it('should return correct count of statuses', () => {
      const status1: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      const status2: OrderStatus = {
        orderId: 'order-2',
        status: 'cancelled',
        filledSize: 0,
        remainingSize: 100,
        avgPrice: 0,
        timestamp: Date.now(),
      };

      orderManager.updateStatus(status1);
      orderManager.updateStatus(status2);

      expect(orderManager.getStatusCount()).toBe(2);
    });
  });

  describe('clearAll', () => {
    it('should clear all pending orders', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);
      orderManager.clearAll();

      expect(orderManager.getPendingCount()).toBe(0);
      expect(orderManager.getPending('order-1')).toBeUndefined();
    });

    it('should clear all statuses', () => {
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      orderManager.updateStatus(status);
      orderManager.clearAll();

      expect(orderManager.getStatusCount()).toBe(0);
      expect(orderManager.getStatus('order-1')).toBeUndefined();
    });

    it('should log warning when clearing all orders', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      orderManager.clearAll();

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0]?.[0]).toContain('All orders cleared');

      consoleSpy.mockRestore();
    });
  });

  describe('concurrent access scenarios', () => {
    it('should handle rapid add and remove operations', () => {
      const orders: TradeOrder[] = Array.from({ length: 100 }, (_, i) => ({
        id: `order-${String(i)}`,
        marketId: `market-${String(i)}`,
        side: i % 2 === 0 ? 'buy' : 'sell',
        size: 100 + i,
        price: 0.5,
        orderType: 'limit',
      }));

      // Add all orders
      orders.forEach((order) => {
        orderManager.addPending(order);
      });
      expect(orderManager.getPendingCount()).toBe(100);

      // Remove all even-indexed orders
      orders
        .filter((_, i) => i % 2 === 0)
        .forEach((order) => {
          orderManager.removePending(order.id);
        });

      expect(orderManager.getPendingCount()).toBe(50);
    });

    it('should handle mixed operations on same order', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      // Add as pending
      orderManager.addPending(order);
      expect(orderManager.hasOrder('order-1')).toBe(true);
      expect(orderManager.getPending('order-1')).toEqual(order);

      // Update status
      orderManager.updateStatus(status);
      expect(orderManager.getStatus('order-1')).toEqual(status);

      // Remove from pending
      orderManager.removePending('order-1');
      expect(orderManager.getPending('order-1')).toBeUndefined();
      expect(orderManager.hasOrder('order-1')).toBe(true); // Still has status
    });

    it('should handle status transitions correctly', () => {
      const orderId = 'order-1';
      const timestamps = [Date.now(), Date.now() + 1000, Date.now() + 2000, Date.now() + 3000];

      const statuses: OrderStatus[] = [
        {
          orderId,
          status: 'pending',
          filledSize: 0,
          remainingSize: 100,
          avgPrice: 0,
          timestamp: timestamps[0],
        },
        {
          orderId,
          status: 'open',
          filledSize: 0,
          remainingSize: 100,
          avgPrice: 0,
          timestamp: timestamps[1],
        },
        {
          orderId,
          status: 'partial',
          filledSize: 50,
          remainingSize: 50,
          avgPrice: 0.5,
          timestamp: timestamps[2],
        },
        {
          orderId,
          status: 'filled',
          filledSize: 100,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: timestamps[3],
        },
      ];

      statuses.forEach((status) => {
        orderManager.updateStatus(status);
      });

      const finalStatus = orderManager.getStatus(orderId);
      expect(finalStatus?.status).toBe('filled');
      expect(finalStatus?.filledSize).toBe(100);
    });

    it('should handle multiple orders with different statuses', () => {
      const orders: OrderStatus[] = [
        {
          orderId: 'order-1',
          status: 'pending',
          filledSize: 0,
          remainingSize: 100,
          avgPrice: 0,
          timestamp: Date.now(),
        },
        {
          orderId: 'order-2',
          status: 'open',
          filledSize: 0,
          remainingSize: 100,
          avgPrice: 0,
          timestamp: Date.now(),
        },
        {
          orderId: 'order-3',
          status: 'filled',
          filledSize: 100,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: Date.now(),
        },
        {
          orderId: 'order-4',
          status: 'partial',
          filledSize: 50,
          remainingSize: 50,
          avgPrice: 0.5,
          timestamp: Date.now(),
        },
        {
          orderId: 'order-5',
          status: 'cancelled',
          filledSize: 0,
          remainingSize: 100,
          avgPrice: 0,
          timestamp: Date.now(),
        },
        {
          orderId: 'order-6',
          status: 'error',
          filledSize: 0,
          remainingSize: 100,
          avgPrice: 0,
          timestamp: Date.now(),
          error: 'Network error',
        },
      ];

      orders.forEach((order) => {
        orderManager.updateStatus(order);
      });

      expect(orderManager.getStatusCount()).toBe(6);
      expect(orderManager.getStatus('order-1')?.status).toBe('pending');
      expect(orderManager.getStatus('order-2')?.status).toBe('open');
      expect(orderManager.getStatus('order-3')?.status).toBe('filled');
      expect(orderManager.getStatus('order-4')?.status).toBe('partial');
      expect(orderManager.getStatus('order-5')?.status).toBe('cancelled');
      expect(orderManager.getStatus('order-6')?.status).toBe('error');
    });
  });

  describe('edge cases', () => {
    it('should handle order with zero size', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 0,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);

      expect(orderManager.getPending('order-1')).toEqual(order);
    });

    it('should handle order with very large size', () => {
      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: Number.MAX_SAFE_INTEGER,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);

      expect(orderManager.getPending('order-1')).toEqual(order);
    });

    it('should handle order with special characters in id', () => {
      const order: TradeOrder = {
        id: 'order-!@#$%^&*()',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      };

      orderManager.addPending(order);

      expect(orderManager.getPending('order-!@#$%^&*()')).toEqual(order);
    });

    it('should handle status with error message', () => {
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'error',
        filledSize: 0,
        remainingSize: 100,
        avgPrice: 0,
        timestamp: Date.now(),
        error: 'Insufficient funds',
      };

      orderManager.updateStatus(status);

      expect(orderManager.getStatus('order-1')?.error).toBe('Insufficient funds');
    });

    it('should handle clearing with custom maxAgeMs of 0', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      orderManager.updateStatus(status);

      // With maxAgeMs of 0, even current orders should be considered old
      // But since timestamp equals Date.now(), timestamp < cutoff will be false
      orderManager.clearOldOrders(0);

      // Order should still exist because timestamp === Date.now() and cutoff === Date.now()
      expect(orderManager.getStatus('order-1')).toEqual(status);

      jest.useRealTimers();
    });

    it('should handle very old orders with large maxAgeMs', () => {
      const veryOldTimestamp = Date.now() - 86400000 * 365; // 1 year ago

      const oldStatus: OrderStatus = {
        orderId: 'very-old-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: veryOldTimestamp,
      };

      orderManager.updateStatus(oldStatus);

      // Clear orders older than 2 years
      orderManager.clearOldOrders(86400000 * 365 * 2);

      // Should still exist because it's less than 2 years old
      expect(orderManager.getStatus('very-old-order')).toEqual(oldStatus);
    });
  });
});
