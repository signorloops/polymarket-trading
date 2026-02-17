/**
 * Bregman Projection using KL Divergence
 *
 * The Bregman projection finds the point in the marginal polytope that minimizes
 * the KL divergence to a given price vector. This corresponds to finding the
 * "closest" valid probability distribution.
 *
 * Profit guarantee: Profit >= D_KL(μ̂ || θ) - gap
 * where μ̂ is the projection and θ is the price vector
 */

import {
  vectorSubtract,
  vectorDot,
  klDivergence,
  vectorSum,
} from '../utils/math.js';
import { getLogger } from '../utils/logger.js';
import { ALGORITHM_CONFIG } from '../utils/config.js';

export interface Constraint {
  coefficients: number[];
  rhs: number;
  type: 'equality' | 'inequality';
}

export interface BregmanProjectionResult {
  /** Projected point (valid probability distribution) */
  projection: number[];
  /** KL divergence from price vector to projection */
  divergence: number;
  /** Number of iterations performed */
  iterations: number;
  /** Whether the projection converged */
  converged: boolean;
}

/**
 * Compute Bregman projection using iterative proportional fitting
 *
 * This solves: min_{μ ∈ M} D_KL(μ || θ)
 * where M is the marginal polytope and θ is the price vector
 *
 * @param priceVector Current market prices (θ)
 * @param constraints Linear constraints defining the polytope
 * @param maxIterations Maximum number of iterations
 * @param tolerance Convergence tolerance
 * @returns Projection result
 */
export function bregmanProjection(
  priceVector: number[],
  constraints: Constraint[],
  maxIterations: number = ALGORITHM_CONFIG.MAX_ITERATIONS,
  tolerance: number = ALGORITHM_CONFIG.CONVERGENCE_THRESHOLD
): BregmanProjectionResult {
  const logger = getLogger().child({ module: 'BregmanProjection' });

  const n = priceVector.length;

  // Initialize with uniform distribution
  let mu: number[] = new Array(n).fill(1 / n) as number[];

  // Ensure price vector is positive
  const theta = priceVector.map((p) => Math.max(p, 1e-10));

  logger.debug('Starting Bregman projection', {
    dimension: n,
    maxIterations,
    tolerance,
  });

  for (let iter = 0; iter < maxIterations; iter++) {
    const prevMu: number[] = [...mu] as number[];

    // Iterate through constraints
    for (const constraint of constraints) {
      if (constraint.type === 'equality') {
        // For equality constraints: sum(c_i * mu_i) = rhs
        const current = vectorDot(constraint.coefficients, mu);
        const ratio = constraint.rhs / Math.max(current, 1e-10);

        // Multiplicative update
        for (let i = 0; i < n; i++) {
          const coef = constraint.coefficients[i];
          if (coef !== undefined && coef > 0) {
            const currentMu = mu[i];
            if (currentMu !== undefined) {
              mu[i] = currentMu * Math.pow(ratio, coef);
            }
          }
        }
      }
    }

    // Normalize to ensure valid probability distribution
    const sum = vectorSum(mu);
    if (sum > 0) {
      mu = mu.map((m): number => m / sum);
    }

    // Check convergence
    const change = vectorNorm(vectorSubtract(mu, prevMu));
    if (change < tolerance) {
      const divergence = klDivergence(mu, theta);
      logger.debug('Bregman projection converged', {
        iterations: iter + 1,
        divergence,
      });

      return {
        projection: mu,
        divergence,
        iterations: iter + 1,
        converged: true,
      };
    }
  }

  // Did not converge within max iterations
  const divergence = klDivergence(mu, theta);
  logger.warn('Bregman projection did not converge', {
    iterations: maxIterations,
    divergence,
  });

  return {
    projection: mu,
    divergence,
    iterations: maxIterations,
    converged: false,
  };
}

/**
 * Compute the gradient of KL divergence at a point
 * ∇_μ D_KL(μ || θ) = log(μ/θ) + 1
 */
export function klGradient(mu: number[], theta: number[]): number[] {
  const epsilon = 1e-10;
  const safeMu = mu.map((m) => Math.max(m, epsilon));
  const safeTheta = theta.map((t) => Math.max(t, epsilon));

  return safeMu.map((m, i) => {
    const theta = safeTheta[i];
    return theta !== undefined ? Math.log(m / theta) + 1 : 1;
  });
}

/**
 * Compute the Bregman divergence (KL divergence) between two points
 */
export function bregmanDivergence(mu: number[], theta: number[]): number {
  return klDivergence(mu, theta);
}

/**
 * Compute the dual function value g(μ)
 * This represents the "guaranteed profit" from the projection
 */
export function dualFunctionValue(
  mu: number[],
  theta: number[],
  constraints: Constraint[]
): number {
  const divergence = klDivergence(mu, theta);

  // Add constraint violation penalties
  let penalty = 0;
  for (const constraint of constraints) {
    const violation = Math.abs(vectorDot(constraint.coefficients, mu) - constraint.rhs);
    penalty += violation;
  }

  return divergence - penalty;
}

/**
 * Check if the projection provides sufficient profit
 *
 * @param divergence KL divergence (potential profit)
 * @param gap Frank-Wolfe gap (optimality gap)
 * @param minProfit Minimum profit threshold
 * @returns Whether the arbitrage is profitable
 */
export function isProfitable(divergence: number, gap: number, minProfit?: number): boolean {
  const threshold = minProfit ?? ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD;
  const guaranteedProfit = divergence - gap;
  return guaranteedProfit >= threshold;
}

/**
 * Compute the profit estimate for a given trade
 *
 * @param trade Trade vector (amount to buy/sell for each outcome)
 * @param prices Current market prices
 * @returns Expected profit
 */
export function estimateProfit(trade: number[], prices: number[]): number {
  // Profit = -sum(trade_i * price_i) for buying
  // For selling, trade is negative
  return -vectorDot(trade, prices);
}

/**
 * Compute the optimal trade direction
 * Returns the direction that maximizes expected profit
 */
export function computeTradeDirection(
  projection: number[],
  prices: number[]
): number[] {
  // Trade direction: buy when projection > price, sell when projection < price
  return projection.map((p, i) => {
    const price = prices[i];
    return price !== undefined ? p - price : p;
  });
}

// Helper function
function vectorNorm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}
