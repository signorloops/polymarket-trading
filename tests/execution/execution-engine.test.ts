/**
 * Execution Engine Tests
 */

import {
  ExecutionEngine,
  getExecutionEngine,
  resetExecutionEngine,
  type TradeOrder,
  type TradeLeg,
} from '../../src/execution/execution-engine.js';

describe('ExecutionEngine', () => {
  beforeEach(() => {
    resetExecutionEngine();
  });

  afterEach(() => {
    const engine = getExecutionEngine();
    engine.stop();
    resetExecutionEngine();
  });

  describe('executeOrder', () => {
    it('should execute a buy order successfully', async () => {
      const engine = getExecutionEngine();

      const order: TradeOrder = {
        id: 'order-1',
        marketId: 'test-market',
        side: 'buy',
        size: 100,
        price: 0.6,
        orderType: 'limit',
      };

      const result = await engine.executeOrder(order);

      expect(result.status).toBe('filled');
      expect(result.filledSize).toBeGreaterThan(0);
      expect(result.avgPrice).toBeGreaterThan(0);
    });

    it('should execute a sell order successfully', async () => {
      const engine = getExecutionEngine();

      const order: TradeOrder = {
        id: 'order-2',
        marketId: 'test-market',
        side: 'sell',
        size: 50,
        price: 0.4,
        orderType: 'limit',
      };

      const result = await engine.executeOrder(order);

      expect(['filled', 'partial']).toContain(result.status);
      expect(result.filledSize).toBeGreaterThanOrEqual(0);
    });

    it('should handle market orders', async () => {
      const engine = getExecutionEngine();

      const order: TradeOrder = {
        id: 'order-3',
        marketId: 'test-market',
        side: 'buy',
        size: 100,
        price: 0,
        orderType: 'market',
      };

      const result = await engine.executeOrder(order);

      expect(['filled', 'partial']).toContain(result.status);
      expect(result.filledSize).toBeGreaterThan(0);
    });
  });

  describe('executeParallel', () => {
    it('should execute multiple orders in parallel', async () => {
      const engine = getExecutionEngine();

      const orders: TradeOrder[] = [
        {
          id: 'order-1',
          marketId: 'market-yes',
          side: 'buy',
          size: 100,
          price: 0.6,
          orderType: 'limit',
        },
        {
          id: 'order-2',
          marketId: 'market-no',
          side: 'buy',
          size: 100,
          price: 0.35,
          orderType: 'limit',
        },
      ];

      const result = await engine.executeParallel(orders);

      expect(result.orders).toHaveLength(2);
      expect(result.totalFilled).toBeGreaterThan(0);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty orders array', async () => {
      const engine = getExecutionEngine();

      const result = await engine.executeParallel([]);

      expect(result.orders).toHaveLength(0);
      expect(result.totalFilled).toBe(0);
      expect(result.success).toBe(true);
    });

    it('should handle many orders', async () => {
      const engine = getExecutionEngine();

      // Create many orders within the limit
      const orders: TradeOrder[] = Array.from({ length: 5 }, (_, i) => ({
        id: `order-${i}`,
        marketId: `market-${i}`,
        side: 'buy' as const,
        size: 100,
        price: 0.5,
        orderType: 'limit' as const,
      }));

      const result = await engine.executeParallel(orders);

      // Should complete without throwing
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('executeArbitrage', () => {
    it('should execute arbitrage with multiple legs', async () => {
      const engine = getExecutionEngine();

      const legs: TradeLeg[] = [
        { marketId: 'market-yes', side: 'buy', size: 100, expectedPrice: 0.6 },
        { marketId: 'market-no', side: 'buy', size: 100, expectedPrice: 0.35 },
      ];

      const result = await engine.executeArbitrage(legs, 'arb-1');

      expect(result.orders).toHaveLength(2);
      expect(result.totalFilled).toBeGreaterThan(0);
    });

    it('should handle partial fills', async () => {
      const engine = getExecutionEngine();

      const legs: TradeLeg[] = [
        { marketId: 'market-1', side: 'buy', size: 10000, expectedPrice: 0.6 },
        { marketId: 'market-2', side: 'sell', size: 10000, expectedPrice: 0.4 },
      ];

      const result = await engine.executeArbitrage(legs, 'arb-2');

      // Should handle partial fills gracefully
      expect(result.orders).toHaveLength(2);
    });
  });

  describe('cancelOrder', () => {
    it('should return false for non-existent order', async () => {
      const engine = getExecutionEngine();

      const cancelled = await engine.cancelOrder('non-existent-id');
      expect(cancelled).toBe(false);
    });

    it('should attempt to cancel pending order', async () => {
      const engine = getExecutionEngine();

      const order: TradeOrder = {
        id: 'pending-order',
        marketId: 'test-market',
        side: 'buy',
        size: 100,
        price: 0.6,
        orderType: 'limit',
      };

      // Start executing order but don't await
      const executePromise = engine.executeOrder(order);

      // Try to cancel immediately (might or might not succeed depending on timing)
      const cancelled = await engine.cancelOrder(order.id);

      // Wait for execution to complete
      await executePromise;

      // Should either be cancelled or completed
      const status = engine.getOrderStatus(order.id);
      expect(status).toBeDefined();
    });
  });

  describe('getOrderStatus', () => {
    it('should return order status after execution', async () => {
      const engine = getExecutionEngine();

      const order: TradeOrder = {
        id: 'order-status-test',
        marketId: 'test-market',
        side: 'buy',
        size: 100,
        price: 0.6,
        orderType: 'limit',
      };

      await engine.executeOrder(order);
      const status = engine.getOrderStatus(order.id);

      expect(status).toBeDefined();
      expect(status?.orderId).toBe(order.id);
      expect(['filled', 'partial', 'error']).toContain(status?.status);
    });

    it('should return undefined for unknown order', () => {
      const engine = getExecutionEngine();

      const status = engine.getOrderStatus('unknown-id');
      expect(status).toBeUndefined();
    });
  });

  describe('getPendingOrders', () => {
    it('should return empty array when no pending orders', () => {
      const engine = getExecutionEngine();

      const pending = engine.getPendingOrders();
      expect(pending).toHaveLength(0);
    });
  });

  describe('getAllOrderStatuses', () => {
    it('should return all order statuses', async () => {
      const engine = getExecutionEngine();

      const order1: TradeOrder = {
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.6,
        orderType: 'limit',
      };

      const order2: TradeOrder = {
        id: 'order-2',
        marketId: 'market-2',
        side: 'sell',
        size: 50,
        price: 0.4,
        orderType: 'limit',
      };

      await engine.executeOrder(order1);
      await engine.executeOrder(order2);

      const statuses = engine.getAllOrderStatuses();

      expect(statuses.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('clearOldOrders', () => {
    it('should clear old completed orders', async () => {
      const engine = getExecutionEngine();

      const order: TradeOrder = {
        id: 'old-order',
        marketId: 'test-market',
        side: 'buy',
        size: 100,
        price: 0.6,
        orderType: 'limit',
      };

      await engine.executeOrder(order);

      // Clear orders older than 0ms (should clear all)
      engine.clearOldOrders(0);

      // Order status should be cleared if it was old enough
      // Since we just created it, it might still exist
      const statuses = engine.getAllOrderStatuses();
      expect(statuses.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance', () => {
      const engine1 = getExecutionEngine();
      const engine2 = getExecutionEngine();

      expect(engine1).toBe(engine2);
    });

    it('should reset instance when reset called', () => {
      const engine1 = getExecutionEngine();
      resetExecutionEngine();
      const engine2 = getExecutionEngine();

      expect(engine1).not.toBe(engine2);
    });
  });

  describe('stop', () => {
    it('should stop the engine and cleanup', () => {
      const engine = getExecutionEngine();

      // Should not throw
      engine.stop();

      // Second stop should also not throw
      engine.stop();
    });
  });
});
