/**
 * Unit tests for Bregman projection
 */

import {
  bregmanProjection,
  klGradient,
  bregmanDivergence,
  isProfitable,
  estimateProfit,
  dualFunctionValue,
  computeTradeDirection,
} from '../../src/core/bregman-projection.js';
import { klDivergence } from '../../src/utils/math.js';

describe('Bregman Projection', () => {
  describe('bregmanProjection', () => {
    it('should converge for simple constraints', () => {
      const priceVector = [0.6, 0.4];
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'equality' as const }];

      const result = bregmanProjection(priceVector, constraints, 100, 1e-6);

      expect(result.converged).toBe(true);
      expect(result.projection).toHaveLength(2);
      expect(result.projection[0]! + result.projection[1]!).toBeCloseTo(1, 5);
    });

    it('should return valid probability distribution', () => {
      const priceVector = [0.7, 0.3];
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'equality' as const }];

      const result = bregmanProjection(priceVector, constraints);

      // Check non-negative
      expect(result.projection[0]).toBeGreaterThanOrEqual(0);
      expect(result.projection[1]).toBeGreaterThanOrEqual(0);

      // Check sums to 1
      expect(result.projection[0]! + result.projection[1]!).toBeCloseTo(1, 5);
    });

    it('should compute divergence correctly', () => {
      const priceVector = [0.6, 0.4];
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'equality' as const }];

      const result = bregmanProjection(priceVector, constraints);

      expect(result.divergence).toBeGreaterThanOrEqual(0);
      expect(result.iterations).toBeGreaterThan(0);
    });

    it('should preserve independent event equalities without global renormalization', () => {
      const priceVector = [0.6, 0.4, 0.2, 0.8];
      const constraints = [
        { coefficients: [1, 1, 0, 0], rhs: 1, type: 'equality' as const },
        { coefficients: [0, 0, 1, 1], rhs: 1, type: 'equality' as const },
      ];

      const result = bregmanProjection(priceVector, constraints, 200, 1e-9);

      const group1 = (result.projection[0] ?? 0) + (result.projection[1] ?? 0);
      const group2 = (result.projection[2] ?? 0) + (result.projection[3] ?? 0);
      expect(group1).toBeCloseTo(1, 6);
      expect(group2).toBeCloseTo(1, 6);
    });

    it('returns the I-projection of θ, not the max-entropy point (CORE-1)', () => {
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'equality' as const }];

      const nearCorner = bregmanProjection([0.99, 0.01], constraints, 200, 1e-10);
      expect(nearCorner.projection[0]).toBeCloseTo(0.99, 5);
      expect(nearCorner.projection[1]).toBeCloseTo(0.01, 5);
      expect(nearCorner.divergence).toBeCloseTo(0, 5);

      const balanced = bregmanProjection([0.6, 0.4], constraints, 200, 1e-10);
      expect(balanced.projection[0]).toBeCloseTo(0.6, 5);
      expect(balanced.divergence).toBeCloseTo(0, 5);

      // Different θ on the same constraint set must yield different projections.
      expect(nearCorner.projection[0]).not.toBeCloseTo(balanced.projection[0]!, 2);
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

  describe('Non-convergence scenarios', () => {
    it('should return converged=false when max iterations reached', () => {
      const priceVector = [0.6, 0.4];
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'equality' as const }];

      // Use maxIterations=0 to force non-convergence (loop never executes)
      const result = bregmanProjection(priceVector, constraints, 0, 1e-10);

      expect(result.iterations).toBe(0);
      expect(result.converged).toBe(false);
      expect(result.projection).toHaveLength(2);
      expect(result.divergence).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty constraints', () => {
      const priceVector = [0.6, 0.4];
      const constraints: { coefficients: number[]; rhs: number; type: 'equality' }[] = [];

      const result = bregmanProjection(priceVector, constraints);

      // With no constraints, should still return valid distribution
      expect(result.projection).toHaveLength(2);
      expect(result.projection[0]! + result.projection[1]!).toBeCloseTo(1, 5);
      expect(result.converged).toBe(true);
    });

    it('should handle constraints with all zero coefficients', () => {
      const priceVector = [0.6, 0.4];
      const constraints = [{ coefficients: [0, 0], rhs: 1, type: 'equality' as const }];

      const result = bregmanProjection(priceVector, constraints);

      // Zero coefficients should be filtered out, leaving no constraints
      expect(result.projection).toHaveLength(2);
      expect(result.projection[0]! + result.projection[1]!).toBeCloseTo(1, 5);
    });

    it('should handle inequality constraints (filtered out)', () => {
      const priceVector = [0.6, 0.4];
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'inequality' as const }];

      const result = bregmanProjection(priceVector, constraints);

      // Inequality constraints should be filtered out
      expect(result.projection).toHaveLength(2);
      expect(result.projection[0]! + result.projection[1]!).toBeCloseTo(1, 5);
    });
  });

  describe('dualFunctionValue', () => {
    it('should compute dual value with no constraint violations', () => {
      const mu = [0.5, 0.5];
      const theta = [0.6, 0.4];
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'equality' as const }];

      const dualValue = dualFunctionValue(mu, theta, constraints);
      const expectedDivergence = klDivergence(mu, theta);

      // No violation, so dualValue should equal divergence
      expect(dualValue).toBeCloseTo(expectedDivergence, 5);
    });

    it('should subtract penalty for constraint violations', () => {
      const mu = [0.6, 0.3]; // Sums to 0.9, violating constraint of 1
      const theta = [0.6, 0.4];
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'equality' as const }];

      const dualValue = dualFunctionValue(mu, theta, constraints);
      const divergence = klDivergence(mu, theta);
      const expectedViolation = Math.abs(0.6 + 0.3 - 1); // 0.1

      // Penalty should be subtracted
      expect(dualValue).toBeCloseTo(divergence - expectedViolation, 5);
      expect(dualValue).toBeLessThan(divergence);
    });

    it('does not penalize satisfied inequalities (CORE-7)', () => {
      const mu = [0.6, 0.4];
      const theta = [0.6, 0.4];
      // coefficients · μ >= 0 is satisfied; old |·| logic wrongly charged 0.6+0.4.
      const constraints = [{ coefficients: [1, 1], rhs: 0, type: 'inequality' as const }];

      const dualValue = dualFunctionValue(mu, theta, constraints);
      expect(dualValue).toBeCloseTo(klDivergence(mu, theta), 5);
    });

    it('should accumulate penalties for multiple constraint violations', () => {
      const mu = [0.6, 0.4];
      const theta = [0.6, 0.4];
      const constraints = [
        { coefficients: [1, 0], rhs: 0.5, type: 'equality' as const }, // mu[0] should be 0.5
        { coefficients: [0, 1], rhs: 0.5, type: 'equality' as const }, // mu[1] should be 0.5
      ];

      const dualValue = dualFunctionValue(mu, theta, constraints);
      const divergence = klDivergence(mu, theta);
      const violation1 = Math.abs(0.6 - 0.5); // 0.1
      const violation2 = Math.abs(0.4 - 0.5); // 0.1
      const totalPenalty = violation1 + violation2;

      expect(dualValue).toBeCloseTo(divergence - totalPenalty, 5);
    });

    it('should handle empty constraints array', () => {
      const mu = [0.5, 0.5];
      const theta = [0.6, 0.4];
      const constraints: { coefficients: number[]; rhs: number; type: 'equality' }[] = [];

      const dualValue = dualFunctionValue(mu, theta, constraints);
      const divergence = klDivergence(mu, theta);

      expect(dualValue).toBeCloseTo(divergence, 5);
    });
  });

  describe('computeTradeDirection', () => {
    it('should compute trade direction for basic case', () => {
      const projection = [0.6, 0.4];
      const prices = [0.5, 0.5];

      const direction = computeTradeDirection(projection, prices);

      // Buy when projection > price, sell when projection < price
      expect(direction[0]).toBeCloseTo(0.1, 5); // 0.6 - 0.5
      expect(direction[1]).toBeCloseTo(-0.1, 5); // 0.4 - 0.5
    });

    it('should handle undefined price values', () => {
      const projection = [0.6, 0.4];
      const prices = [undefined as unknown as number, 0.5];

      const direction = computeTradeDirection(projection, prices);

      // When price is undefined, use projection value as fallback
      expect(direction[0]).toBeCloseTo(0.6, 5);
      expect(direction[1]).toBeCloseTo(-0.1, 5);
    });

    it('should handle undefined projection values', () => {
      const projection = [undefined as unknown as number, 0.4];
      const prices = [0.5, 0.5];

      const direction = computeTradeDirection(projection, prices);

      // When projection is undefined, result should be 0 (fallback to 0)
      expect(direction[0]).toBe(0);
      expect(direction[1]).toBeCloseTo(-0.1, 5);
    });

    it('should handle both undefined values', () => {
      const projection = [undefined as unknown as number, 0.4];
      const prices = [undefined as unknown as number, 0.5];

      const direction = computeTradeDirection(projection, prices);

      // When both are undefined, result should be 0
      expect(direction[0]).toBe(0);
      expect(direction[1]).toBeCloseTo(-0.1, 5);
    });

    it('should return zero direction when projection equals prices', () => {
      const projection = [0.5, 0.5];
      const prices = [0.5, 0.5];

      const direction = computeTradeDirection(projection, prices);

      expect(direction[0]).toBe(0);
      expect(direction[1]).toBe(0);
    });
  });

  describe('isProfitable edge cases', () => {
    it('should use minProfit parameter when provided', () => {
      const divergence = 0.1;
      const gap = 0.01;
      const minProfit = 0.2; // Higher than default

      // guaranteedProfit = 0.1 - 0.01 = 0.09, which is less than 0.2
      expect(isProfitable(divergence, gap, minProfit)).toBe(false);
    });

    it('should handle zero divergence', () => {
      expect(isProfitable(0, 0, 0)).toBe(true);
      expect(isProfitable(0, 0.01, 0)).toBe(false);
    });

    it('should handle negative guaranteed profit', () => {
      // When gap > divergence, guaranteed profit is negative
      expect(isProfitable(0.05, 0.1, 0)).toBe(false);
    });

    it('should handle very small minProfit threshold', () => {
      expect(isProfitable(0.001, 0.0001, 0.0005)).toBe(true);
    });
  });

  describe('Edge cases with sparse arrays', () => {
    it('should handle price vector with undefined elements', () => {
      const priceVector = [undefined as unknown as number, 0.4];
      const constraints = [{ coefficients: [1, 1], rhs: 1, type: 'equality' as const }];

      const result = bregmanProjection(priceVector, constraints);

      expect(result.projection).toHaveLength(2);
      expect(result.projection[0]! + result.projection[1]!).toBeCloseTo(1, 5);
    });

    it('should handle constraint coefficients with sparse indices', () => {
      const priceVector = [0.6, 0.4];
      // Create constraint with explicit zeros to test sparse filtering
      const constraints = [{ coefficients: [0, 1], rhs: 0.4, type: 'equality' as const }];

      const result = bregmanProjection(priceVector, constraints);

      expect(result.projection).toHaveLength(2);
      expect(result.converged).toBe(true);
    });

    it('should handle constraint with coefficient exactly at boundary', () => {
      const priceVector = [0.6, 0.4];
      // Very small coefficient should still be included
      const constraints = [{ coefficients: [1e-11, 1], rhs: 1, type: 'equality' as const }];

      const result = bregmanProjection(priceVector, constraints);

      expect(result.projection).toHaveLength(2);
      const lhs = (result.projection[0] ?? 0) * 1e-11 + (result.projection[1] ?? 0);
      expect(lhs).toBeCloseTo(1, 5);
    });

    it('should handle single element price vector', () => {
      const priceVector = [1];
      const constraints = [{ coefficients: [1], rhs: 1, type: 'equality' as const }];

      const result = bregmanProjection(priceVector, constraints);

      expect(result.projection).toHaveLength(1);
      expect(result.projection[0]).toBeCloseTo(1, 5);
      expect(result.converged).toBe(true);
    });

    it('should handle large dimension price vector', () => {
      const n = 100;
      const priceVector = new Array(n).fill(0).map((_, i) => (i + 1) / ((n * (n + 1)) / 2));
      const constraints = [
        { coefficients: new Array(n).fill(1), rhs: 1, type: 'equality' as const },
      ];

      const result = bregmanProjection(priceVector, constraints);

      expect(result.projection).toHaveLength(n);
      const sum = result.projection.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
      expect(result.converged).toBe(true);
    });
  });

  describe('klGradient edge cases', () => {
    it('should handle mu with undefined elements', () => {
      const mu = [undefined as unknown as number, 0.5];
      const theta = [0.6, 0.4];

      const gradient = klGradient(mu, theta);

      // Should handle undefined gracefully with epsilon
      expect(Number.isFinite(gradient[0])).toBe(true);
      expect(Number.isFinite(gradient[1])).toBe(true);
    });

    it('should handle theta with undefined elements', () => {
      const mu = [0.5, 0.5];
      const theta = [undefined as unknown as number, 0.4];

      const gradient = klGradient(mu, theta);

      // Should handle undefined gracefully with epsilon
      expect(Number.isFinite(gradient[0])).toBe(true);
      expect(Number.isFinite(gradient[1])).toBe(true);
    });

    it('should handle both mu and theta with zero values', () => {
      const mu = [0, 0];
      const theta = [0, 0];

      const gradient = klGradient(mu, theta);

      // Should not return Infinity or NaN
      expect(Number.isFinite(gradient[0])).toBe(true);
      expect(Number.isFinite(gradient[1])).toBe(true);
    });
  });
});
