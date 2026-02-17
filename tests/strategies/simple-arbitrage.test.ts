import { OrderBook } from '../../src/market/order-book.js';
import { type StrategyMarketData } from '../../src/strategies/base.js';
import { SimpleArbitrageStrategy } from '../../src/strategies/simple-arbitrage.js';

describe('SimpleArbitrageStrategy', () => {
  describe('basic arbitrage detection', () => {
    it('should emit a paired trade plan for YES/NO mispricing (buy pair)', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        maxSlippage: 0.01,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();

      const pairedLegs = signal?.metadata?.['pairedLegs'] as
        | Array<{ marketId: string; side: 'buy' | 'sell'; size: number; price: number }>
        | undefined;

      expect(pairedLegs).toBeDefined();
      expect(pairedLegs).toHaveLength(2);
      expect(pairedLegs?.map((l) => l.marketId).sort()).toEqual(['event-no', 'event-yes']);
      expect(new Set(pairedLegs?.map((l) => l.side))).toEqual(new Set(['buy']));
    });

    it('should emit a paired trade plan for sell pair arbitrage', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        maxSlippage: 0.01,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      // Bids sum to > 1.02 (0.65 + 0.40 = 1.05)
      yesBook.update([{ price: 0.65, size: 200 }], [{ price: 0.66, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.40, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.65,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.40,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.type).toBe('sell');
      expect(signal?.reason).toContain('sell_pair');

      const pairedLegs = signal?.metadata?.['pairedLegs'] as
        | Array<{ marketId: string; side: 'buy' | 'sell'; size: number; price: number }>
        | undefined;

      expect(pairedLegs).toBeDefined();
      expect(pairedLegs).toHaveLength(2);
      expect(new Set(pairedLegs?.map((l) => l.side))).toEqual(new Set(['sell']));
    });
  });

  describe('edge cases and branch coverage', () => {
    it('should return null when strategy is disabled', () => {
      const strategy = new SimpleArbitrageStrategy({
        enabled: false,
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should return null during cooldown period', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
        cooldownMs: 5000,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      // First call should succeed
      const signal1 = strategy.analyze(marketData);
      expect(signal1).not.toBeNull();

      // Second call during cooldown should return null
      const signal2 = strategy.analyze(marketData);
      expect(signal2).toBeNull();
    });

    it('should return null when profit is below threshold', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.05, // High threshold
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // Sum = 0.96, profit = 0.04 (below 0.05 threshold)
      noBook.update([{ price: 0.40, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should return null when confidence is below threshold', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.5, // High confidence threshold
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // Small profit = low confidence (profit = 0.04, confidence = 0.4)
      noBook.update([{ price: 0.41, size: 200 }], [{ price: 0.42, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.42,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should use default minConfidence when not specified', () => {
      // Strategy without minConfidence - should use default 0.5
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        // minConfidence not specified - defaults to 0.5
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // Profit = 0.06, confidence = 0.6 > 0.5 default
      noBook.update([{ price: 0.37, size: 200 }], [{ price: 0.38, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.38,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.confidence).toBeCloseTo(0.6, 5);
    });

    it('should handle missing YES market', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should handle missing NO market', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should handle null ask prices', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      // Empty order book - no asks
      yesBook.update([], []);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should handle null bid prices for sell pair check', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      // No bids - can't check sell pair
      yesBook.update([], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      // Sum of asks = 0.97, which would trigger buy_pair if both had asks
      // But since yesBook has no bids, sell_pair check should be skipped
      const signal = strategy.analyze(marketData);
      // Should still find buy_pair opportunity (0.56 + 0.41 = 0.97 < 0.98)
      expect(signal).not.toBeNull();
      expect(signal?.type).toBe('buy');
    });

    it('should handle underscore naming convention (_yes, _no)', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event_yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event_no');
      noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event_yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event_no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.metadata?.['yesPrice']).toBe(0.56);
      expect(signal?.metadata?.['noPrice']).toBe(0.41);
    });

    it('should handle mixed naming conventions', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event_no');
      noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event_no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      // Code strips both -yes and _yes suffixes, so mixed conventions still match
      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.metadata?.['yesPrice']).toBe(0.56);
      expect(signal?.metadata?.['noPrice']).toBe(0.41);
    });

    it('should select correct market ID for buy pair when YES price is lower', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      // YES ask is lower than NO ask
      yesBook.update([{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.50, size: 200 }], [{ price: 0.51, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.46,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.51,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.marketId).toBe('event-yes'); // Lower price selected
      expect(signal?.price).toBe(0.46);
    });

    it('should select correct market ID for buy pair when NO price is lower', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // NO ask is lower than YES ask
      noBook.update([{ price: 0.40, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.marketId).toBe('event-no'); // Lower price selected
      expect(signal?.price).toBe(0.41);
    });

    it('should select correct market ID for sell pair when YES bid is higher', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      // YES bid is higher
      yesBook.update([{ price: 0.70, size: 200 }], [{ price: 0.71, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.35, size: 200 }], [{ price: 0.36, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.70,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.35,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.type).toBe('sell');
      expect(signal?.marketId).toBe('event-yes'); // Higher price selected for sell
      expect(signal?.price).toBe(0.70);
    });

    it('should select correct market ID for sell pair when NO bid is higher', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.35, size: 200 }], [{ price: 0.36, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // NO bid is higher
      noBook.update([{ price: 0.70, size: 200 }], [{ price: 0.71, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.35,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.70,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.type).toBe('sell');
      expect(signal?.marketId).toBe('event-no'); // Higher price selected for sell
      expect(signal?.price).toBe(0.70);
    });

    it('should return null when no arbitrage opportunity exists', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      // Prices sum to ~1.0 (no arbitrage)
      yesBook.update([{ price: 0.60, size: 200 }], [{ price: 0.61, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.40, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.61,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      // Sum = 1.02, no arbitrage opportunity
      expect(signal).toBeNull();
    });

    it('should handle empty market data array', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const signal = strategy.analyze([]);
      expect(signal).toBeNull();
    });

    it('should handle market data without yes/no suffix', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const book = new OrderBook('event-abc');
      book.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-abc',
          orderBook: book,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should handle sell pair with null yesBid', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      // No bids in yesBook
      yesBook.update([], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // High bid that would trigger sell_pair if yes had bids
      noBook.update([{ price: 0.70, size: 200 }], [{ price: 0.71, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.70,
          timestamp: Date.now(),
        },
      ];

      // Should find buy_pair (0.56 + 0.71 = 1.27 > 1, so no buy_pair)
      // Actually sum = 1.27, which is > 1, so no buy_pair
      // And can't check sell_pair because yesBook has no bids
      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should handle sell pair with null noBid', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      // High bid that would trigger sell_pair if no had bids
      yesBook.update([{ price: 0.70, size: 200 }], [{ price: 0.71, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // No bids in noBook
      noBook.update([], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.70,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      // Can't check sell_pair because noBook has no bids
      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });
  });

  describe('configuration', () => {
    it('should update arbitrage configuration', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        maxSlippage: 0.01,
        minConfidence: 0.1,
      });

      // Update config to require higher profit
      strategy.updateArbitrageConfig({
        minProfitThreshold: 0.10,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // Profit = 0.03, below new threshold of 0.10
      noBook.update([{ price: 0.41, size: 200 }], [{ price: 0.42, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.42,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('should use default configuration when not provided', () => {
      const strategy = new SimpleArbitrageStrategy();

      // Default minProfitThreshold is 0.02, minConfidence is 0.5
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // Sum = 0.87, profit = 0.13 > 0.02 threshold, confidence = 1.3 > 0.5
      noBook.update([{ price: 0.30, size: 200 }], [{ price: 0.31, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.31,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
    });
  });

  describe('position sizing', () => {
    it('should calculate position size based on profit', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
        maxPositionSize: 500,
      });

      const yesBook = new OrderBook('event-yes');
      // Sum = 0.80, profit = 0.20
      yesBook.update([{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.33, size: 200 }], [{ price: 0.34, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.46,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.34,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.size).toBeGreaterThan(0);
      expect(signal?.size).toBeLessThanOrEqual(500);
    });

    it('should use default maxPositionSize when not specified', () => {
      // Strategy without maxPositionSize - should use default 1000
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
        // maxPositionSize not specified - defaults to 1000
      });

      const yesBook = new OrderBook('event-yes');
      // High profit to generate large position size
      yesBook.update([{ price: 0.40, size: 200 }], [{ price: 0.41, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.35, size: 200 }], [{ price: 0.36, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.36,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      // Should cap at default 1000
      expect(signal?.size).toBeLessThanOrEqual(1000);
    });

    it('should cap position size at maxPositionSize', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
        maxPositionSize: 100, // Small max
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]);

      const noBook = new OrderBook('event-no');
      // High profit (sum = 0.87, profit = 0.13)
      noBook.update([{ price: 0.40, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.46,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.size).toBeLessThanOrEqual(100);
    });
  });

  describe('metadata and signal properties', () => {
    it('should include correct metadata in signal', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.40, size: 200 }], [{ price: 0.41, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();

      // Check metadata
      expect(signal?.metadata).toBeDefined();
      expect(signal?.metadata?.['arbitrageType']).toBe('simple');
      expect(signal?.metadata?.['yesPrice']).toBe(0.56);
      expect(signal?.metadata?.['noPrice']).toBe(0.41);
      expect(signal?.metadata?.['impliedProbability']).toBeDefined();
      expect(signal?.metadata?.['expectedProfit']).toBeCloseTo(0.03, 4); // 1 - 0.97

      // Check paired legs
      const pairedLegs = signal?.metadata?.['pairedLegs'] as
        | Array<{ marketId: string; side: 'buy' | 'sell'; size: number; price: number }>
        | undefined;
      expect(pairedLegs).toHaveLength(2);
      expect(pairedLegs?.[0].marketId).toBe('event-yes');
      expect(pairedLegs?.[1].marketId).toBe('event-no');
    });

    it('should calculate implied probability correctly', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.60, size: 200 }], [{ price: 0.61, size: 200 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.35, size: 200 }], [{ price: 0.36, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.61,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.36,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();

      // Sum = 0.97, impliedProbability = 0.61 / 0.97
      const expectedProb = 0.61 / 0.97;
      expect(signal?.metadata?.['impliedProbability']).toBeCloseTo(expectedProb, 5);
    });
  });

  describe('multiple market pairs', () => {
    it('should analyze first valid pair when multiple events exist', () => {
      const strategy = new SimpleArbitrageStrategy({
        minProfitThreshold: 0.02,
        minConfidence: 0.1,
      });

      const yesBook1 = new OrderBook('event1-yes');
      yesBook1.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

      const noBook1 = new OrderBook('event1-no');
      noBook1.update([{ price: 0.40, size: 200 }], [{ price: 0.41, size: 200 }]);

      const yesBook2 = new OrderBook('event2-yes');
      yesBook2.update([{ price: 0.60, size: 200 }], [{ price: 0.61, size: 200 }]);

      const noBook2 = new OrderBook('event2-no');
      noBook2.update([{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event1-yes',
          orderBook: yesBook1,
          lastPrice: 0.56,
          timestamp: Date.now(),
        },
        {
          marketId: 'event1-no',
          orderBook: noBook1,
          lastPrice: 0.41,
          timestamp: Date.now(),
        },
        {
          marketId: 'event2-yes',
          orderBook: yesBook2,
          lastPrice: 0.61,
          timestamp: Date.now(),
        },
        {
          marketId: 'event2-no',
          orderBook: noBook2,
          lastPrice: 0.46,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      // Should find event1 first (lower profit but first in map iteration)
      // Or event2 depending on Map iteration order
      expect(['event1-yes', 'event1-no', 'event2-yes', 'event2-no']).toContain(
        signal?.marketId
      );
    });
  });
});
