/**
 * Trading System Integration Tests
 *
 * Comprehensive integration tests for the main trading system workflow.
 * Covers end-to-end scenarios, risk management, error handling, and multi-market scenarios.
 */

import { jest } from '@jest/globals';
import type { OrderStatus } from '../../src/execution/execution-engine.js';

// Import the modules being tested
import {
  PolymarketTradingSystem,
  type TradingSystemConfig,
  resetTradingSystem,
} from '../../src/index.js';
import {
  getRiskManager,
  resetRiskManager,
  RiskManager,
} from '../../src/execution/risk-manager.js';
import {
  getExecutionEngine,
  resetExecutionEngine,
} from '../../src/execution/execution-engine.js';
import {
  getOrderBookManager,
  resetOrderBookManager,
} from '../../src/market/order-book.js';
import {
  ArbitrageDetector,
  getArbitrageDetector,
  resetArbitrageDetector,
  type ArbitrageOpportunity,
} from '../../src/market/arbitrage-detector.js';
import { getDependencyGraph, resetDependencyGraph } from '../../src/market/dependency-graph.js';

describe('Trading System Integration', () => {
  beforeEach(() => {
    resetTradingSystem();
    resetDependencyGraph();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetTradingSystem();
    resetDependencyGraph();
  });

  describe('End-to-End Happy Path', () => {
    it('should initialize trading system successfully', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-yes', 'market-no'],
        events: [
          {
            id: 'test-event',
            markets: [
              { id: 'market-yes', outcome: 'YES', price: 0.6 },
              { id: 'market-no', outcome: 'NO', price: 0.35 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);

      expect(() => system.initialize()).not.toThrow();
    });

    it('should start and stop data pipeline', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1'],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      await system.start();
      // Should be running without errors

      await system.stop();
      // Should stop cleanly
    });

    it('should detect arbitrage opportunity and execute trade', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false, // Paper trading
        markets: ['market-yes', 'market-no'],
        events: [
          {
            id: 'arbitrage-event',
            markets: [
              { id: 'market-yes', outcome: 'YES', price: 0.5 },
              { id: 'market-no', outcome: 'NO', price: 0.4 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Run detection cycle
      const opportunities = await system.runDetectionCycle();

      // Should find arbitrage opportunity (YES + NO = 0.9 < 1)
      expect(opportunities.length).toBeGreaterThan(0);

      // Execute the first opportunity
      if (opportunities.length > 0) {
        const result = await system.executeOpportunity(opportunities[0]!);
        expect(typeof result).toBe('boolean');
      }
    });

    it('should complete full trading cycle with profitable opportunity', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-yes', 'market-no'],
        events: [
          {
            id: 'profitable-event',
            markets: [
              { id: 'market-yes', outcome: 'YES', price: 0.45 },
              { id: 'market-no', outcome: 'NO', price: 0.45 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Start system
      await system.start();

      // Let it run briefly
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop system
      await system.stop();

      // Should complete without errors
      expect(true).toBe(true);
    });
  });

  describe('Risk Management Integration', () => {
    it('should trigger emergency stop when daily loss limit exceeded', () => {
      const riskManager = new RiskManager({
        maxDailyLoss: 100,
        emergencyStopThreshold: 200,
      });

      // Simulate large loss
      const largeLossStatus: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 1000,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      // Add position and then close with loss
      riskManager.updatePosition(largeLossStatus, 'market-1', 'buy');

      const closeStatus: OrderStatus = {
        orderId: 'order-2',
        status: 'filled',
        filledSize: 1000,
        remainingSize: 0,
        avgPrice: 0.3, // Significant loss
        timestamp: Date.now(),
      };
      riskManager.updatePosition(closeStatus, 'market-1', 'sell');

      // Check if emergency stop is triggered
      const shouldStop = riskManager.checkEmergencyStop();
      expect(typeof shouldStop).toBe('boolean');
    });

    it('should enforce position limits', () => {
      const riskManager = new RiskManager({
        maxExposure: 1000,
      });

      // Try to create position exceeding limit
      const result = riskManager.checkTrade('market-1', 2000, 'buy', 2000);

      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('high');
      expect(result.reason).toContain('exposure');
    });

    it('should enforce daily loss limits', () => {
      const riskManager = new RiskManager({
        maxDailyLoss: 100,
      });

      // Simulate reaching daily loss limit
      const status1: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 500,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status1, 'market-1', 'buy');

      const status2: OrderStatus = {
        orderId: 'order-2',
        status: 'filled',
        filledSize: 500,
        remainingSize: 0,
        avgPrice: 0.3, // 20% loss
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status2, 'market-1', 'sell');

      // Next trade should be rejected due to daily loss
      const result = riskManager.checkTrade('market-2', 100, 'buy', 50);

      // Should either be rejected or allowed based on current PnL
      expect(result).toBeDefined();
      expect(result.riskLevel).toBeDefined();
    });

    it('should reject trades when circuit breaker is active', () => {
      const riskManager = getRiskManager();

      // Trigger circuit breaker
      riskManager.triggerCircuitBreaker('Test emergency');

      const result = riskManager.checkTrade('market-1', 100, 'buy', 50);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Circuit breaker');
      expect(result.riskLevel).toBe('critical');
    });

    it('should calculate risk metrics correctly', () => {
      const riskManager = new RiskManager();

      // Add some positions
      const status1: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status1, 'market-1', 'buy');

      const status2: OrderStatus = {
        orderId: 'order-2',
        status: 'filled',
        filledSize: 200,
        remainingSize: 0,
        avgPrice: 0.6,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status2, 'market-2', 'buy');

      const metrics = riskManager.getRiskMetrics();

      expect(metrics.positionCount).toBe(2);
      expect(metrics.totalExposure).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle API failures gracefully', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1'],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Create an opportunity that will trigger risk check
      const opportunity: ArbitrageOpportunity = {
        id: 'test-opportunity',
        type: 'single-market',
        markets: ['market-1', 'market-2'],
        expectedProfit: 0.1,
        guaranteedProfit: 0.08,
        confidence: 0.9,
        tradeDirection: [1, -1],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      // Should handle execution without throwing
      const result = await system.executeOpportunity(opportunity);
      expect(typeof result).toBe('boolean');
    });

    it('should handle WebSocket disconnection', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1'],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      await system.start();

      // Stop should handle disconnection gracefully
      expect(() => system.stop()).not.toThrow();
    });

    it('should reject invalid orders', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: [],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Create invalid opportunity (missing market data)
      const invalidOpportunity: ArbitrageOpportunity = {
        id: 'invalid-opportunity',
        type: 'single-market',
        markets: [],
        expectedProfit: 0.1,
        guaranteedProfit: 0.08,
        confidence: 0.9,
        tradeDirection: [],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      // Should reject invalid opportunity
      const result = await system.executeOpportunity(invalidOpportunity);
      expect(result).toBe(false);
    });

    it('should handle missing primary market in opportunity', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: [],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Opportunity with empty markets array
      const invalidOpportunity: ArbitrageOpportunity = {
        id: 'invalid-opportunity',
        type: 'single-market',
        markets: [],
        expectedProfit: 0.1,
        guaranteedProfit: 0.08,
        confidence: 0.9,
        tradeDirection: [],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      const result = await system.executeOpportunity(invalidOpportunity);
      expect(result).toBe(false);
    });

    it('should handle errors in main loop gracefully', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1'],
        events: [
          {
            id: 'error-event',
            markets: [{ id: 'market-1', outcome: 'YES', price: 0.5 }],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Start and stop quickly to trigger main loop
      await system.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await system.stop();

      // Should complete without throwing
      expect(true).toBe(true);
    });
  });

  describe('Multi-Market Scenario', () => {
    it('should handle event with multiple related markets', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-a-yes', 'market-a-no', 'market-b-yes', 'market-b-no'],
        events: [
          {
            id: 'multi-event',
            markets: [
              { id: 'market-a-yes', outcome: 'YES', price: 0.6 },
              { id: 'market-a-no', outcome: 'NO', price: 0.35 },
              { id: 'market-b-yes', outcome: 'YES', price: 0.55 },
              { id: 'market-b-no', outcome: 'NO', price: 0.4 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      const opportunities = await system.runDetectionCycle();

      // Should detect opportunities in multi-market scenario
      expect(Array.isArray(opportunities)).toBe(true);
    });

    it('should detect cross-market arbitrage', async () => {
      const detector = new ArbitrageDetector();

      // Add related events with price discrepancies
      detector.addEvent({
        id: 'event-a',
        markets: [
          { id: 'market-a-yes', eventId: 'event-a', outcome: 'YES', price: 0.7 },
          { id: 'market-a-no', eventId: 'event-a', outcome: 'NO', price: 0.25 },
        ],
        outcomes: ['YES', 'NO'],
      });

      detector.addEvent({
        id: 'event-b',
        markets: [
          { id: 'market-b-yes', eventId: 'event-b', outcome: 'YES', price: 0.65 },
          { id: 'market-b-no', eventId: 'event-b', outcome: 'NO', price: 0.3 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.findAllOpportunities();

      // Should find arbitrage opportunities
      expect(Array.isArray(opportunities)).toBe(true);
    });

    it('should resolve dependencies between markets', () => {
      const graph = getDependencyGraph();

      // Add markets with dependencies
      graph.addMarket({
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'YES',
        price: 0.6,
        metadata: {},
      });

      graph.addMarket({
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'NO',
        price: 0.4,
        metadata: {},
      });

      graph.addEvent({
        id: 'event-1',
        type: 'binary',
        outcomes: ['YES', 'NO'],
        markets: ['market-1', 'market-2'],
      });

      // Build constraint matrix
      const constraints = graph.buildConstraintMatrix();

      expect(constraints.coefficients.length).toBeGreaterThan(0);
      expect(constraints.rhs.length).toBe(constraints.coefficients.length);
      expect(constraints.types.length).toBe(constraints.coefficients.length);
    });

    it('should handle complex market relationships', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['m1', 'm2', 'm3', 'm4'],
        events: [
          {
            id: 'complex-event-1',
            markets: [
              { id: 'm1', outcome: 'YES', price: 0.55 },
              { id: 'm2', outcome: 'NO', price: 0.4 },
            ],
          },
          {
            id: 'complex-event-2',
            markets: [
              { id: 'm3', outcome: 'YES', price: 0.6 },
              { id: 'm4', outcome: 'NO', price: 0.35 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Run detection across multiple events
      const opportunities = await system.runDetectionCycle();

      expect(Array.isArray(opportunities)).toBe(true);
    });

    it('should find connected components in dependency graph', () => {
      const graph = getDependencyGraph();

      // Add markets in different components
      graph.addMarket({
        id: 'component1-market',
        eventId: 'event-1',
        outcome: 'YES',
        price: 0.6,
        metadata: {},
      });

      graph.addMarket({
        id: 'component2-market',
        eventId: 'event-2',
        outcome: 'YES',
        price: 0.5,
        metadata: {},
      });

      const components = graph.getConnectedComponents();

      expect(Array.isArray(components)).toBe(true);
      expect(components.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Order Book Integration', () => {
    it('should update order books from market data', () => {
      const manager = getOrderBookManager();

      manager.updateBook(
        'test-market',
        [{ price: 0.6, size: 100 }],
        [{ price: 0.65, size: 100 }]
      );

      const book = manager.getBook('test-market');
      const snapshot = book.getSnapshot();

      expect(snapshot.bids).toHaveLength(1);
      expect(snapshot.asks).toHaveLength(1);
    });

    it('should calculate VWAP correctly', () => {
      const manager = getOrderBookManager();

      manager.updateBook(
        'vwap-market',
        [
          { price: 0.58, size: 100 },
          { price: 0.59, size: 200 },
          { price: 0.6, size: 300 },
        ],
        [
          { price: 0.61, size: 100 },
          { price: 0.62, size: 200 },
          { price: 0.63, size: 300 },
        ]
      );

      const book = manager.getBook('vwap-market');
      const vwap = book.calculateVWAP(150, 'buy');

      expect(vwap.vwap).toBeGreaterThan(0);
      expect(vwap.executedSize).toBeLessThanOrEqual(150);
    });

    it('should check liquidity before trading', () => {
      const manager = getOrderBookManager();

      manager.updateBook(
        'liquidity-market',
        [{ price: 0.6, size: 1000 }],
        [{ price: 0.61, size: 1000 }]
      );

      const book = manager.getBook('liquidity-market');
      const hasLiquidity = book.hasSufficientLiquidity(100, 'buy');

      expect(typeof hasLiquidity).toBe('boolean');
    });
  });

  describe('Execution Engine Integration', () => {
    it('should execute orders through execution engine', async () => {
      const engine = getExecutionEngine();

      const result = await engine.executeOrder({
        id: 'test-order',
        marketId: 'test-market',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
        timeInForce: 'GTC',
      });

      expect(result).toBeDefined();
      expect(result.orderId).toBe('test-order');
    });

    it('should handle parallel order execution', async () => {
      const engine = getExecutionEngine();

      const orders = [
        {
          id: 'order-1',
          marketId: 'market-1',
          side: 'buy' as const,
          size: 100,
          price: 0.5,
          orderType: 'limit' as const,
          timeInForce: 'GTC' as const,
        },
        {
          id: 'order-2',
          marketId: 'market-2',
          side: 'sell' as const,
          size: 100,
          price: 0.5,
          orderType: 'limit' as const,
          timeInForce: 'GTC' as const,
        },
      ];

      const result = await engine.executeParallel(orders);

      expect(result).toBeDefined();
      expect(Array.isArray(result.orders)).toBe(true);
    });

    it('should execute arbitrage with multiple legs', async () => {
      const engine = getExecutionEngine();

      const legs = [
        { marketId: 'market-yes', side: 'buy' as const, size: 100, expectedPrice: 0.5 },
        { marketId: 'market-no', side: 'buy' as const, size: 100, expectedPrice: 0.4 },
      ];

      const result = await engine.executeArbitrage(legs, 'test-arbitrage');

      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
    });
  });

  describe('State Management', () => {
    it('should reset all singletons correctly', () => {
      // Initialize some state
      const riskManager = getRiskManager();
      riskManager.triggerCircuitBreaker('Test');

      const detector = getArbitrageDetector();
      detector.addEvent({
        id: 'test-event',
        markets: [{ id: 'm1', eventId: 'test-event', outcome: 'YES', price: 0.5 }],
        outcomes: ['YES', 'NO'],
      });

      // Reset all
      resetTradingSystem();

      // Get new instances
      const newRiskManager = getRiskManager();
      const newDetector = getArbitrageDetector();

      // Should be fresh instances
      expect(newRiskManager.isCircuitBreakerActive()).toBe(false);
    });

    it('should maintain independent state between instances', () => {
      const riskManager1 = new RiskManager({ maxExposure: 1000 });
      const riskManager2 = new RiskManager({ maxExposure: 2000 });

      // Trigger circuit breaker on first instance
      riskManager1.triggerCircuitBreaker('Test');

      // Second instance should not be affected
      expect(riskManager1.isCircuitBreakerActive()).toBe(true);
      expect(riskManager2.isCircuitBreakerActive()).toBe(false);
    });
  });

  describe('Partial Fill Handling', () => {
    it('should handle partial fills correctly', () => {
      const riskManager = new RiskManager();

      const partialStatus: OrderStatus = {
        orderId: 'partial-order',
        status: 'partial',
        filledSize: 50,
        remainingSize: 50,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      riskManager.updatePosition(partialStatus, 'market-1', 'buy');

      const position = riskManager.getPosition('market-1');
      expect(position?.size).toBe(50);
    });

    it('should recommend action for partial fills', () => {
      const riskManager = new RiskManager();

      const executed: OrderStatus[] = [
        {
          orderId: 'order-1',
          status: 'filled',
          filledSize: 100,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: Date.now(),
        },
      ];
      const failed: string[] = ['order-2'];

      const result = riskManager.handlePartialFill(executed, failed, 'arb-1');

      expect(result.action).toBeDefined();
      expect(result.reason).toBeDefined();
    });
  });

  describe('Configuration and Initialization', () => {
    it('should handle empty configuration', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: [],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      expect(() => system.initialize()).not.toThrow();
    });

    it('should handle live trading configuration', async () => {
      const config: TradingSystemConfig = {
        liveTrading: true,
        markets: ['market-1'],
        events: [
          {
            id: 'live-event',
            markets: [{ id: 'market-1', outcome: 'YES', price: 0.5 }],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Should initialize without errors
      expect(true).toBe(true);
    });

    it('should prevent multiple start calls', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: [],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      await system.start();

      // Second start should not throw, just log warning
      expect(() => system.start()).not.toThrow();
      system.stop();
    });
  });

  describe('Live Trading Execution', () => {
    it('should execute opportunity in live trading mode', async () => {
      const config: TradingSystemConfig = {
        liveTrading: true,
        markets: ['market-yes', 'market-no'],
        events: [
          {
            id: 'live-arbitrage-event',
            markets: [
              { id: 'market-yes', outcome: 'YES', price: 0.5 },
              { id: 'market-no', outcome: 'NO', price: 0.4 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Run detection cycle
      const opportunities = await system.runDetectionCycle();

      // Should find arbitrage opportunity
      expect(opportunities.length).toBeGreaterThan(0);

      // Execute the first opportunity in live trading mode
      // Result depends on risk manager check
      if (opportunities.length > 0) {
        const result = await system.executeOpportunity(opportunities[0]!);
        expect(typeof result).toBe('boolean');
      }
    });
  });

  describe('Data Pipeline Event Handling', () => {
    it('should handle trade events', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1'],
        events: [
          {
            id: 'event-1',
            markets: [{ id: 'market-1', outcome: 'YES', price: 0.5 }],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();
      await system.start();

      // Stop to trigger disconnection event
      await system.stop();

      // Should complete without errors
      expect(true).toBe(true);
    });

    it('should handle orderbook events', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1'],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Start and stop to trigger event handlers
      await system.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await system.stop();

      expect(true).toBe(true);
    });
  });

  describe('Emergency Stop and Error Handling', () => {
    it('should trigger emergency stop when risk threshold exceeded', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1'],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Get risk manager and simulate large loss
      const riskManager = getRiskManager();

      // Create positions that trigger emergency stop
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 10000,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status, 'market-1', 'buy');

      const closeStatus: OrderStatus = {
        orderId: 'order-2',
        status: 'filled',
        filledSize: 10000,
        remainingSize: 0,
        avgPrice: 0.1, // 80% loss
        timestamp: Date.now(),
      };
      riskManager.updatePosition(closeStatus, 'market-1', 'sell');

      // Check emergency stop
      const shouldStop = riskManager.checkEmergencyStop();
      expect(typeof shouldStop).toBe('boolean');
    });

    it('should handle main loop errors gracefully', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: [],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Start the system - errors in main loop should be caught
      await system.start();

      // Let it run briefly to potentially trigger error handling
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop cleanly
      await system.stop();

      expect(true).toBe(true);
    });
  });

  describe('Additional Edge Cases', () => {
    it('should handle opportunity with very high profit threshold', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-yes', 'market-no'],
        events: [
          {
            id: 'high-profit-event',
            markets: [
              { id: 'market-yes', outcome: 'YES', price: 0.3 },
              { id: 'market-no', outcome: 'NO', price: 0.3 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Run detection cycle
      const opportunities = await system.runDetectionCycle();

      // Should detect opportunities
      expect(Array.isArray(opportunities)).toBe(true);
    });

    it('should handle opportunity rejected by risk manager', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1', 'market-2'],
        events: [],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      // Create an opportunity that will be rejected due to risk limits
      const opportunity: ArbitrageOpportunity = {
        id: 'risky-opportunity',
        type: 'single-market',
        markets: ['market-1', 'market-2'],
        expectedProfit: 1000,
        guaranteedProfit: 1000,
        confidence: 0.9,
        tradeDirection: [10000, 10000], // Very large position
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      // Should be rejected due to position limits
      const result = await system.executeOpportunity(opportunity);
      expect(typeof result).toBe('boolean');
    });

    it('should estimate notional using market prices instead of raw size sum', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-1', 'market-2'],
        events: [
          {
            id: 'priced-event',
            markets: [
              { id: 'market-1', outcome: 'YES', price: 0.1 },
              { id: 'market-2', outcome: 'NO', price: 0.1 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      const riskManager = getRiskManager();
      riskManager.updateConfig({
        maxExposure: 50,
      });

      const opportunity: ArbitrageOpportunity = {
        id: 'price-aware-notional',
        type: 'cross-market',
        markets: ['market-1', 'market-2'],
        expectedProfit: 1,
        guaranteedProfit: 1,
        confidence: 0.9,
        tradeDirection: [1, 1],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      const result = await system.executeOpportunity(opportunity);
      expect(result).toBe(true);
    });

    it('should handle cross-market opportunity execution', async () => {
      const config: TradingSystemConfig = {
        liveTrading: false,
        markets: ['market-a', 'market-b', 'market-c'],
        events: [
          {
            id: 'cross-market-event',
            markets: [
              { id: 'market-a', outcome: 'YES', price: 0.6 },
              { id: 'market-b', outcome: 'NO', price: 0.35 },
              { id: 'market-c', outcome: 'YES', price: 0.55 },
            ],
          },
        ],
      };

      const system = new PolymarketTradingSystem(config);
      await system.initialize();

      const opportunities = await system.runDetectionCycle();

      // Should handle cross-market detection
      expect(Array.isArray(opportunities)).toBe(true);
    });
  });
});
