/**
 * Bregman Projection using KL Divergence
 *
 * The Bregman projection finds the point in the marginal polytope that minimizes
 * the KL divergence to a given price vector. This corresponds to finding the
 * "closest" valid probability distribution.
 *
 * The quantity D_KL(μ̂ || θ) − gap is a dimensionless incoherence lower bound
 * (nats), not dollar profit (CORE-9).
 */

import { vectorDot, klDivergence } from '../utils/math.js';
import { getLogger } from '../utils/logger.js';
import { ALGORITHM_CONFIG } from '../utils/config.js';
import type { Constraint } from './frank-wolfe-types.js';

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
 * Preprocessed constraint for efficient iteration
 * Stores only non-zero coefficients
 */
interface SparseConstraint {
  indices: number[];
  coefficients: number[];
  rhs: number;
}

/**
 * Preprocess constraints to extract sparse structure
 * Only stores indices where coefficient > 0
 */
function preprocessConstraints(constraints: Constraint[], n: number): SparseConstraint[] {
  const sparse: SparseConstraint[] = [];

  for (const constraint of constraints) {
    if (constraint.type !== 'equality') continue;

    const indices: number[] = [];
    const coeffs: number[] = [];

    for (let i = 0; i < n; i++) {
      const coef = constraint.coefficients[i];
      if (coef !== undefined && coef > 0) {
        indices.push(i);
        coeffs.push(coef);
      }
    }

    if (indices.length > 0) {
      sparse.push({
        indices,
        coefficients: coeffs,
        rhs: constraint.rhs,
      });
    }
  }

  return sparse;
}

/**
 * Compute dot product only over sparse indices
 */
function sparseDot(constraint: SparseConstraint, mu: number[]): number {
  let sum = 0;
  for (let j = 0; j < constraint.indices.length; j++) {
    const idx = constraint.indices[j];
    const coef = constraint.coefficients[j];
    if (idx !== undefined && coef !== undefined) {
      const muVal = mu[idx];
      if (muVal !== undefined) {
        sum += coef * muVal;
      }
    }
  }
  return sum;
}

/**
 * In-place multiplicative update for a constraint
 */
function applyConstraintUpdate(mu: number[], constraint: SparseConstraint, ratio: number): void {
  for (let j = 0; j < constraint.indices.length; j++) {
    const idx = constraint.indices[j];
    const coef = constraint.coefficients[j];
    if (idx !== undefined && coef !== undefined) {
      const currentMu = mu[idx];
      if (currentMu !== undefined) {
        mu[idx] = currentMu * Math.pow(ratio, coef);
      }
    }
  }
}

/**
 * Compute change between two vectors (L2 norm of difference)
 */
function computeChange(mu: number[], prevMu: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < mu.length; i++) {
    const muVal = mu[i];
    const prevMuVal = prevMu[i];
    if (muVal !== undefined && prevMuVal !== undefined) {
      const diff = muVal - prevMuVal;
      sumSq += diff * diff;
    }
  }
  return Math.sqrt(sumSq);
}

/**
 * Compute Bregman projection using iterative proportional fitting
 *
 * This solves: min_{μ ∈ M} D_KL(μ || θ)
 * where M is the marginal polytope and θ is the price vector
 *
 * Optimizations:
 * - Preprocesses constraints to sparse structure (only non-zero coefficients)
 * - Uses in-place operations to reduce memory allocation
 * - Avoids creating new arrays in the inner loop
 */
export function bregmanProjection(
  priceVector: number[],
  constraints: Constraint[],
  maxIterations: number = ALGORITHM_CONFIG.MAX_ITERATIONS,
  tolerance: number = ALGORITHM_CONFIG.CONVERGENCE_THRESHOLD
): BregmanProjectionResult {
  const logger = getLogger().child({ module: 'BregmanProjection' });

  const n = priceVector.length;

  // Ensure price vector is positive (reference measure θ for I-projection).
  const theta: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const price = priceVector[i];
    theta[i] = Math.max(price ?? 0, 1e-10);
  }

  // Initialize μ from θ so IPF converges to the I-projection argmin D(μ‖θ),
  // not the maximum-entropy point of a uniform start (CORE-1).
  const mu: number[] = theta.slice();

  // Preprocess constraints to sparse structure
  const sparseConstraints = preprocessConstraints(constraints, n);

  // Reuse buffer for previous mu
  const prevMu: number[] = new Array<number>(n);

  logger.debug('Starting Bregman projection', {
    dimension: n,
    constraintCount: constraints.length,
    sparseConstraintCount: sparseConstraints.length,
    maxIterations,
    tolerance,
  });

  for (let iter = 0; iter < maxIterations; iter++) {
    // Save current mu
    for (let i = 0; i < n; i++) {
      const muVal = mu[i];
      prevMu[i] = muVal ?? 0;
    }

    // Iterate through sparse constraints only
    for (const constraint of sparseConstraints) {
      // For equality constraints: sum(c_i * mu_i) = rhs
      const current = sparseDot(constraint, mu);
      const ratio = constraint.rhs / Math.max(current, 1e-10);

      // Multiplicative update (in-place)
      applyConstraintUpdate(mu, constraint, ratio);
    }

    // Check convergence
    const change = computeChange(mu, prevMu);
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
  const result: number[] = new Array<number>(mu.length);

  for (let i = 0; i < mu.length; i++) {
    const muVal = mu[i];
    const thetaVal = theta[i];
    const m = Math.max(muVal ?? 0, epsilon);
    const t = Math.max(thetaVal ?? 0, epsilon);
    result[i] = Math.log(m / t) + 1;
  }

  return result;
}

/**
 * Compute the Bregman divergence (KL divergence) between two points
 */
export function bregmanDivergence(mu: number[], theta: number[]): number {
  return klDivergence(mu, theta);
}

/**
 * Divergence minus one-sided constraint violation (diagnostic only).
 *
 * Not a true Lagrangian dual. Equality violations use |c·μ − rhs|; inequality
 * violations (coefficients · μ ≥ rhs) use max(0, rhs − c·μ) so feasible
 * inequalities contribute zero (CORE-7).
 */
export function divergenceMinusConstraintViolation(
  mu: number[],
  theta: number[],
  constraints: Constraint[]
): number {
  const divergence = klDivergence(mu, theta);

  let penalty = 0;
  for (const constraint of constraints) {
    const value = vectorDot(constraint.coefficients, mu);
    if (constraint.type === 'equality') {
      penalty += Math.abs(value - constraint.rhs);
    } else {
      penalty += Math.max(0, constraint.rhs - value);
    }
  }

  return divergence - penalty;
}

/**
 * @deprecated Prefer divergenceMinusConstraintViolation — this is not a dual.
 */
export function dualFunctionValue(
  mu: number[],
  theta: number[],
  constraints: Constraint[]
): number {
  return divergenceMinusConstraintViolation(mu, theta, constraints);
}

/**
 * Check whether the KL incoherence lower bound exceeds a nats threshold.
 *
 * `divergence` and `gap` are dimensionless (nats), not dollar profit (CORE-9).
 */
export function isProfitable(divergence: number, gap: number, minProfit?: number): boolean {
  const threshold = minProfit ?? ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD;
  const incoherenceLowerBound = divergence - gap;
  return incoherenceLowerBound >= threshold;
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
export function computeTradeDirection(projection: number[], prices: number[]): number[] {
  // Trade direction: buy when projection > price, sell when projection < price
  const result: number[] = new Array<number>(projection.length);
  for (let i = 0; i < projection.length; i++) {
    const price = prices[i];
    const projVal = projection[i];
    result[i] = price !== undefined && projVal !== undefined ? projVal - price : (projVal ?? 0);
  }
  return result;
}
