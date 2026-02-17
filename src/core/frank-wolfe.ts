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

import { vectorSubtract, vectorDot, vectorScale, vectorAdd, projectOntoSimplex } from '../utils/math.js';
import { getLogger } from '../utils/logger.js';
import { ALGORITHM_CONFIG } from '../utils/config.js';
import type { FrankWolfeResult, FrankWolfeOptions, Constraint } from './frank-wolfe-types.js';
import { lineSearchKL, adaptiveStepSize } from './line-search.js';

export type { FrankWolfeResult, FrankWolfeOptions, Constraint };
export { linearMinimizationOracle } from './lmo.js';
export { lineSearchKL, adaptiveStepSize } from './line-search.js';
export { isProfitableArbitrage, computeTradeRecommendation } from './arbitrage-utils.js';

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
      logger.debug(`Iteration ${String(iter)}`, { objective, gap });
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
      gamma = adaptiveStepSize(iter);
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
      logger.debug(`Shrinking epsilon to ${String(epsilon)}`, { iteration: iter });
    }

    if (verbose && iter % 10 === 0) {
      logger.debug(`Iteration ${String(iter)}`, { objective, gap, epsilon });
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
    const gamma = adaptiveStepSize(iter);

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
