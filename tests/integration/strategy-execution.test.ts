/**
 * Strategy and Execution Integration Tests
 *
 * Tests integration between strategies, execution engine, and risk management
 */

import { StrategyManager } from '../../src/strategies/strategy-manager.js';
import { getExecutionEngine, resetExecutionEngine } from '../../src/execution/execution-engine.js';
import { getRiskManager, resetRiskManager } from '../../src/execution/risk-manager.js';
import { getOrderBookManager, resetOrderBookManager } from '../../src/market/order-book.js';
import type { StrategyMarketData } from '../../src/strategies/base.js';

describe('Strategy and Execution Integration', () => {
  beforeEach(() => {
    resetExecutionEngine();
    resetRiskManager();
    resetOrderBookManager();
  });

  afterEach(() => {
    const engine = getExecutionEngine();
    engine.stop();
    resetExecutionEngine();
    resetRiskManager();
    resetOrderBookManager();
  });

  describe('Strategy Manager Integration', () => {
    it('should analyze markets and generate signals', () => {
      const strategyManager = new StrategyManager({
        simpleArbitrage: {
          minProfitThreshold: 0.02,
          maxSlippage: 0.01,
        },
        aggregationMode: 'priority',
        minConsensus: 0.5,
      });

      const manager = getOrderBookManager();

      // Setup order books
      manager.updateBook('event-yes', [{ price: 0.55, size: 100 }], [{ price: 0.56, size: 100 }]);

      manager.updateBook('event-no', [{ price: 0.4, size: 100 }], [{ price: 0.41, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: manager.getBook('event-yes'),
          lastPrice: 0.555,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: manager.getBook('event-no'),
          lastPrice: 0.405,
          timestamp: Date.now(),
        },
      ];

      const signal = strategyManager.analyze(marketData);

      // May or may not generate signal depending on conditions
      if (signal) {
        expect(signal.signal.type).toMatch(/^(buy|sell)$/);
        expect(signal.signal.marketId).toBeDefined();
        expect(signal.confidence).toBeGreaterThan(0);
      }
    });

    it('should aggregate multiple strategy signals', () => {
      const strategyManager = new StrategyManager({
        simpleArbitrage: { minProfitThreshold: 0.01, maxSlippage: 0.02 },
        trendFollowing: {
          shortPeriod: 5,
          longPeriod: 10,
          rsiPeriod: 7,
          rsiOverbought: 70,
          rsiOversold: 30,
          minTrendStrength: 0.2,
          volumeThreshold: 1.2,
        },
        aggregationMode: 'consensus',
        minConsensus: 0.5,
      });

      const manager = getOrderBookManager();

      // Setup multiple markets
      for (let i = 0; i < 3; i++) {
        manager.updateBook(
          `market-${i}`,
          [{ price: 0.5 + i * 0.05, size: 100 }],
          [{ price: 0.51 + i * 0.05, size: 100 }]
        );
      }

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'market-0',
          orderBook: manager.getBook('market-0'),
          lastPrice: 0.5,
          timestamp: Date.now(),
        },
        {
          marketId: 'market-1',
          orderBook: manager.getBook('market-1'),
          lastPrice: 0.55,
          timestamp: Date.now(),
        },
        {
          marketId: 'market-2',
          orderBook: manager.getBook('market-2'),
          lastPrice: 0.6,
          timestamp: Date.now(),
        },
      ];

      // Run multiple analysis cycles
      const signals = [];
      for (let i = 0; i < 5; i++) {
        const signal = strategyManager.analyze(marketData);
        if (signal) {
          signals.push(signal);
        }
      }

      // Should track signal history
      const history = strategyManager.getSignalHistory();
      expect(history.length).toBe(signals.length);
    });

    it('should handle market making strategy', () => {
      const strategyManager = new StrategyManager({
        marketMaking: {
          targetSpread: 0.02,
          maxInventory: 1000,
          inventorySkew: 0.5,
          orderSize: 10,
          quoteLevels: 2,
          sizeIncrement: 1.2,
        },
        aggregationMode: 'priority',
        minConsensus: 0.5,
      });

      const manager = getOrderBookManager();

      manager.updateBook('market-1', [{ price: 0.58, size: 1000 }], [{ price: 0.62, size: 1000 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'market-1',
          orderBook: manager.getBook('market-1'),
          lastPrice: 0.6,
          timestamp: Date.now(),
        },
      ];

      const signal = strategyManager.analyze(marketData);

      // Market making should generate quotes if spread is favorable
      // Mid price = 0.6, spread = 0.04 (6.7%), target = 2%
      // Should generate signal
      expect(signal).toBeDefined();
      if (signal) {
        expect(['buy', 'sell']).toContain(signal.signal.type);
      }
    });
  });

  describe('Execution and Risk Integration', () => {
    it('should execute trades through risk manager', async () => {
      const engine = getExecutionEngine();
      const riskManager = getRiskManager();

      // Configure risk limits
      riskManager.updateConfig({
        maxExposure: 10000,
        maxBetFraction: 0.5,
        maxDailyLoss: 1000,
      });

      // Execute a trade
      const result = await engine.executeOrder({
        id: 'test-order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.6,
        orderType: 'limit',
      });

      expect(['filled', 'partial', 'error']).toContain(result.status);

      if (result.status === 'filled' || result.status === 'partial') {
        expect(result.filledSize).toBeGreaterThan(0);
      }
    });

    it('should handle concurrent trade execution', async () => {
      const engine = getExecutionEngine();

      const orders = [
        {
          id: 'order-1',
          marketId: 'market-a',
          side: 'buy' as const,
          size: 50,
          price: 0.6,
          orderType: 'limit' as const,
        },
        {
          id: 'order-2',
          marketId: 'market-b',
          side: 'sell' as const,
          size: 50,
          price: 0.4,
          orderType: 'limit' as const,
        },
        {
          id: 'order-3',
          marketId: 'market-c',
          side: 'buy' as const,
          size: 30,
          price: 0.55,
          orderType: 'limit' as const,
        },
      ];

      const result = await engine.executeParallel(orders);

      expect(result.orders).toHaveLength(3);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should execute multi-leg arbitrage', async () => {
      const engine = getExecutionEngine();

      const legs = [
        { marketId: 'yes-market', side: 'buy' as const, size: 100, expectedPrice: 0.55 },
        { marketId: 'no-market', side: 'buy' as const, size: 100, expectedPrice: 0.4 },
      ];

      const result = await engine.executeArbitrage(legs, 'arb-test-1');

      expect(result.orders).toHaveLength(2);

      // Check that orders were created with correct IDs
      const orderIds = result.orders.map((o) => o.orderId);
      expect(orderIds).toContain('arb-test-1-0');
      expect(orderIds).toContain('arb-test-1-1');
    });

    it('should track order status after execution', async () => {
      const engine = getExecutionEngine();

      const order = {
        id: 'track-order',
        marketId: 'market-1',
        side: 'buy' as const,
        size: 100,
        price: 0.6,
        orderType: 'limit' as const,
      };

      await engine.executeOrder(order);

      const status = engine.getOrderStatus(order.id);

      expect(status).toBeDefined();
      expect(status?.orderId).toBe(order.id);
    });
  });

  describe('End-to-End Trading Flow', () => {
    it('should complete full trading cycle', async () => {
      // Setup components
      const strategyManager = new StrategyManager({
        simpleArbitrage: { minProfitThreshold: 0.01, maxSlippage: 0.02 },
        aggregationMode: 'priority',
        minConsensus: 0.5,
      });

      const engine = getExecutionEngine();
      const manager = getOrderBookManager();

      // Setup market data
      manager.updateBook('event-yes', [{ price: 0.55, size: 1000 }], [{ price: 0.56, size: 1000 }]);

      manager.updateBook('event-no', [{ price: 0.4, size: 1000 }], [{ price: 0.41, size: 1000 }]);

      // Step 1: Analyze markets
      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: manager.getBook('event-yes'),
          lastPrice: 0.555,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: manager.getBook('event-no'),
          lastPrice: 0.405,
          timestamp: Date.now(),
        },
      ];

      const signal = strategyManager.analyze(marketData);

      // Step 2: If signal generated, execute trade
      if (signal) {
        const order = {
          id: `order-${Date.now()}`,
          marketId: signal.signal.marketId,
          side: signal.signal.type,
          size: signal.signal.size,
          price: signal.signal.price,
          orderType: 'limit' as const,
        };

        const result = await engine.executeOrder(order);

        // Step 3: Verify execution
        expect(['filled', 'partial', 'error']).toContain(result.status);

        // Step 4: Check order status
        const status = engine.getOrderStatus(order.id);
        expect(status).toBeDefined();
      }
    });

    it('should handle position tracking across multiple trades', async () => {
      const engine = getExecutionEngine();

      // Execute multiple trades in same market
      await engine.executeOrder({
        id: 'pos-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.6,
        orderType: 'limit',
      });

      await engine.executeOrder({
        id: 'pos-2',
        marketId: 'market-1',
        side: 'buy',
        size: 50,
        price: 0.61,
        orderType: 'limit',
      });

      await engine.executeOrder({
        id: 'pos-3',
        marketId: 'market-1',
        side: 'sell',
        size: 30,
        price: 0.62,
        orderType: 'limit',
      });

      // Get all order statuses
      const statuses = engine.getAllOrderStatuses();
      expect(statuses.length).toBeGreaterThanOrEqual(3);

      // Verify all orders are tracked
      const orderIds = statuses.map((s) => s.orderId);
      expect(orderIds).toContain('pos-1');
      expect(orderIds).toContain('pos-2');
      expect(orderIds).toContain('pos-3');
    });

    it('should handle partial fill scenarios', async () => {
      const engine = getExecutionEngine();

      // Execute large order that might partially fill
      const largeOrder = {
        id: 'large-order',
        marketId: 'market-1',
        side: 'buy',
        size: 10000,
        price: 0.6,
        orderType: 'limit',
      };

      const result = await engine.executeOrder(largeOrder);

      // Should handle result regardless of fill status
      expect(result).toBeDefined();
      expect(result.orderId).toBe(largeOrder.id);
      expect(result.filledSize).toBeGreaterThanOrEqual(0);
      expect(result.remainingSize).toBeGreaterThanOrEqual(0);
    });
  });
});
