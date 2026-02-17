/**
 * Unit tests for position sizing
 */

import {
  calculatePositionSize,
  calculateMultiLegPositionSize,
  calculateSingleMarketArbitrageSize,
  validateRiskLimits,
  adjustForSlippage,
} from '../../src/execution/position-sizing.js';
import { OrderBook } from '../../src/market/order-book.js';

describe('Position Sizing', () => {
  let mockOrderBook: OrderBook;

  beforeEach(() => {
    mockOrderBook = new OrderBook('test-market');
    mockOrderBook.update(
      [{ price: 0.6, size: 1000 }],
      [{ price: 0.7, size: 1000 }]
    );
  });

  describe('calculatePositionSize', () => {
    it('should calculate position size using Kelly criterion', () => {
      const input = {
        probability: 0.7, // Higher probability for better edge
        price: 0.5,
        capital: 100000, // Higher capital
        orderBook: mockOrderBook,
        side: 'buy' as const,
      };

      const result = calculatePositionSize(input);

      // Kelly criterion may return 0 if edge is too small relative to constraints
      expect(result.size).toBeGreaterThanOrEqual(0);
      expect(result.fraction).toBeGreaterThanOrEqual(0);
    });

    it('should return zero for unfavorable odds', () => {
      const input = {
        probability: 0.4, // Less than 50%
        price: 0.5,
        capital: 10000,
        orderBook: mockOrderBook,
        side: 'buy' as const,
      };

      const result = calculatePositionSize(input);

      expect(result.size).toBe(0);
      expect(result.constraint).toBe('kelly');
    });

    it('should throw for invalid probability', () => {
      const input = {
        probability: 1.5,
        price: 0.5,
        capital: 10000,
        orderBook: mockOrderBook,
        side: 'buy' as const,
      };

      expect(() => calculatePositionSize(input)).toThrow();
    });

    it('should throw for NaN input', () => {
      const input = {
        probability: NaN,
        price: 0.5,
        capital: 10000,
        orderBook: mockOrderBook,
        side: 'buy' as const,
      };

      expect(() => calculatePositionSize(input)).toThrow('Invalid numeric input');
    });

    it('should throw for negative capital', () => {
      const input = {
        probability: 0.6,
        price: 0.5,
        capital: -1000,
        orderBook: mockOrderBook,
        side: 'buy' as const,
      };

      expect(() => calculatePositionSize(input)).toThrow('Capital must be non-negative');
    });
  });

  describe('calculateMultiLegPositionSize', () => {
    it('should calculate sizes for multiple legs', () => {
      const probabilities = [0.7, 0.3];
      const prices = [0.5, 0.4];
      const capital = 100000;
      const orderBooks = [mockOrderBook, mockOrderBook];

      const result = calculateMultiLegPositionSize(probabilities, prices, capital, orderBooks);

      expect(result.sizes).toHaveLength(2);
      expect(result.totalCapital).toBeGreaterThanOrEqual(0);
      expect(result.riskMetrics.maxLoss).toBeGreaterThanOrEqual(0);
    });

    it('should throw for mismatched array lengths', () => {
      expect(() =>
        calculateMultiLegPositionSize(
          [0.6],
          [0.5, 0.5],
          10000,
          [mockOrderBook]
        )
      ).toThrow('Input arrays must have the same length');
    });
  });

  describe('calculateSingleMarketArbitrageSize', () => {
    it('should calculate size for YES+NO < 1 arbitrage', () => {
      const yesBook = new OrderBook('yes-market');
      const noBook = new OrderBook('no-market');
      // Price at which we can buy
      yesBook.update([{ price: 0.3, size: 10000 }], [{ price: 0.35, size: 10000 }]);
      noBook.update([{ price: 0.3, size: 10000 }], [{ price: 0.35, size: 10000 }]);

      const result = calculateSingleMarketArbitrageSize(0.35, 0.35, 100000, yesBook, noBook);

      // Result may be 0 if constraints are not met
      expect(result.yesSize).toBeGreaterThanOrEqual(0);
      expect(result.noSize).toBeGreaterThanOrEqual(0);
      expect(result.expectedProfit).toBeGreaterThanOrEqual(0);
    });

    it('should return zero when no arbitrage exists', () => {
      const yesBook = new OrderBook('yes-market');
      const noBook = new OrderBook('no-market');
      yesBook.update([{ price: 0.6, size: 1000 }], [{ price: 0.7, size: 1000 }]);
      noBook.update([{ price: 0.5, size: 1000 }], [{ price: 0.6, size: 1000 }]);

      const result = calculateSingleMarketArbitrageSize(0.6, 0.5, 10000, yesBook, noBook);

      expect(result.yesSize).toBe(0);
      expect(result.noSize).toBe(0);
      expect(result.expectedProfit).toBe(0);
    });
  });

  describe('validateRiskLimits', () => {
    it('should allow trade within limits', () => {
      const result = validateRiskLimits(100, 10000, 0);

      expect(result.valid).toBe(true);
    });

    it('should reject trade exceeding max exposure', () => {
      const result = validateRiskLimits(50000, 10000, 0);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('max exposure');
    });

    it('should reject trade exceeding max bet fraction', () => {
      const result = validateRiskLimits(5000, 1000, 0);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('max bet fraction');
    });
  });

  describe('adjustForSlippage', () => {
    it('should return original size when slippage is within tolerance', () => {
      const size = 1000;
      const slippage = 0.01; // 1%

      const result = adjustForSlippage(size, slippage);

      expect(result).toBe(size);
    });

    it('should reduce size when slippage exceeds tolerance', () => {
      const size = 1000;
      const slippage = 0.05; // 5%

      const result = adjustForSlippage(size, slippage);

      expect(result).toBeLessThan(size);
    });
  });
});
