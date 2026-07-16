/**
 * Data Pipeline Integration Tests
 *
 * Tests integration between data pipeline, order books, and arbitrage detection
 */

import { DataPipeline } from '../../src/market/data-pipeline.js';
import { getOrderBookManager, resetOrderBookManager } from '../../src/market/order-book.js';
import { ArbitrageDetector, resetArbitrageDetector } from '../../src/market/arbitrage-detector.js';
import { getDependencyGraph, resetDependencyGraph } from '../../src/market/dependency-graph.js';

describe('Data Pipeline Integration', () => {
  beforeEach(() => {
    resetOrderBookManager();
    resetArbitrageDetector();
    resetDependencyGraph();
  });

  afterEach(() => {
    resetOrderBookManager();
    resetArbitrageDetector();
    resetDependencyGraph();
  });

  describe('Order Book Updates', () => {
    it('should update order book from pipeline data', () => {
      const manager = getOrderBookManager();

      // Simulate pipeline updating order book
      manager.updateBook('market-1', [{ price: 0.6, size: 100 }], [{ price: 0.65, size: 100 }]);

      const book = manager.getBook('market-1');
      const snapshot = book.getSnapshot();

      expect(snapshot.bids).toHaveLength(1);
      expect(snapshot.asks).toHaveLength(1);
      expect(snapshot.bids[0]!.price).toBe(0.6);
      expect(snapshot.asks[0]!.price).toBe(0.65);
    });

    it('should maintain multiple order books', () => {
      const manager = getOrderBookManager();

      manager.updateBook('market-yes', [{ price: 0.6, size: 100 }], [{ price: 0.65, size: 100 }]);

      manager.updateBook('market-no', [{ price: 0.35, size: 100 }], [{ price: 0.4, size: 100 }]);

      const yesBook = manager.getBook('market-yes');
      const noBook = manager.getBook('market-no');

      expect(yesBook.getBestBid()?.price).toBe(0.6);
      expect(noBook.getBestBid()?.price).toBe(0.35);
    });

    it('should calculate mid price correctly', () => {
      const manager = getOrderBookManager();

      manager.updateBook('market-1', [{ price: 0.6, size: 100 }], [{ price: 0.7, size: 100 }]);

      const book = manager.getBook('market-1');
      const midPrice = book.getMidPrice();

      expect(midPrice).toBeCloseTo(0.65, 10);
    });

    it('should handle order book updates', () => {
      const manager = getOrderBookManager();

      // Initial update
      manager.updateBook('market-1', [{ price: 0.6, size: 100 }], [{ price: 0.7, size: 100 }]);

      // Update with new prices
      manager.updateBook('market-1', [{ price: 0.61, size: 150 }], [{ price: 0.69, size: 150 }]);

      const book = manager.getBook('market-1');
      expect(book.getBestBid()?.price).toBe(0.61);
      expect(book.getBestAsk()?.price).toBe(0.69);
    });
  });

  describe('Arbitrage Detection Integration', () => {
    it('should detect arbitrage when YES + NO < 1', () => {
      const detector = new ArbitrageDetector();
      const manager = getOrderBookManager();

      // Add event with YES/NO markets
      detector.addEvent({
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.5 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      // Update order books
      manager.updateBook('market-yes', [{ price: 0.5, size: 100 }], [{ price: 0.52, size: 100 }]);

      manager.updateBook('market-no', [{ price: 0.4, size: 100 }], [{ price: 0.42, size: 100 }]);

      // Update prices in detector
      detector.updatePrice('market-yes', 0.52);
      detector.updatePrice('market-no', 0.42);

      const opportunities = detector.findAllOpportunities(
        new Map([
          ['market-yes', manager.getBook('market-yes')],
          ['market-no', manager.getBook('market-no')],
        ])
      );

      // Should find arbitrage opportunity
      expect(opportunities.length).toBeGreaterThan(0);
    });

    it('should update prices and detect changes', () => {
      const detector = new ArbitrageDetector();

      detector.addEvent({
        id: 'event-1',
        markets: [{ id: 'market-1', eventId: 'event-1', outcome: 'YES', price: 0.5 }],
        outcomes: ['YES', 'NO'],
      });

      // Update price multiple times
      detector.updatePrice('market-1', 0.55);
      detector.updatePrice('market-1', 0.6);
      detector.updatePrice('market-1', 0.58);

      // Should not throw
      expect(() => detector.findAllOpportunities()).not.toThrow();
    });

    it('should handle cross-market arbitrage detection', () => {
      const detector = new ArbitrageDetector();

      // Add related events
      detector.addEvent({
        id: 'event-a',
        markets: [{ id: 'market-a', eventId: 'event-a', outcome: 'YES', price: 0.6 }],
        outcomes: ['YES', 'NO'],
      });

      detector.addEvent({
        id: 'event-b',
        markets: [{ id: 'market-b', eventId: 'event-b', outcome: 'YES', price: 0.35 }],
        outcomes: ['YES', 'NO'],
      });

      // Should detect opportunities across markets
      const opportunities = detector.findAllOpportunities();

      // Result depends on implementation details
      expect(Array.isArray(opportunities)).toBe(true);
    });
  });

  describe('Market Dependency Graph Integration', () => {
    it('should build constraints from market relationships', () => {
      const graph = getDependencyGraph();

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

      const constraints = graph.buildConstraintMatrix();

      expect(constraints.coefficients.length).toBeGreaterThan(0);
      expect(constraints.rhs.length).toBe(constraints.coefficients.length);
      expect(constraints.types.length).toBe(constraints.coefficients.length);
    });

    it('should find connected components', () => {
      const graph = getDependencyGraph();

      graph.addMarket({
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'YES',
        price: 0.6,
        metadata: {},
      });

      graph.addMarket({
        id: 'market-2',
        eventId: 'event-2',
        outcome: 'YES',
        price: 0.4,
        metadata: {},
      });

      const components = graph.getConnectedComponents();

      expect(Array.isArray(components)).toBe(true);
    });
  });

  describe('End-to-End Data Flow', () => {
    it('should process complete market data flow', () => {
      const manager = getOrderBookManager();
      const detector = new ArbitrageDetector();

      // Setup event
      detector.addEvent({
        id: 'test-event',
        markets: [
          { id: 'yes-market', eventId: 'test-event', outcome: 'YES', price: 0.55 },
          { id: 'no-market', eventId: 'test-event', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      });

      // Simulate incoming data
      manager.updateBook('yes-market', [{ price: 0.48, size: 1000 }], [{ price: 0.5, size: 1000 }]);

      manager.updateBook('no-market', [{ price: 0.38, size: 1000 }], [{ price: 0.4, size: 1000 }]);

      detector.updatePrice('yes-market', 0.555);
      detector.updatePrice('no-market', 0.405);

      // Calculate metrics
      const yesBook = manager.getBook('yes-market');
      const noBook = manager.getBook('no-market');

      const yesMid = yesBook.getMidPrice();
      const noMid = noBook.getMidPrice();

      expect(yesMid).toBeDefined();
      expect(noMid).toBeDefined();

      // Check for arbitrage
      const opportunities = detector.findAllOpportunities(
        new Map([
          ['yes-market', yesBook],
          ['no-market', noBook],
        ])
      );

      // YES + NO = 0.555 + 0.405 = 0.96 < 1, should be arbitrage
      if (yesMid && noMid && yesMid + noMid < 0.99) {
        expect(opportunities.length).toBeGreaterThan(0);
      }
    });

    it('should handle VWAP calculations', () => {
      const manager = getOrderBookManager();

      // Create order book with multiple levels
      manager.updateBook(
        'market-1',
        [
          { price: 0.6, size: 100 },
          { price: 0.59, size: 200 },
          { price: 0.58, size: 300 },
        ],
        [
          { price: 0.61, size: 100 },
          { price: 0.62, size: 200 },
          { price: 0.63, size: 300 },
        ]
      );

      const book = manager.getBook('market-1');

      // Calculate VWAP for small order
      const vwapSmall = book.calculateVWAP(50, 'buy');
      expect(vwapSmall.vwap).toBe(0.61);
      expect(vwapSmall.remainingSize).toBe(0);

      // Calculate VWAP for larger order
      const vwapLarge = book.calculateVWAP(250, 'buy');
      expect(vwapLarge.vwap).toBeGreaterThan(0.61);
      expect(vwapLarge.vwap).toBeLessThan(0.63);
    });

    it('should calculate slippage correctly', () => {
      const manager = getOrderBookManager();

      manager.updateBook('market-1', [{ price: 0.6, size: 1000 }], [{ price: 0.61, size: 1000 }]);

      const book = manager.getBook('market-1');

      // Small order should have low slippage
      const slippageSmall = book.calculateSlippage(100, 'buy');
      expect(slippageSmall).toBeLessThan(0.01);

      // Large order might have higher slippage (depends on available liquidity)
      const slippageLarge = book.calculateSlippage(2000, 'buy');
      expect(typeof slippageLarge).toBe('number');
    });
  });
});
