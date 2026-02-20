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

import { getLogger } from '../utils/logger.js';
import { ALGORITHM_CONFIG } from '../utils/config.js';
import type { FrankWolfeResult, FrankWolfeOptions } from './frank-wolfe-types.js';
import { lineSearchObjective, adaptiveStepSize } from './line-search.js';

export type { FrankWolfeResult, FrankWolfeOptions };
export type { Constraint } from './frank-wolfe-types.js';
export { linearMinimizationOracle } from './lmo.js';
export { lineSearchKL, lineSearchObjective, adaptiveStepSize } from './line-search.js';
export { isProfitableArbitrage, computeTradeRecommendation } from './arbitrage-utils.js';

/**
 * Object pool for reusing Float64Array buffers
 * Reduces GC pressure in tight loops
 */
export class Float64ArrayPool {
  private pool: Float64Array[] = [];
  private size: number;
  private maxPoolSize: number;

  constructor(size: number, maxPoolSize = 10) {
    this.size = size;
    this.maxPoolSize = maxPoolSize;
  }

  acquire(): Float64Array {
    const arr = this.pool.pop();
    if (arr !== undefined) {
      arr.fill(0);
      return arr;
    }
    return new Float64Array(this.size);
  }

  release(arr: Float64Array): void {
    if (this.pool.length < this.maxPoolSize) {
      this.pool.push(arr);
    }
  }

  releaseMultiple(arrays: Float64Array[]): void {
    for (const arr of arrays) {
      this.release(arr);
    }
  }
}

/**
 * In-place vector operations to reduce memory allocation
 */
export function copyTo(target: Float64Array, source: number[] | Float64Array): void {
  for (let i = 0; i < source.length; i++) {
    target[i] = source[i] ?? 0;
  }
}

export function addScaledInPlace(
  result: Float64Array,
  a: Float64Array,
  b: Float64Array,
  scaleA: number,
  scaleB: number
): void {
  for (let i = 0; i < result.length; i++) {
    result[i] = (a[i] ?? 0) * scaleA + (b[i] ?? 0) * scaleB;
  }
}

export function subtractInPlace(result: Float64Array, a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < result.length; i++) {
    result[i] = (a[i] ?? 0) - (b[i] ?? 0);
  }
}

export function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/**
 * Standard Frank-Wolfe algorithm with memory optimization
 *
 * Uses Float64Array and object pooling to reduce GC pressure
 */
export function frankWolfe(
  initialMu: number[],
  objectiveFn: (mu: number[] | Float64Array) => number,
  gradientFn: (mu: number[] | Float64Array) => number[],
  lmoFn: (grad: number[] | Float64Array) => number[],
  options: FrankWolfeOptions = {}
): FrankWolfeResult {
  const logger = getLogger().child({ module: 'FrankWolfe' });

  const {
    maxIterations = ALGORITHM_CONFIG.MAX_ITERATIONS,
    tolerance = ALGORITHM_CONFIG.CONVERGENCE_THRESHOLD,
    stepSize = 'line-search',
    verbose = false,
  } = options;

  const n = initialMu.length;
  const pool = new Float64ArrayPool(n, 5);

  // Allocate working arrays
  let mu: Float64Array = new Float64Array(initialMu);
  const history: number[] = [];

  // Reusable buffers
  const s = pool.acquire();
  const gradient = pool.acquire();
  const tempDiff = pool.acquire();
  let tempMu = pool.acquire();

  logger.debug('Starting Frank-Wolfe', { maxIterations, tolerance, stepSize });

  try {
    for (let iter = 0; iter < maxIterations; iter++) {
      // Compute objective and gradient
      const objective = objectiveFn(mu);
      const gradArray = gradientFn(mu);
      copyTo(gradient, gradArray);
      history.push(objective);

      // Linear Minimization Oracle
      const sArray = lmoFn(gradient);
      copyTo(s, sArray);

      // Compute Frank-Wolfe gap
      subtractInPlace(tempDiff, mu, s);
      const gap = dot(gradient, tempDiff);

      if (verbose && iter % 10 === 0) {
        logger.debug('Iteration ' + String(iter), { objective, gap });
      }

      // Check convergence
      const objectiveScale = Math.max(1, Math.abs(objective));
      if (gap <= tolerance * (1 - ALGORITHM_CONFIG.ALPHA) * objectiveScale) {
        logger.debug('Frank-Wolfe converged', {
          iterations: iter + 1,
          objective,
          gap,
        });

        return {
          mu: Array.from(mu),
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
        const muArray = Array.from(mu);
        const sArrayForSearch = Array.from(s);
        gamma = lineSearchObjective(
          muArray,
          sArrayForSearch,
          (candidate) => objectiveFn(candidate)
        );
      } else if (stepSize === 'adaptive') {
        gamma = adaptiveStepSize(iter);
      } else {
        gamma = options.initialStepSize ?? 0.1;
      }
      gamma = Math.max(0, Math.min(1, Number.isFinite(gamma) ? gamma : 0));

      // Update
      addScaledInPlace(tempMu, mu, s, 1 - gamma, gamma);
      [mu, tempMu] = [tempMu, mu];
    }

    // Max iterations reached
    const finalObjective = objectiveFn(mu);
    const finalGradient = gradientFn(mu);
    const finalS = lmoFn(finalGradient);

    copyTo(gradient, finalGradient);
    copyTo(s, finalS);
    subtractInPlace(tempDiff, mu, s);
    const finalGap = dot(gradient, tempDiff);

    logger.warn('Frank-Wolfe reached max iterations', {
      iterations: maxIterations,
      objective: finalObjective,
      gap: finalGap,
    });

    return {
      mu: Array.from(mu),
      objective: finalObjective,
      gap: finalGap,
      iterations: maxIterations,
      converged: false,
      history,
    };
  } finally {
    pool.releaseMultiple([s, gradient, tempDiff, tempMu]);
  }
}

/**
 * Barrier Frank-Wolfe with adaptive shrinkage and memory optimization
 */
export function barrierFrankWolfe(
  initialMu: number[],
  objectiveFn: (mu: number[] | Float64Array, epsilon: number) => number,
  gradientFn: (mu: number[] | Float64Array, epsilon: number) => number[],
  lmoFn: (grad: number[] | Float64Array) => number[],
  options: FrankWolfeOptions & { initialEpsilon?: number } = {}
): FrankWolfeResult {
  const logger = getLogger().child({ module: 'BarrierFrankWolfe' });

  const {
    maxIterations = ALGORITHM_CONFIG.MAX_ITERATIONS,
    tolerance = ALGORITHM_CONFIG.CONVERGENCE_THRESHOLD,
    initialEpsilon = ALGORITHM_CONFIG.INITIAL_EPSILON,
    verbose = false,
  } = options;

  const n = initialMu.length;
  const pool = new Float64ArrayPool(n, 5);

  let mu: Float64Array = new Float64Array(initialMu);
  let epsilon = initialEpsilon;
  const history: number[] = [];

  const s = pool.acquire();
  const gradient = pool.acquire();
  const gradientNoBarrier = pool.acquire();
  const tempDiff = pool.acquire();
  let tempMu = pool.acquire();

  logger.debug('Starting Barrier Frank-Wolfe', {
    maxIterations,
    tolerance,
    initialEpsilon,
  });

  try {
    for (let iter = 0; iter < maxIterations; iter++) {
      const objective = objectiveFn(mu, epsilon);
      const gradArray = gradientFn(mu, epsilon);
      copyTo(gradient, gradArray);
      history.push(objective);

      const sArray = lmoFn(gradient);
      copyTo(s, sArray);

      subtractInPlace(tempDiff, mu, s);
      const gap = dot(gradient, tempDiff);

      const gradNoBarrierArray = gradientFn(mu, 0);
      copyTo(gradientNoBarrier, gradNoBarrierArray);
      const gapU = dot(gradientNoBarrier, tempDiff);

      if (gapU < 0 && gap / (-4 * gapU) < epsilon) {
        epsilon = Math.min(gap / (-4 * gapU), epsilon / 2);
        logger.debug('Shrinking epsilon to ' + String(epsilon), { iteration: iter });
      }

      if (verbose && iter % 10 === 0) {
        logger.debug('Iteration ' + String(iter), { objective, gap, epsilon });
      }

      const objectiveScale = Math.max(1, Math.abs(objective));
      if (gap <= tolerance * (1 - ALGORITHM_CONFIG.ALPHA) * objectiveScale) {
        logger.debug('Barrier Frank-Wolfe converged', {
          iterations: iter + 1,
          objective,
          gap,
          epsilon,
        });

        return {
          mu: Array.from(mu),
          objective,
          gap,
          iterations: iter + 1,
          converged: true,
          history,
        };
      }

      const gamma = Math.max(0, Math.min(1, adaptiveStepSize(iter)));
      addScaledInPlace(tempMu, mu, s, 1 - gamma, gamma);
      [mu, tempMu] = [tempMu, mu];
    }

    const finalObjective = objectiveFn(mu, epsilon);
    const finalGradient = gradientFn(mu, epsilon);
    const finalS = lmoFn(finalGradient);

    copyTo(gradient, finalGradient);
    copyTo(s, finalS);
    subtractInPlace(tempDiff, mu, s);
    const finalGap = dot(gradient, tempDiff);

    logger.warn('Barrier Frank-Wolfe reached max iterations', {
      iterations: maxIterations,
      objective: finalObjective,
      gap: finalGap,
      epsilon,
    });

    return {
      mu: Array.from(mu),
      objective: finalObjective,
      gap: finalGap,
      iterations: maxIterations,
      converged: false,
      history,
    };
  } finally {
    pool.releaseMultiple([s, gradient, gradientNoBarrier, tempDiff, tempMu]);
  }
}
