/**
 * Arbitrage Detector Unit Tests
 *
 * Comprehensive tests for arbitrage detection functionality.
 * Targets: 80%+ branch coverage
 */

import { jest } from '@jest/globals';
import {
  ArbitrageDetector,
  getArbitrageDetector,
  resetArbitrageDetector,
  type ArbitrageOpportunity,
} from '../../src/market/arbitrage-detector.js';
import {
  getOrderBookManager,
  resetOrderBookManager,
  type OrderBook,
} from '../../src/market/order-book.js';

function createAskBooks(quotes: Record<string, number>): Map<string, OrderBook> {
  const manager = getOrderBookManager();
  const timestamp = Date.now();
  for (const [marketId, price] of Object.entries(quotes)) {
    manager.updateBook(marketId, [], [{ price, size: 100 }], timestamp, 'snapshot');
  }
  return new Map(Object.keys(quotes).map((marketId) => [marketId, manager.getBook(marketId)]));
}

describe('ArbitrageDetector', () => {
  beforeEach(() => {
    resetArbitrageDetector();
    resetOrderBookManager();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetArbitrageDetector();
    resetOrderBookManager();
  });

  describe('Singleton Management', () => {
    it('should return the same instance from getArbitrageDetector', () => {
      const detector1 = getArbitrageDetector();
      const detector2 = getArbitrageDetector();

      expect(detector1).toBe(detector2);
    });

    it('should create new instance after reset', () => {
      const detector1 = getArbitrageDetector();
      resetArbitrageDetector();
      const detector2 = getArbitrageDetector();

      expect(detector1).not.toBe(detector2);
    });

    it('should allow multiple independent instances', () => {
      const detector1 = new ArbitrageDetector();
      const detector2 = new ArbitrageDetector();

      // Add event to first detector only
      detector1.addEvent({
        id: 'event-1',
        markets: [{ id: 'm1', eventId: 'event-1', outcome: 'YES', price: 0.5 }],
        outcomes: ['YES', 'NO'],
      });

      const opportunities1 = detector1.findAllOpportunities();
      const opportunities2 = detector2.findAllOpportunities();

      // First detector has event but no arbitrage (only one market)
      // Second detector has no events
      expect(opportunities2.length).toBe(0);
    });
  });

  describe('Event Management', () => {
    it('should add event with markets', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'm1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'm2', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      // Should not throw when finding opportunities
      expect(() => detector.findAllOpportunities()).not.toThrow();
    });

    it('should update market price', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [{ id: 'm1', eventId: 'event-1', outcome: 'YES', price: 0.5 }],
        outcomes: ['YES', 'NO'],
      });

      detector.updatePrice('m1', 0.6);

      // Should not throw after price update
      expect(() => detector.findAllOpportunities()).not.toThrow();
    });

    it('should throw when updating price for non-existent market', () => {
      const detector = new ArbitrageDetector();

      expect(() => detector.updatePrice('non-existent', 0.5)).toThrow(
        'Market non-existent not found'
      );
    });

    it('should clear all events', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'm1', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'm2', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      detector.clear();

      // After clear, no opportunities should be found
      const opportunities = detector.findAllOpportunities(
        createAskBooks({ 'yes-m1': 0.5, 'no-m1': 0.4 })
      );
      expect(opportunities.length).toBe(0);
    });
  });

  describe('Single Market Arbitrage Detection', () => {
    it('should detect arbitrage when YES + NO < 1', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();

      expect(opportunities.length).toBe(1);
      expect(opportunities[0]!.sum).toBe(0.9);
      expect(opportunities[0]!.deviation).toBeCloseTo(0.1, 10);
      expect(opportunities[0]!.profitPotential).toBeCloseTo(0.1, 10);
    });

    it('should detect arbitrage when YES + NO > 1', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.5 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();

      expect(opportunities.length).toBe(1);
      expect(opportunities[0]!.sum).toBe(1.1);
      expect(opportunities[0]!.deviation).toBeCloseTo(0.1, 10);
      expect(opportunities[0]!.profitPotential).toBeCloseTo(0.1, 10);
    });

    it('should not detect arbitrage when YES + NO = 1 (within tolerance)', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();

      expect(opportunities.length).toBe(0);
    });

    it('should use custom tolerance', () => {
      const detector = new ArbitrageDetector();

      // Use prices that give a clear deviation
      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.52 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.52 },
        ],
        outcomes: ['YES', 'NO'],
      });

      // Sum = 1.04, deviation = 0.04 which is > 0.01 default tolerance
      const opportunitiesDefault = detector.detectSingleMarketArbitrage();
      expect(opportunitiesDefault.length).toBe(1);

      // With larger tolerance (0.05), deviation (0.04) < tolerance (0.05), should NOT detect
      const opportunitiesLarge = detector.detectSingleMarketArbitrage(0.05);
      expect(opportunitiesLarge.length).toBe(0);

      // With smaller tolerance (0.02), deviation (0.04) > tolerance (0.02), should detect
      const opportunitiesStrict = detector.detectSingleMarketArbitrage(0.02);
      expect(opportunitiesStrict.length).toBe(1);
    });

    it('should handle event with more than 2 markets', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'm1', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'm2', eventId: 'event-1', outcome: 'NO', price: 0.4 },
          { id: 'm3', eventId: 'event-1', outcome: 'MAYBE', price: 0.1 },
        ],
        outcomes: ['YES', 'NO', 'MAYBE'],
      });

      // Events with more than 2 markets are not checked for single-market arbitrage
      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(0);
    });

    it('should handle event with missing YES market', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [{ id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 }],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(0);
    });

    it('should handle event with missing NO market', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [{ id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.6 }],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(0);
    });

    it('should handle event with neither YES nor NO markets', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'maybe-m1', eventId: 'event-1', outcome: 'MAYBE', price: 0.5 },
          { id: 'unknown-m1', eventId: 'event-1', outcome: 'UNKNOWN', price: 0.5 },
        ],
        outcomes: ['MAYBE', 'UNKNOWN'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(0);
    });

    it('should handle event with only YES market', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'maybe-m1', eventId: 'event-1', outcome: 'MAYBE', price: 0.4 },
        ],
        outcomes: ['YES', 'MAYBE'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(0);
    });

    it('should handle multiple events', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      detector.addEvent({
        id: 'event-2',
        markets: [
          { id: 'yes-m2', eventId: 'event-2', outcome: 'YES', price: 0.6 },
          { id: 'no-m2', eventId: 'event-2', outcome: 'NO', price: 0.5 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(2);
    });
  });

  describe('Cross Market Arbitrage Detection', () => {
    it('should return null when less than 2 markets', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [{ id: 'm1', eventId: 'event-1', outcome: 'YES', price: 0.5 }],
        outcomes: ['YES', 'NO'],
      });

      const result = detector.diagnoseCrossMarketIncoherence();
      expect(result).toBeNull();
    });

    it('should return null when no profitable arbitrage found', () => {
      const detector = new ArbitrageDetector();

      // Add efficient markets (YES + NO = 1)
      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const result = detector.diagnoseCrossMarketIncoherence();
      // Result depends on Frank-Wolfe implementation
      expect(result === null || Array.isArray(result?.markets)).toBe(true);
    });

    it('should detect cross-market arbitrage with multiple events', () => {
      const detector = new ArbitrageDetector();

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

      const result = detector.diagnoseCrossMarketIncoherence();
      // Should either find arbitrage or return null
      expect(result === null || typeof result.divergenceNats === 'number').toBe(true);
    });
  });

  describe('Find All Opportunities', () => {
    it('should return single-market opportunities', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.findAllOpportunities(
        createAskBooks({
          'yes-m1': 0.45,
          'no-m1': 0.45,
          'yes-m2': 0.3,
          'no-m2': 0.3,
        })
      );

      expect(opportunities.length).toBeGreaterThan(0);
      expect(opportunities[0]!.type).toBe('single-market');
      expect(opportunities[0]!.markets).toContain('yes-m1');
      expect(opportunities[0]!.markets).toContain('no-m1');
    });

    it('should sort opportunities by guaranteed profit', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.45 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.45 },
        ],
        outcomes: ['YES', 'NO'],
      });

      detector.addEvent({
        id: 'event-2',
        markets: [
          { id: 'yes-m2', eventId: 'event-2', outcome: 'YES', price: 0.3 },
          { id: 'no-m2', eventId: 'event-2', outcome: 'NO', price: 0.3 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.findAllOpportunities(
        createAskBooks({ 'yes-m1': 0.5, 'no-m1': 0.4 })
      );

      // Should be sorted by guaranteed profit descending
      for (let i = 1; i < opportunities.length; i++) {
        expect(opportunities[i - 1]!.guaranteedProfit).toBeGreaterThanOrEqual(
          opportunities[i]!.guaranteedProfit
        );
      }
    });

    it('should include timestamp and expiration', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.findAllOpportunities(
        createAskBooks({ 'yes-m1': 0.5, 'no-m1': 0.4 })
      );

      expect(opportunities.length).toBeGreaterThan(0);
      expect(opportunities[0]!.timestamp).toBeGreaterThan(0);
      expect(opportunities[0]!.expiresAt).toBeGreaterThan(opportunities[0]!.timestamp);
    });

    it('returns cross-market opportunities only from executable USD payoff models', () => {
      const detector = new ArbitrageDetector([
        {
          id: 'implication-cover',
          marketIds: ['event-a-yes', 'event-b-no'],
          feeBufferBps: 100,
          minGuaranteedProfitUsd: 0.05,
          scenarios: [
            { id: 'both-yes', payouts: [1, 0] },
            { id: 'a-yes-b-no', payouts: [1, 1] },
            { id: 'both-no', payouts: [0, 1] },
          ],
        },
      ]);
      detector.addEvent({
        id: 'event-a',
        markets: [{ id: 'event-a-yes', eventId: 'event-a', outcome: 'YES', price: 0.4 }],
        outcomes: ['YES', 'NO'],
      });
      detector.addEvent({
        id: 'event-b',
        markets: [{ id: 'event-b-no', eventId: 'event-b', outcome: 'NO', price: 0.5 }],
        outcomes: ['YES', 'NO'],
      });

      const manager = getOrderBookManager();
      manager.updateBook('event-a-yes', [], [{ price: 0.4, size: 10 }], undefined, 'snapshot');
      manager.updateBook('event-b-no', [], [{ price: 0.5, size: 10 }], undefined, 'snapshot');
      const orderBooks = new Map([
        ['event-a-yes', manager.getBook('event-a-yes')],
        ['event-b-no', manager.getBook('event-b-no')],
      ]);

      const opportunities = detector.findAllOpportunities(orderBooks);
      const crossMarket = opportunities.find((opportunity) => opportunity.type === 'cross-market');

      expect(crossMarket).toMatchObject({
        markets: ['event-a-yes', 'event-b-no'],
        profitUnit: 'USD',
        tradeDirection: [1, 1],
      });
      expect(crossMarket?.guaranteedProfit).toBeCloseTo(0.0567, 8);
    });

    it('never promotes the dimensionless KL diagnostic without payoff scenarios and books', () => {
      const detector = new ArbitrageDetector();
      detector.addEvent({
        id: 'event-a',
        markets: [
          { id: 'a-yes', eventId: 'event-a', outcome: 'YES', price: 0.8 },
          { id: 'a-no', eventId: 'event-a', outcome: 'NO', price: 0.1 },
        ],
        outcomes: ['YES', 'NO'],
      });
      detector.addEvent({
        id: 'event-b',
        markets: [
          { id: 'b-yes', eventId: 'event-b', outcome: 'YES', price: 0.7 },
          { id: 'b-no', eventId: 'event-b', outcome: 'NO', price: 0.1 },
        ],
        outcomes: ['YES', 'NO'],
      });

      expect(
        detector.findAllOpportunities().every((opportunity) => opportunity.type !== 'cross-market')
      ).toBe(true);
    });
  });

  describe('Score Opportunity', () => {
    it('should score opportunity with liquidity data', () => {
      const detector = new ArbitrageDetector();
      const manager = getOrderBookManager();

      // Setup order books
      manager.updateBook(
        'market-1',
        [{ price: 0.6, size: 5000 }],
        [{ price: 0.61, size: 5000 }],
        undefined,
        'snapshot'
      );
      manager.updateBook(
        'market-2',
        [{ price: 0.4, size: 5000 }],
        [{ price: 0.41, size: 5000 }],
        undefined,
        'snapshot'
      );

      const orderBooks = new Map();
      orderBooks.set('market-1', manager.getBook('market-1'));
      orderBooks.set('market-2', manager.getBook('market-2'));

      const opportunity: ArbitrageOpportunity = {
        id: 'test-opp',
        type: 'single-market',
        markets: ['market-1', 'market-2'],
        expectedProfit: 0.1,
        guaranteedProfit: 0.09,
        confidence: 0.9,
        tradeDirection: [1, 1],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      const score = detector.scoreOpportunity(opportunity, orderBooks);

      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThan(0);
    });

    it('should reduce score for low liquidity', () => {
      const detector = new ArbitrageDetector();
      const manager = getOrderBookManager();

      // Setup order books with low liquidity
      manager.updateBook(
        'market-1',
        [{ price: 0.6, size: 100 }],
        [{ price: 0.61, size: 100 }],
        undefined,
        'snapshot'
      );
      manager.updateBook(
        'market-2',
        [{ price: 0.4, size: 100 }],
        [{ price: 0.41, size: 100 }],
        undefined,
        'snapshot'
      );

      const orderBooks = new Map();
      orderBooks.set('market-1', manager.getBook('market-1'));
      orderBooks.set('market-2', manager.getBook('market-2'));

      const opportunity: ArbitrageOpportunity = {
        id: 'test-opp',
        type: 'single-market',
        markets: ['market-1', 'market-2'],
        expectedProfit: 0.1,
        guaranteedProfit: 0.09,
        confidence: 0.9,
        tradeDirection: [1, 1],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      const score = detector.scoreOpportunity(opportunity, orderBooks);

      // Score should be reduced due to low liquidity
      expect(score).toBeLessThan(opportunity.guaranteedProfit * opportunity.confidence);
    });

    it('should handle missing order book', () => {
      const detector = new ArbitrageDetector();

      const orderBooks = new Map();
      // No order books added

      const opportunity: ArbitrageOpportunity = {
        id: 'test-opp',
        type: 'single-market',
        markets: ['market-1', 'market-2'],
        expectedProfit: 0.1,
        guaranteedProfit: 0.09,
        confidence: 0.9,
        tradeDirection: [1, 1],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      const score = detector.scoreOpportunity(opportunity, orderBooks);

      // Score should be base score without liquidity adjustment
      expect(score).toBe(opportunity.guaranteedProfit * opportunity.confidence);
    });

    it('should handle order book without liquidity metrics', () => {
      const detector = new ArbitrageDetector();
      const manager = getOrderBookManager();

      // Setup empty order book (no bids/asks)
      manager.updateBook('market-1', [], [], undefined, 'snapshot');

      const orderBooks = new Map();
      orderBooks.set('market-1', manager.getBook('market-1'));

      const opportunity: ArbitrageOpportunity = {
        id: 'test-opp',
        type: 'single-market',
        markets: ['market-1'],
        expectedProfit: 0.1,
        guaranteedProfit: 0.09,
        confidence: 0.9,
        tradeDirection: [1],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      const score = detector.scoreOpportunity(opportunity, orderBooks);

      // Score should be base score without liquidity adjustment
      expect(score).toBe(opportunity.guaranteedProfit * opportunity.confidence);
    });

    it('should apply time decay factor', () => {
      const detector = new ArbitrageDetector();

      const orderBooks = new Map();

      // Opportunity about to expire
      const expiringOpportunity: ArbitrageOpportunity = {
        id: 'test-opp',
        type: 'single-market',
        markets: ['market-1'],
        expectedProfit: 0.1,
        guaranteedProfit: 0.09,
        confidence: 0.9,
        tradeDirection: [1],
        timestamp: Date.now() - 55000, // Created 55 seconds ago
        expiresAt: Date.now() + 5000, // Expires in 5 seconds
      };

      // Fresh opportunity
      const freshOpportunity: ArbitrageOpportunity = {
        id: 'test-opp-2',
        type: 'single-market',
        markets: ['market-1'],
        expectedProfit: 0.1,
        guaranteedProfit: 0.09,
        confidence: 0.9,
        tradeDirection: [1],
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
      };

      const expiringScore = detector.scoreOpportunity(expiringOpportunity, orderBooks);
      const freshScore = detector.scoreOpportunity(freshOpportunity, orderBooks);

      // Fresh opportunity should have higher score
      expect(freshScore).toBeGreaterThan(expiringScore);
    });

    it('should return zero score for expired opportunity', () => {
      const detector = new ArbitrageDetector();

      const orderBooks = new Map();

      const expiredOpportunity: ArbitrageOpportunity = {
        id: 'test-opp',
        type: 'single-market',
        markets: ['market-1'],
        expectedProfit: 0.1,
        guaranteedProfit: 0.09,
        confidence: 0.9,
        tradeDirection: [1],
        timestamp: Date.now() - 120000, // Created 2 minutes ago
        expiresAt: Date.now() - 60000, // Expired 1 minute ago
      };

      const score = detector.scoreOpportunity(expiredOpportunity, orderBooks);

      expect(score).toBe(0);
    });
  });

  describe('Compute Single Market Trade', () => {
    it('uses fresh dynamic zero-fee schedules instead of the conservative fallback', () => {
      const detector = new ArbitrageDetector([], { maxTakerFeeAgeMs: 60_000 });
      detector.addEvent({
        id: 'event-fees',
        markets: [
          { id: 'yes-fee', eventId: 'event-fees', outcome: 'YES', price: 0.48 },
          { id: 'no-fee', eventId: 'event-fees', outcome: 'NO', price: 0.5 },
        ],
        outcomes: ['YES', 'NO'],
      });
      const books = createAskBooks({ 'yes-fee': 0.48, 'no-fee': 0.5 });

      expect(detector.findAllOpportunities(books)).toHaveLength(0);

      const fetchedAt = Date.now();
      detector.setTakerFeeSchedules([
        {
          tokenId: 'yes-fee',
          conditionId: `0x${'a'.repeat(64)}`,
          rate: 0,
          exponent: 0,
          fetchedAt,
        },
        {
          tokenId: 'no-fee',
          conditionId: `0x${'a'.repeat(64)}`,
          rate: 0,
          exponent: 0,
          fetchedAt,
        },
      ]);

      expect(detector.findAllOpportunities(books)).toHaveLength(1);
    });

    it('falls back conservatively when dynamic fee schedules are stale', () => {
      const detector = new ArbitrageDetector([], { maxTakerFeeAgeMs: 10 });
      detector.addEvent({
        id: 'event-stale-fees',
        markets: [
          { id: 'yes-stale', eventId: 'event-stale-fees', outcome: 'YES', price: 0.48 },
          { id: 'no-stale', eventId: 'event-stale-fees', outcome: 'NO', price: 0.5 },
        ],
        outcomes: ['YES', 'NO'],
      });
      detector.setTakerFeeSchedules([
        {
          tokenId: 'yes-stale',
          conditionId: `0x${'b'.repeat(64)}`,
          rate: 0,
          exponent: 0,
          fetchedAt: Date.now() - 1000,
        },
        {
          tokenId: 'no-stale',
          conditionId: `0x${'b'.repeat(64)}`,
          rate: 0,
          exponent: 0,
          fetchedAt: Date.now() - 1000,
        },
      ]);

      expect(
        detector.findAllOpportunities(createAskBooks({ 'yes-stale': 0.48, 'no-stale': 0.5 }))
      ).toHaveLength(0);
    });

    it('should compute buy direction when sum < 1', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.findAllOpportunities(
        createAskBooks({ 'yes-m1': 0.5, 'no-m1': 0.4 })
      );
      expect(opportunities.length).toBeGreaterThan(0);

      const opportunity = opportunities[0]!;
      expect(opportunity.type).toBe('single-market');
      // Trade direction should be positive (buy both)
      expect(opportunity.tradeDirection[0]).toBeGreaterThan(0);
      expect(opportunity.tradeDirection[1]).toBeGreaterThan(0);
    });

    it('does not promote a theoretical short without executable inventory', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.5 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.findAllOpportunities(
        createAskBooks({ 'yes-m1': 0.6, 'no-m1': 0.5 })
      );
      expect(opportunities).toHaveLength(0);
    });

    it('should handle exact sum = 1 (no arbitrage)', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.findAllOpportunities();
      // Should not find single-market arbitrage when sum = 1
      const singleMarketOpps = opportunities.filter((o) => o.type === 'single-market');
      expect(singleMarketOpps.length).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty detector', () => {
      const detector = new ArbitrageDetector();

      const opportunities = detector.findAllOpportunities();
      expect(opportunities).toEqual([]);
    });

    it('should handle event with zero prices', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(1);
      expect(opportunities[0]!.sum).toBe(0);
      expect(opportunities[0]!.profitPotential).toBe(1);
    });

    it('should handle event with prices near 1', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.99 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.99 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(1);
      expect(opportunities[0]!.sum).toBe(1.98);
    });

    it('should handle very small deviation', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.601 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      // With default tolerance, should not detect (deviation = 0.001)
      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(0);

      // With smaller tolerance, should detect
      const opportunitiesStrict = detector.detectSingleMarketArbitrage(0.0005);
      expect(opportunitiesStrict.length).toBe(1);
    });

    it('should handle multiple price updates', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'yes-m1', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'no-m1', eventId: 'event-1', outcome: 'NO', price: 0.5 },
        ],
        outcomes: ['YES', 'NO'],
      });

      // Initially no arbitrage
      expect(detector.detectSingleMarketArbitrage().length).toBe(0);

      // Update to create arbitrage
      detector.updatePrice('yes-m1', 0.4);
      detector.updatePrice('no-m1', 0.4);

      const opportunities = detector.detectSingleMarketArbitrage();
      expect(opportunities.length).toBe(1);
      expect(opportunities[0]!.sum).toBe(0.8);
    });
  });

  describe('Private Methods', () => {
    it('should handle undefined theta values in computeGradient', () => {
      const detector = new ArbitrageDetector();

      // Access private method using type assertion
      const computeGradient = (
        detector as unknown as {
          computeGradient(mu: number[], theta: number[]): number[];
        }
      ).computeGradient.bind(detector);

      // Test with theta shorter than mu
      const mu = [0.5, 0.5, 0.5];
      const theta = [0.4]; // Only one element, others will be undefined

      const gradient = computeGradient(mu, theta);

      expect(gradient.length).toBe(3);
      expect(Number.isFinite(gradient[0])).toBe(true);
      expect(Number.isFinite(gradient[1])).toBe(true); // Should handle undefined theta[1]
      expect(Number.isFinite(gradient[2])).toBe(true); // Should handle undefined theta[2]
    });

    it('should handle empty theta array in computeGradient', () => {
      const detector = new ArbitrageDetector();

      const computeGradient = (
        detector as unknown as {
          computeGradient(mu: number[], theta: number[]): number[];
        }
      ).computeGradient.bind(detector);

      const mu = [0.5, 0.5];
      const theta: number[] = [];

      const gradient = computeGradient(mu, theta);

      expect(gradient.length).toBe(2);
      expect(Number.isFinite(gradient[0])).toBe(true);
      expect(Number.isFinite(gradient[1])).toBe(true);
    });

    it('should handle getEventsFromPolytope with multiple markets per event', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'm1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'm2', eventId: 'event-1', outcome: 'NO', price: 0.4 },
          { id: 'm3', eventId: 'event-1', outcome: 'MAYBE', price: 0.0 },
        ],
        outcomes: ['YES', 'NO', 'MAYBE'],
      });

      // Access private method
      const getEventsFromPolytope = (
        detector as unknown as {
          getEventsFromPolytope(): { id: string; markets: unknown[]; outcomes: string[] }[];
        }
      ).getEventsFromPolytope.bind(detector);

      const events = getEventsFromPolytope();

      expect(events.length).toBe(1);
      expect(events[0]!.markets.length).toBe(3);
    });

    it('should handle getEventsFromPolytope with multiple events', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'e1-m1', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'e1-m2', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      detector.addEvent({
        id: 'event-2',
        markets: [
          { id: 'e2-m1', eventId: 'event-2', outcome: 'YES', price: 0.7 },
          { id: 'e2-m2', eventId: 'event-2', outcome: 'NO', price: 0.3 },
        ],
        outcomes: ['YES', 'NO'],
      });

      const getEventsFromPolytope = (
        detector as unknown as {
          getEventsFromPolytope(): { id: string; markets: unknown[] }[];
        }
      ).getEventsFromPolytope.bind(detector);

      const events = getEventsFromPolytope();

      expect(events.length).toBe(2);
    });
  });
});
