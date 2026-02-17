/**
 * Unit tests for Frank-Wolfe algorithm
 */

import {
  frankWolfe,
  barrierFrankWolfe,
  linearMinimizationOracle,
  isProfitableArbitrage,
  computeTradeRecommendation,
} from '../../src/core/frank-wolfe.js';
import { klDivergence } from '../../src/utils/math.js';

describe('FrankWolfe', () => {
  describe('linearMinimizationOracle', () => {
    it('should find minimum gradient component', () => {
      const gradient = [1, -2, 3, -1];
      const vertex = linearMinimizationOracle(gradient, []);

      // Minimum is at index 1 (value -2)
      expect(vertex).toEqual([0, 1, 0, 0]);
    });

    it('should handle all positive gradients', () => {
      const gradient = [1, 2, 3];
      const vertex = linearMinimizationOracle(gradient, []);

      // Minimum is at index 0 (value 1)
      expect(vertex).toEqual([1, 0, 0]);
    });

    it('should handle all negative gradients', () => {
      const gradient = [-3, -2, -1];
      const vertex = linearMinimizationOracle(gradient, []);

      // Minimum is at index 0 (value -3)
      expect(vertex).toEqual([1, 0, 0]);
    });

    it('should satisfy independent equality constraints', () => {
      const gradient = [5, 1, -2, 7];
      const constraints = [
        { coefficients: [1, 1, 0, 0], rhs: 1, type: 'equality' as const },
        { coefficients: [0, 0, 1, 1], rhs: 1, type: 'equality' as const },
      ];

      const vertex = linearMinimizationOracle(gradient, constraints);

      // For each equality group, choose the coordinate with minimum gradient.
      expect(vertex).toEqual([0, 1, 1, 0]);
    });
  });

  describe('frankWolfe', () => {
    it('should converge for simple KL divergence minimization', () => {
      const theta = [0.6, 0.4]; // Target distribution
      const initialMu = [0.5, 0.5];

      const objectiveFn = (mu: number[]) => klDivergence(mu, theta);
      const gradientFn = (mu: number[]) => {
        const epsilon = 1e-10;
        return mu.map((m, i) => Math.log(Math.max(m, epsilon) / Math.max(theta[i]!, epsilon)) + 1);
      };
      const lmoFn = (grad: number[]) => {
        const vertex = new Array(grad.length).fill(0);
        let minIdx = 0;
        let minValue = grad[0]!;
        for (let i = 1; i < grad.length; i++) {
          if (grad[i]! < minValue) {
            minValue = grad[i]!;
            minIdx = i;
          }
        }
        vertex[minIdx] = 1;
        return vertex;
      };

      const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 200,
        tolerance: 1e-8,
        stepSize: 'adaptive',
      });

      // Check that we made progress
      expect(result.iterations).toBeGreaterThan(0);
      expect(result.objective).toBeGreaterThanOrEqual(0);

      // Solution should be close to theta (within tolerance)
      expect(result.mu[0]!).toBeCloseTo(theta[0]!, 1);
      expect(result.mu[1]!).toBeCloseTo(theta[1]!, 1);
    });

    it('should handle uniform initial point', () => {
      const theta = [0.7, 0.2, 0.1];
      const initialMu = [1 / 3, 1 / 3, 1 / 3];

      const objectiveFn = (mu: number[]) => klDivergence(mu, theta);
      const gradientFn = (mu: number[]) => {
        const epsilon = 1e-10;
        return mu.map((m, i) => Math.log(Math.max(m, epsilon) / Math.max(theta[i]!, epsilon)) + 1);
      };
      const lmoFn = (grad: number[]) => {
        const vertex = new Array(grad.length).fill(0);
        let minIdx = 0;
        let minValue = grad[0]!;
        for (let i = 1; i < grad.length; i++) {
          if (grad[i]! < minValue) {
            minValue = grad[i]!;
            minIdx = i;
          }
        }
        vertex[minIdx] = 1;
        return vertex;
      };

      const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 150,
        stepSize: 'adaptive',
      });

      expect(result.mu.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    });
  });

  describe('barrierFrankWolfe', () => {
    it('should converge with barrier function', () => {
      const theta = [0.6, 0.4];
      const initialMu = [0.5, 0.5];
      const epsilon = 0.1;

      const objectiveFn = (mu: number[], eps: number) => {
        const barrier = eps * mu.reduce((sum, m) => sum + Math.log(m + eps), 0);
        return klDivergence(mu, theta) - barrier;
      };
      const gradientFn = (mu: number[], eps: number) => {
        const epsilon = 1e-10;
        const klGrad = mu.map((m, i) => Math.log(Math.max(m, epsilon) / Math.max(theta[i]!, epsilon)) + 1);
        const barrierGrad = mu.map((m) => eps / (m + eps));
        return klGrad.map((g, i) => g - barrierGrad[i]!);
      };
      const lmoFn = (grad: number[]) => {
        const vertex = new Array(grad.length).fill(0);
        let minIdx = 0;
        let minValue = grad[0]!;
        for (let i = 1; i < grad.length; i++) {
          if (grad[i]! < minValue) {
            minValue = grad[i]!;
            minIdx = i;
          }
        }
        vertex[minIdx] = 1;
        return vertex;
      };

      const result = barrierFrankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 100,
        initialEpsilon: epsilon,
      });

      expect(result.iterations).toBeGreaterThan(0);
      expect(result.mu.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    });
  });

  describe('isProfitableArbitrage', () => {
    it('should return true for profitable arbitrage', () => {
      const result = {
        mu: [0.6, 0.4],
        objective: 0.1,
        gap: 0.01,
        iterations: 10,
        converged: true,
        history: [],
      };

      expect(isProfitableArbitrage(result, 0.05)).toBe(true);
    });

    it('should return false for unprofitable arbitrage', () => {
      const result = {
        mu: [0.6, 0.4],
        objective: 0.05,
        gap: 0.04,
        iterations: 10,
        converged: true,
        history: [],
      };

      expect(isProfitableArbitrage(result, 0.05)).toBe(false);
    });

    it('should use default threshold', () => {
      const result = {
        mu: [0.6, 0.4],
        objective: 0.1,
        gap: 0.01,
        iterations: 10,
        converged: true,
        history: [],
      };

      expect(isProfitableArbitrage(result)).toBe(true);
    });
  });

  describe('computeTradeRecommendation', () => {
    it('should compute trade direction', () => {
      const result = {
        mu: [0.7, 0.3],
        objective: 0.1,
        gap: 0.01,
        iterations: 10,
        converged: true,
        history: [],
      };
      const prices = [0.6, 0.4];

      const trade = computeTradeRecommendation(result, prices);

      // Trade = projection - prices
      expect(trade[0]).toBeCloseTo(0.1, 5);  // Buy YES
      expect(trade[1]).toBeCloseTo(-0.1, 5); // Sell NO
    });
  });
});
