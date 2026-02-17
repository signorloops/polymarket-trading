/**
 * Unit tests for Bregman projection
 */

import {
  bregmanProjection,
  klGradient,
  bregmanDivergence,
  isProfitable,
  estimateProfit,
} from '../../src/core/bregman-projection.js';
import { klDivergence } from '../../src/utils/math.js';

describe('Bregman Projection', () => {
  describe('bregmanProjection', () => {
    it('should converge for simple constraints', () => {
      const priceVector = [0.6, 0.4];
      const constraints = [
        { coefficients: [1, 1], rhs: 1, type: 'equality' as const },
      ];

      const result = bregmanProjection(priceVector, constraints, 100, 1e-6);

      expect(result.converged).toBe(true);
      expect(result.projection).toHaveLength(2);
      expect(result.projection[0]! + result.projection[1]!).toBeCloseTo(1, 5);
    });

    it('should return valid probability distribution', () => {
      const priceVector = [0.7, 0.3];
      const constraints = [
        { coefficients: [1, 1], rhs: 1, type: 'equality' as const },
      ];

      const result = bregmanProjection(priceVector, constraints);

      // Check non-negative
      expect(result.projection[0]).toBeGreaterThanOrEqual(0);
      expect(result.projection[1]).toBeGreaterThanOrEqual(0);

      // Check sums to 1
      expect(result.projection[0]! + result.projection[1]!).toBeCloseTo(1, 5);
    });

    it('should compute divergence correctly', () => {
      const priceVector = [0.6, 0.4];
      const constraints = [
        { coefficients: [1, 1], rhs: 1, type: 'equality' as const },
      ];

      const result = bregmanProjection(priceVector, constraints);

      expect(result.divergence).toBeGreaterThanOrEqual(0);
      expect(result.iterations).toBeGreaterThan(0);
    });
  });

  describe('klGradient', () => {
    it('should compute gradient correctly', () => {
      const mu = [0.5, 0.5];
      const theta = [0.6, 0.4];

      const gradient = klGradient(mu, theta);

      // ∇_μ D(μ||θ) = log(μ/θ) + 1
      expect(gradient[0]).toBeCloseTo(Math.log(0.5 / 0.6) + 1, 5);
      expect(gradient[1]).toBeCloseTo(Math.log(0.5 / 0.4) + 1, 5);
    });

    it('should handle small values with epsilon', () => {
      const mu = [1e-11, 1];
      const theta = [1e-11, 1];

      const gradient = klGradient(mu, theta);

      // Should not throw or return Infinity
      expect(Number.isFinite(gradient[0])).toBe(true);
      expect(Number.isFinite(gradient[1])).toBe(true);
    });
  });

  describe('bregmanDivergence', () => {
    it('should be equivalent to klDivergence', () => {
      const mu = [0.5, 0.5];
      const theta = [0.6, 0.4];

      const bd = bregmanDivergence(mu, theta);
      const kl = klDivergence(mu, theta);

      expect(bd).toBe(kl);
    });

    it('should return 0 for identical distributions', () => {
      const mu = [0.5, 0.5];

      expect(bregmanDivergence(mu, mu)).toBeCloseTo(0, 10);
    });
  });

  describe('isProfitable', () => {
    it('should return true for profitable arbitrage', () => {
      const divergence = 0.1;
      const gap = 0.01;
      const minProfit = 0.05;

      expect(isProfitable(divergence, gap, minProfit)).toBe(true);
    });

    it('should return false for unprofitable arbitrage', () => {
      const divergence = 0.05;
      const gap = 0.04;
      const minProfit = 0.05;

      expect(isProfitable(divergence, gap, minProfit)).toBe(false);
    });

    it('should use default min profit threshold', () => {
      expect(isProfitable(0.1, 0.01)).toBe(true);
      expect(isProfitable(0.01, 0.009)).toBe(false);
    });

    it('should handle edge case of zero gap', () => {
      expect(isProfitable(0.1, 0, 0.05)).toBe(true);
    });
  });

  describe('estimateProfit', () => {
    it('should calculate profit for buy trade', () => {
      const trade = [0.1, -0.1]; // Buy first, sell second
      const prices = [0.6, 0.4];

      const profit = estimateProfit(trade, prices);

      // Profit = -sum(trade_i * price_i)
      // = -(0.1 * 0.6 + (-0.1) * 0.4) = -(0.06 - 0.04) = -0.02
      expect(profit).toBeCloseTo(-0.02, 5);
    });

    it('should calculate profit for arbitrage opportunity', () => {
      // When YES + NO < 1, buy both
      const trade = [0.1, 0.1];
      const prices = [0.4, 0.4];

      const profit = estimateProfit(trade, prices);

      // Cost = 0.1 * 0.4 + 0.1 * 0.4 = 0.08
      // Profit = -(-0.08) = 0.08 (negative cost = profit)
      expect(profit).toBeCloseTo(-0.08, 5);
    });

    it('should return 0 for zero trade', () => {
      const trade = [0, 0];
      const prices = [0.6, 0.4];

      expect(estimateProfit(trade, prices)).toBeCloseTo(0, 10);
    });
  });
});
