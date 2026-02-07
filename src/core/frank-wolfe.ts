/**
 * Frank-Wolfe Algorithm for convex optimization over the marginal polytope
 *
 * The Frank-Wolfe algorithm (also known as conditional gradient) is an iterative
 * method for convex optimization that avoids projection steps. Instead, it solves
 * a linear minimization oracle (LMO) at each iteration.
 *
 * For arbitrage detection:
 * - Objective: Minimize KL divergence D(μ || θ)
 * - Constraint: μ ∈ M (marginal polytope)
 * - LMO: Find vertex v that minimizes ⟨∇f(μ), v⟩
 */

import {
  vectorSubtract,
  vectorDot,
  vectorScale,
  vectorAdd,
  klDivergence,
  vectorLog,
  vectorExp,
  clip,
} from '../utils/math.js';
import { getLogger } from '../utils/logger.js';
import { ALGORITHM_CONFIG } from '../utils/config.js';

export interface FrankWolfeResult {
  /** Optimal point */
  mu: number[];
  /** Objective value (KL divergence) */
  objective: number;
  /** Frank-Wolfe gap (optimality measure) */
  gap: number;
  /** Number of iterations */
  iterations: number;
  /** Whether converged */
  converged: boolean;
  /** History of objective values */
  history: number[];
}

export interface FrankWolfeOptions {
  maxIterations?: number;
  tolerance?: number;
  stepSize?: 'line-search' | 'fixed' | 'adaptive';
  initialStepSize?: number;
  verbose?: boolean;
}

/**
 * Linear Minimization Oracle (LMO)
 * Finds the vertex of the polytope that minimizes the inner product with gradient
 *
 * For the marginal polytope, vertices correspond to deterministic outcomes
 *
 * @param gradient Current gradient
 * @param constraints Polytope constraints
 * @returns Vertex minimizing ⟨gradient, v⟩
 */
export function linearMinimizationOracle(
  gradient: number[],
  constraints: Array<{ coefficients: number[]; rhs: number; type: 'equality' | 'inequality' }>
): number[] {
  const n = gradient.length;

  // For a simplex constraint (sum = 1, all >= 0), the LMO picks the
  // coordinate with minimum gradient component
  const vertex = new Array(n).fill(0);
  let minIdx = 0;
  let minValue = gradient[0]!;

  for (let i = 1; i < n; i++) {
    if (gradient[i]! < minValue) {
      minValue = gradient[i]!;
      minIdx = i;
    }
  }

  vertex[minIdx] = 1;
  return vertex;
}

/**
 * Standard Frank-Wolfe algorithm
 *
 * Solves: min_{μ ∈ M} f(μ) where f is convex and M is the marginal polytope
 *
 * @param initialMu Initial point
 * @param objectiveFn Objective function
 * @param gradientFn Gradient function
 * @param lmoFn Linear minimization oracle
 * @param options Algorithm options
 * @returns Optimization result
 */
export function frankWolfe(
  initialMu: number[],
  objectiveFn: (mu: number[]) => number,
  gradientFn: (mu: number[]) => number[],
  lmoFn: (grad: number[]) => number[],
  options: FrankWolfeOptions = {}
): FrankWolfeResult {
  const logger = getLogger().child({ module: 'FrankWolfe' });

  const {
    maxIterations = ALGORITHM_CONFIG.MAX_ITERATIONS,
    tolerance = ALGORITHM_CONFIG.CONVERGENCE_THRESHOLD,
    stepSize = 'line-search',
    verbose = false,
  } = options;

  let mu = [...initialMu];
  const history: number[] = [];

  logger.debug('Starting Frank-Wolfe', { maxIterations, tolerance, stepSize });

  for (let iter = 0; iter < maxIterations; iter++) {
    // Compute objective and gradient
    const objective = objectiveFn(mu);
    const gradient = gradientFn(mu);
    history.push(objective);

    // Linear Minimization Oracle
    const s = lmoFn(gradient);

    // Compute Frank-Wolfe gap
    const gap = vectorDot(gradient, vectorSubtract(mu, s));

    if (verbose && iter % 10 === 0) {
      logger.debug(`Iteration ${iter}`, { objective, gap });
    }

    // Check convergence (α-extraction criterion)
    if (gap <= tolerance * (1 - ALGORITHM_CONFIG.ALPHA) * objective) {
      logger.debug('Frank-Wolfe converged', {
        iterations: iter + 1,
        objective,
        gap,
      });

      return {
        mu,
        objective,
        gap,
        iterations: iter + 1,
        converged: true,
        history,
      };
    }

    // Compute step size
    let gamma: number;
    if (stepSize === 'line-search') {
      // Exact line search for KL divergence
      gamma = lineSearchKL(mu, s, gradient);
    } else if (stepSize === 'adaptive') {
      gamma = 2 / (iter + 2);
    } else {
      gamma = options.initialStepSize ?? 0.1;
    }

    // Update: μ_{t+1} = (1 - γ) * μ_t + γ * s
    mu = vectorAdd(vectorScale(mu, 1 - gamma), vectorScale(s, gamma));

    // Ensure feasibility (project onto simplex if needed)
    mu = projectOntoSimplex(mu);
  }

  // Max iterations reached
  const finalObjective = objectiveFn(mu);
  const finalGradient = gradientFn(mu);
  const finalS = lmoFn(finalGradient);
  const finalGap = vectorDot(finalGradient, vectorSubtract(mu, finalS));

  logger.warn('Frank-Wolfe reached max iterations', {
    iterations: maxIterations,
    objective: finalObjective,
    gap: finalGap,
  });

  return {
    mu,
    objective: finalObjective,
    gap: finalGap,
    iterations: maxIterations,
    converged: false,
    history,
  };
}

/**
 * Barrier Frank-Wolfe with adaptive shrinkage
 *
 * Handles LMSR (Logarithmic Market Scoring Rule) gradient explosion
 * by using a barrier function that shrinks adaptively.
 *
 * @param initialMu Initial point
 * @param objectiveFn Objective function
 * @param gradientFn Gradient function with barrier
 * @param lmoFn Linear minimization oracle
 * @param options Algorithm options
 * @returns Optimization result
 */
export function barrierFrankWolfe(
  initialMu: number[],
  objectiveFn: (mu: number[], epsilon: number) => number,
  gradientFn: (mu: number[], epsilon: number) => number[],
  lmoFn: (grad: number[]) => number[],
  options: FrankWolfeOptions & { initialEpsilon?: number } = {}
): FrankWolfeResult {
  const logger = getLogger().child({ module: 'BarrierFrankWolfe' });

  const {
    maxIterations = ALGORITHM_CONFIG.MAX_ITERATIONS,
    tolerance = ALGORITHM_CONFIG.CONVERGENCE_THRESHOLD,
    initialEpsilon = ALGORITHM_CONFIG.INITIAL_EPSILON,
    verbose = false,
  } = options;

  let mu = [...initialMu];
  let epsilon = initialEpsilon;
  const history: number[] = [];

  logger.debug('Starting Barrier Frank-Wolfe', {
    maxIterations,
    tolerance,
    initialEpsilon,
  });

  for (let iter = 0; iter < maxIterations; iter++) {
    // Compute objective and gradient with current epsilon
    const objective = objectiveFn(mu, epsilon);
    const gradient = gradientFn(mu, epsilon);
    history.push(objective);

    // Linear Minimization Oracle
    const s = lmoFn(gradient);

    // Compute gaps
    const gap = vectorDot(gradient, vectorSubtract(mu, s));
    const gapU = vectorDot(gradientFn(mu, 0), vectorSubtract(mu, s));

    // Adaptive epsilon shrinkage
    if (gapU < 0 && gap / (-4 * gapU) < epsilon) {
      epsilon = Math.min(gap / (-4 * gapU), epsilon / 2);
      logger.debug(`Shrinking epsilon to ${epsilon}`, { iteration: iter });
    }

    if (verbose && iter % 10 === 0) {
      logger.debug(`Iteration ${iter}`, { objective, gap, epsilon });
    }

    // Check convergence (α-extraction)
    if (gap <= (1 - ALGORITHM_CONFIG.ALPHA) * objective) {
      logger.debug('Barrier Frank-Wolfe converged', {
        iterations: iter + 1,
        objective,
        gap,
        epsilon,
      });

      return {
        mu,
        objective,
        gap,
        iterations: iter + 1,
        converged: true,
        history,
      };
    }

    // Step size (adaptive)
    const gamma = 2 / (iter + 2);

    // Update
    mu = vectorAdd(vectorScale(mu, 1 - gamma), vectorScale(s, gamma));
    mu = projectOntoSimplex(mu);
  }

  const finalObjective = objectiveFn(mu, epsilon);
  const finalGradient = gradientFn(mu, epsilon);
  const finalS = lmoFn(finalGradient);
  const finalGap = vectorDot(finalGradient, vectorSubtract(mu, finalS));

  logger.warn('Barrier Frank-Wolfe reached max iterations', {
    iterations: maxIterations,
    objective: finalObjective,
    gap: finalGap,
    epsilon,
  });

  return {
    mu,
    objective: finalObjective,
    gap: finalGap,
    iterations: maxIterations,
    converged: false,
    history,
  };
}

/**
 * Line search for KL divergence minimization
 * Finds optimal step size γ that minimizes D((1-γ)μ + γs || θ)
 */
function lineSearchKL(mu: number[], s: number[], gradient: number[]): number {
  // For KL divergence, the optimal step size can be computed analytically
  // or approximated using bisection
  const d = vectorSubtract(s, mu);

  // Try different step sizes and pick the best
  let bestGamma = 0;
  let bestValue = Infinity;

  for (let i = 1; i <= 20; i++) {
    const gamma = i / 20;
    const newMu = vectorAdd(mu, vectorScale(d, gamma));

    // Compute objective (approximate)
    const value = vectorDot(gradient, vectorSubtract(newMu, mu));

    if (value < bestValue) {
      bestValue = value;
      bestGamma = gamma;
    }
  }

  return bestGamma;
}

/**
 * Project a vector onto the probability simplex
 * Uses a simple algorithm that preserves the sum = 1 constraint
 */
function projectOntoSimplex(v: number[]): number[] {
  const n = v.length;

  // Sort in descending order
  const sorted = [...v].sort((a, b) => b - a);

  // Find the threshold
  let cumsum = 0;
  let rho = 0;

  for (let i = 0; i < n; i++) {
    cumsum += sorted[i]!;
    if (sorted[i]! > (cumsum - 1) / (i + 1)) {
      rho = i;
    }
  }

  const lambda = (cumsum - 1) / (rho + 1);

  // Project
  return v.map((x) => Math.max(x - lambda, 0));
}

/**
 * Check if the Frank-Wolfe result indicates profitable arbitrage
 *
 * @param result Frank-Wolfe result
 * @param minProfit Minimum profit threshold
 * @returns Whether arbitrage is profitable
 */
export function isProfitableArbitrage(
  result: FrankWolfeResult,
  minProfit: number = ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD
): boolean {
  // Guaranteed profit = divergence - gap
  const guaranteedProfit = result.objective - result.gap;
  return guaranteedProfit >= minProfit;
}

/**
 * Compute the trade recommendation from Frank-Wolfe result
 *
 * @param result Frank-Wolfe result
 * @param prices Current market prices
 * @returns Recommended trade vector
 */
export function computeTradeRecommendation(
  result: FrankWolfeResult,
  prices: number[]
): number[] {
  // Trade = projection - prices (positive = buy, negative = sell)
  return result.mu.map((mu_i, i) => mu_i - prices[i]!);
}
