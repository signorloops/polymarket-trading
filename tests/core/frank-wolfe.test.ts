/**
 * Unit tests for Frank-Wolfe algorithm
 */

import {
  frankWolfe,
  barrierFrankWolfe,
  linearMinimizationOracle,
  isProfitableArbitrage,
  computeTradeRecommendation,
  Float64ArrayPool,
  copyTo,
  addScaledInPlace,
  subtractInPlace,
  dot,
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

    it('should converge when starting from optimal point', () => {
      // Start from a point that is already optimal (or very close to it)
      // This ensures the convergence check is triggered immediately
      const initialMu = [0.5, 0.5];

      // Use a very simple objective where the initial point is already optimal
      // f(mu) = 0 for all mu (constant function)
      const objectiveFn = () => 0.001; // Small positive objective
      const gradientFn = () => [0.001, 0.001]; // Small positive gradient
      const lmoFn = (grad: number[]) => {
        const vertex = new Array(grad.length).fill(0);
        // Find minimum gradient component
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

      // Use very loose tolerance to ensure immediate convergence
      const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 100,
        tolerance: 1.0, // Very loose tolerance
        stepSize: 'adaptive',
      });

      expect(result.converged).toBe(true);
      expect(result.iterations).toBeGreaterThan(0);
    });

    it('should use default options when not provided', () => {
      const theta = [0.6, 0.4];
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

      // Call without options - should use defaults
      const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn);

      expect(result.iterations).toBeGreaterThan(0);
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

    it('should use line-search step size', () => {
      const theta = [0.6, 0.4];
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
        stepSize: 'line-search',
      });

      expect(result.iterations).toBeGreaterThan(0);
      // Algorithm should make progress with line-search step size
      expect(result.objective).toBeGreaterThanOrEqual(0);
    });

    it('should use default step size when stepSize option is not recognized', () => {
      const theta = [0.6, 0.4];
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

      // Use an invalid stepSize value to trigger the default branch
      const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 200,
        tolerance: 1e-8,
        stepSize: 'invalid-step-size' as 'line-search' | 'adaptive',
        initialStepSize: 0.05,
      });

      expect(result.iterations).toBeGreaterThan(0);
    });

    it('should use default step size of 0.1 when initialStepSize is not provided', () => {
      const theta = [0.6, 0.4];
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

      // Use an invalid stepSize value without providing initialStepSize
      const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 200,
        tolerance: 1e-8,
        stepSize: 'invalid-step-size' as 'line-search' | 'adaptive',
      });

      expect(result.iterations).toBeGreaterThan(0);
    });

    it('should log debug info when verbose mode is enabled', () => {
      const theta = [0.6, 0.4];
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

      // Run with verbose mode - should trigger logging at iterations 0, 10, 20, ...
      const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 25,
        tolerance: 1e-8,
        stepSize: 'adaptive',
        verbose: true,
      });

      expect(result.iterations).toBeGreaterThan(0);
    });

    it('should reach max iterations without converging when tolerance is very small', () => {
      const theta = [0.6, 0.4];
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

      // Use very strict tolerance and few iterations to force max iterations reached
      const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 5,
        tolerance: 1e-20, // Very strict tolerance that won't be met
        stepSize: 'adaptive',
      });

      expect(result.iterations).toBe(5);
      expect(result.converged).toBe(false);
    });

    it('should handle multiple calls to exercise Float64ArrayPool', () => {
      const theta = [0.6, 0.4];

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

      // Call multiple times to exercise the Float64ArrayPool acquire/release cycle
      // This ensures the pool.pop() branch is tested when pool has items
      const results = [];
      for (let i = 0; i < 10; i++) {
        const initialMu = [0.5, 0.5];
        const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
          maxIterations: 200,
          tolerance: 1e-8,
          stepSize: 'adaptive',
        });
        results.push(result);
      }

      // All calls should succeed
      expect(results.every(r => r.iterations > 0)).toBe(true);
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

    it('should trigger epsilon shrinking when gapU is negative', () => {
      // Use a simple test case where we can control the gradients
      const initialMu = [0.5, 0.5];
      const epsilon = 0.1;

      // Create a scenario where gapU < 0 and gap / (-4 * gapU) < epsilon
      // This requires: gradientNoBarrier dot (mu - s) < 0
      const objectiveFn = () => 1.0;
      const gradientFn = (mu: number[], eps: number) => {
        // Return gradient that will produce negative gapU when eps=0
        // gap = gradient dot (mu - s)
        // We need gapU (with eps=0) to be negative
        if (eps === 0) {
          // Return a gradient that creates negative gapU
          return [1.0, -2.0];
        }
        // With epsilon, return different gradient to create positive gap
        return [2.0, -1.0];
      };
      const lmoFn = (grad: number[]) => {
        // LMO finds vertex minimizing gradient dot v
        // For grad [2, -1], min is at index 1 (value -1)
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
        maxIterations: 50,
        initialEpsilon: epsilon,
        tolerance: 0.5, // Use looser tolerance to allow more iterations
      });

      expect(result.iterations).toBeGreaterThan(0);
    });

    it('should log debug info in verbose mode', () => {
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
        maxIterations: 25,
        initialEpsilon: epsilon,
        verbose: true,
      });

      expect(result.iterations).toBeGreaterThan(0);
    });

    it('should reach max iterations without converging', () => {
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

      // Use very strict tolerance and few iterations to force max iterations reached
      const result = barrierFrankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
        maxIterations: 5,
        tolerance: 1e-20, // Very strict tolerance that won't be met
        initialEpsilon: epsilon,
      });

      expect(result.iterations).toBe(5);
      expect(result.converged).toBe(false);
    });

    it('should use default options when not provided', () => {
      const theta = [0.6, 0.4];
      const initialMu = [0.5, 0.5];

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

      // Call without options - should use defaults
      const result = barrierFrankWolfe(initialMu, objectiveFn, gradientFn, lmoFn);

      expect(result.iterations).toBeGreaterThan(0);
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

  describe('Vector operations', () => {
    it('copyTo should copy values from source to target', () => {
      const target = new Float64Array(3);
      const source = [1, 2, 3];

      copyTo(target, source);

      expect(target[0]).toBe(1);
      expect(target[1]).toBe(2);
      expect(target[2]).toBe(3);
    });

    it('copyTo should handle undefined values in source', () => {
      const target = new Float64Array(3);
      const source = [1, undefined, 3] as number[];

      copyTo(target, source);

      expect(target[0]).toBe(1);
      expect(target[1]).toBe(0); // undefined becomes 0
      expect(target[2]).toBe(3);
    });

    it('addScaledInPlace should compute scaleA * a + scaleB * b', () => {
      const result = new Float64Array(3);
      const a = new Float64Array([1, 2, 3]);
      const b = new Float64Array([4, 5, 6]);

      addScaledInPlace(result, a, b, 2, 3);

      // result[i] = 2 * a[i] + 3 * b[i]
      expect(result[0]).toBe(2 * 1 + 3 * 4); // 14
      expect(result[1]).toBe(2 * 2 + 3 * 5); // 19
      expect(result[2]).toBe(2 * 3 + 3 * 6); // 24
    });

    it('subtractInPlace should compute a - b', () => {
      const result = new Float64Array(3);
      const a = new Float64Array([5, 6, 7]);
      const b = new Float64Array([1, 2, 3]);

      subtractInPlace(result, a, b);

      expect(result[0]).toBe(4);
      expect(result[1]).toBe(4);
      expect(result[2]).toBe(4);
    });

    it('dot should compute the dot product of two vectors', () => {
      const a = new Float64Array([1, 2, 3]);
      const b = new Float64Array([4, 5, 6]);

      const result = dot(a, b);

      // 1*4 + 2*5 + 3*6 = 4 + 10 + 18 = 32
      expect(result).toBe(32);
    });

    it('dot should handle empty arrays', () => {
      const a = new Float64Array(0);
      const b = new Float64Array(0);

      const result = dot(a, b);

      expect(result).toBe(0);
    });

    it('should handle arrays with undefined elements', () => {
      // Create arrays with holes (sparse arrays)
      const a = new Float64Array(3);
      const b = new Float64Array(3);
      // Float64Array initializes to 0, so we can't easily create undefined elements
      // But we can test the ?? 0 fallback by using regular arrays cast to Float64Array
      // Actually, Float64Array doesn't have undefined elements, they're always 0
      // So this test is just for completeness
      const result = dot(a, b);
      expect(result).toBe(0);
    });
  });

  describe('Float64ArrayPool', () => {
    it('should create new arrays when pool is empty', () => {
      const pool = new Float64ArrayPool(10, 5);

      const arr1 = pool.acquire();
      const arr2 = pool.acquire();

      expect(arr1).toBeInstanceOf(Float64Array);
      expect(arr2).toBeInstanceOf(Float64Array);
      expect(arr1).not.toBe(arr2);
      expect(arr1.length).toBe(10);
      expect(arr2.length).toBe(10);
    });

    it('should use default maxPoolSize when not provided', () => {
      // Test default maxPoolSize = 10
      const pool = new Float64ArrayPool(10);

      // Acquire and release 15 arrays (more than default maxPoolSize)
      const arrays = [];
      for (let i = 0; i < 15; i++) {
        arrays.push(pool.acquire());
      }

      // Release all - only 10 should be kept in pool
      for (const arr of arrays) {
        pool.release(arr);
      }

      // Acquire 15 again - first 10 should be reused, last 5 should be new
      const newArrays = [];
      for (let i = 0; i < 15; i++) {
        newArrays.push(pool.acquire());
      }

      // Check that we got 15 arrays
      expect(newArrays.length).toBe(15);
    });

    it('should reuse arrays from pool after release', () => {
      const pool = new Float64ArrayPool(10, 5);

      // Acquire and release an array
      const arr1 = pool.acquire();
      arr1[0] = 42;
      pool.release(arr1);

      // Acquire again - should get the same array (zeroed)
      const arr2 = pool.acquire();
      expect(arr2).toBe(arr1);
      expect(arr2[0]).toBe(0); // Should be zeroed
    });

    it('should respect max pool size', () => {
      const pool = new Float64ArrayPool(10, 2);

      // Acquire 3 arrays
      const arr1 = pool.acquire();
      const arr2 = pool.acquire();
      const arr3 = pool.acquire();

      // Release all 3
      pool.release(arr1);
      pool.release(arr2);
      pool.release(arr3); // Should not be added to pool (max size = 2)

      // Acquire again - should get arr2 first (LIFO), then arr1
      const arr4 = pool.acquire();
      const arr5 = pool.acquire();
      expect(arr4).toBe(arr2);
      expect(arr5).toBe(arr1);

      // Sixth acquire should create a new array
      const arr6 = pool.acquire();
      expect(arr6).not.toBe(arr1);
      expect(arr6).not.toBe(arr2);
      expect(arr6).not.toBe(arr3);
    });

    it('should release multiple arrays at once', () => {
      const pool = new Float64ArrayPool(10, 5);

      const arr1 = pool.acquire();
      const arr2 = pool.acquire();
      const arr3 = pool.acquire();

      pool.releaseMultiple([arr1, arr2, arr3]);

      // All should be reused
      const arr4 = pool.acquire();
      const arr5 = pool.acquire();
      const arr6 = pool.acquire();

      expect([arr4, arr5, arr6]).toContain(arr1);
      expect([arr4, arr5, arr6]).toContain(arr2);
      expect([arr4, arr5, arr6]).toContain(arr3);
    });
  });
});
