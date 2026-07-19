/**
 * InitFW - Initialization algorithm for Frank-Wolfe
 *
 * Provides good initial points for Frank-Wolfe optimization by:
 * 1. Using warm-start from previous solutions
 * 2. Applying vertex selection heuristics
 * 3. Running a few iterations of conditional gradient
 *
 * A good initialization can significantly reduce the number of Frank-Wolfe iterations
 * needed for convergence.
 */

import { vectorScale, vectorAdd, zeros, ones, projectOntoSimplex } from '../utils/math.js';
import { getLogger } from '../utils/logger.js';

export interface InitFWOptions {
  /** Use warm-start if available */
  warmStart?: number[] | null;
  /** Number of initialization iterations */
  initIterations?: number;
  /**
   * Optional product-of-simplex group sizes. When set, warm-start validation
   * requires each group to sum to 1 (multi-event polytopes, CORE-11).
   */
  groupSizes?: number[];
}

export interface InitFWResult {
  /** Initial point for Frank-Wolfe */
  initialPoint: number[];
  /** Estimated quality of initialization (lower is better) */
  quality: number;
  /** Method used for initialization */
  method: 'warm-start' | 'uniform' | 'vertex' | 'gradient';
}

/**
 * Initialize Frank-Wolfe with a good starting point
 *
 * @param dimension Dimension of the problem (number of markets)
 * @param gradientFn Function to compute gradient at a point
 * @param objectiveFn Function to compute objective value
 * @param options Initialization options
 * @returns Initialization result
 */
export function initFW(
  dimension: number,
  gradientFn: (mu: number[]) => number[],
  objectiveFn: (mu: number[]) => number,
  options: InitFWOptions = {}
): InitFWResult {
  const logger = getLogger().child({ module: 'InitFW' });
  const { warmStart = null, initIterations = 5, groupSizes } = options;

  // Try warm-start first if available
  if (warmStart !== null && warmStart.length === dimension) {
    const isValid = validatePoint(warmStart, groupSizes);
    if (isValid) {
      logger.debug('Using warm-start initialization');
      return {
        initialPoint: warmStart,
        quality: objectiveFn(warmStart),
        method: 'warm-start',
      };
    }
  }

  // Try gradient-based vertex selection
  const vertexInit = vertexInitialization(dimension, gradientFn);
  const vertexQuality = objectiveFn(vertexInit);

  // Try uniform initialization
  const uniformInit = vectorScale(ones(dimension), 1 / dimension);
  const uniformQuality = objectiveFn(uniformInit);

  // Run a few iterations of conditional gradient from uniform
  const gradientInit = conditionalGradientInit(dimension, gradientFn, objectiveFn, initIterations);
  const gradientQuality = objectiveFn(gradientInit);

  // Select the best initialization
  let bestPoint = uniformInit;
  let bestQuality = uniformQuality;
  let bestMethod: InitFWResult['method'] = 'uniform';

  if (vertexQuality < bestQuality) {
    bestPoint = vertexInit;
    bestQuality = vertexQuality;
    bestMethod = 'vertex';
  }

  if (gradientQuality < bestQuality) {
    bestPoint = gradientInit;
    bestQuality = gradientQuality;
    bestMethod = 'gradient';
  }

  logger.debug('InitFW completed', {
    method: bestMethod,
    quality: bestQuality,
    dimension,
  });

  return {
    initialPoint: bestPoint,
    quality: bestQuality,
    method: bestMethod,
  };
}

/**
 * Vertex initialization: select the vertex with minimum gradient
 */
function vertexInitialization(dimension: number, gradientFn: (mu: number[]) => number[]): number[] {
  // Start from uniform to get a representative gradient
  const uniform = vectorScale(ones(dimension), 1 / dimension);
  const gradient = gradientFn(uniform);

  // Find the coordinate with minimum gradient
  let minIdx = 0;
  let minGrad = gradient[0] ?? 0;

  for (let i = 1; i < dimension; i++) {
    const currentGrad = gradient[i] ?? 0;
    if (currentGrad < minGrad) {
      minGrad = currentGrad;
      minIdx = i;
    }
  }

  // Create vertex with 1 at minIdx
  const vertex = zeros(dimension);
  vertex[minIdx] = 1;

  return vertex;
}

/**
 * Run a few iterations of conditional gradient for initialization
 */
function conditionalGradientInit(
  dimension: number,
  gradientFn: (mu: number[]) => number[],
  _objectiveFn: (mu: number[]) => number,
  iterations: number
): number[] {
  let mu = vectorScale(ones(dimension), 1 / dimension);

  for (let iter = 0; iter < iterations; iter++) {
    const gradient = gradientFn(mu);

    // Find vertex minimizing <gradient, v>
    let minIdx = 0;
    let minValue = gradient[0] ?? 0;

    for (let i = 1; i < dimension; i++) {
      const currentValue = gradient[i] ?? 0;
      if (currentValue < minValue) {
        minValue = currentValue;
        minIdx = i;
      }
    }

    // Create vertex
    const s = zeros(dimension);
    s[minIdx] = 1;

    // Step size (decreasing)
    const gamma = 2 / (iter + 2);

    // Update: mu = (1 - gamma) * mu + gamma * s
    mu = vectorAdd(vectorScale(mu, 1 - gamma), vectorScale(s, gamma));

    // Project onto simplex to maintain feasibility
    mu = projectOntoSimplex(mu);
  }

  return mu;
}

/**
 * Validate a warm-start point.
 * Default: single simplex (non-negative, sum ≈ 1).
 * With groupSizes: product of simplices (each group sums to 1, CORE-11).
 */
function validatePoint(point: number[], groupSizes?: number[]): boolean {
  if (point.some((x) => x < -1e-10)) {
    return false;
  }

  if (groupSizes && groupSizes.length > 0) {
    let offset = 0;
    for (const size of groupSizes) {
      if (!Number.isInteger(size) || size <= 0) return false;
      let groupSum = 0;
      for (let i = 0; i < size; i++) {
        groupSum += point[offset + i] ?? 0;
      }
      if (Math.abs(groupSum - 1) > 1e-6) return false;
      offset += size;
    }
    return offset === point.length;
  }

  const sum = point.reduce((s, x) => s + x, 0);
  return Math.abs(sum - 1) <= 1e-6;
}

/**
 * Cache for warm-start values
 */
const warmStartCache = new Map<string, number[]>();

/**
 * Store a warm-start value for future use
 */
export function storeWarmStart(key: string, point: number[]): void {
  warmStartCache.set(key, [...point]);
}

/**
 * Retrieve a warm-start value
 */
export function getWarmStart(key: string): number[] | undefined {
  return warmStartCache.get(key);
}

/**
 * Clear the warm-start cache
 */
export function clearWarmStartCache(): void {
  warmStartCache.clear();
}

// Barrier method constants
const BARRIER_DEFAULT_ITERATIONS = 5;
const BARRIER_GAMMA_NUMERATOR = 2;
const BARRIER_RANDOM_PERTURBATION_SCALE = 0.5;

/**
 * Create initial barrier point with perturbation
 * For barrier methods, start slightly away from boundary
 */
function createBarrierInitialPoint(dimension: number, epsilon: number): number[] {
  const barrierUniform = vectorScale(ones(dimension), 1 / dimension);

  // Add small perturbation to avoid exact boundary
  for (let i = 0; i < dimension; i++) {
    const randomOffset = epsilon * (Math.random() - BARRIER_RANDOM_PERTURBATION_SCALE);
    barrierUniform[i] = (barrierUniform[i] ?? 0) + randomOffset;
  }

  // Renormalize
  const sum = barrierUniform.reduce((s, x) => s + x, 0);
  return barrierUniform.map((x) => x / sum);
}

/**
 * Find the vertex that minimizes the gradient
 */
function findMinGradientVertex(gradient: number[], dimension: number): number[] {
  let minIdx = 0;
  let minValue = gradient[0] ?? 0;

  for (let i = 1; i < dimension; i++) {
    const currentValue = gradient[i] ?? 0;
    if (currentValue < minValue) {
      minValue = currentValue;
      minIdx = i;
    }
  }

  const s = zeros(dimension);
  s[minIdx] = 1;
  return s;
}

/**
 * Run conditional gradient iterations with barrier
 */
function runBarrierConditionalGradient(
  initialMu: number[],
  dimension: number,
  gradientFn: (mu: number[], epsilon: number) => number[],
  iterations: number,
  epsilon: number
): number[] {
  let mu = [...initialMu];

  for (let iter = 0; iter < iterations; iter++) {
    const gradient = gradientFn(mu, epsilon);
    const s = findMinGradientVertex(gradient, dimension);

    const gamma = BARRIER_GAMMA_NUMERATOR / (iter + 2);
    mu = vectorAdd(vectorScale(mu, 1 - gamma), vectorScale(s, gamma));
    mu = projectOntoSimplex(mu);
  }

  return mu;
}

/**
 * Initialize with barrier-aware strategy
 * For LMSR markets, use a point away from the boundary
 */
export function initFWBarrier(
  dimension: number,
  gradientFn: (mu: number[], epsilon: number) => number[],
  objectiveFn: (mu: number[], epsilon: number) => number,
  epsilon: number,
  options: InitFWOptions = {}
): InitFWResult {
  const logger = getLogger().child({ module: 'InitFWBarrier' });

  const normalized = createBarrierInitialPoint(dimension, epsilon);
  const iterations = options.initIterations ?? BARRIER_DEFAULT_ITERATIONS;

  const mu = runBarrierConditionalGradient(normalized, dimension, gradientFn, iterations, epsilon);

  const quality = objectiveFn(mu, epsilon);

  logger.debug('InitFW Barrier completed', {
    dimension,
    epsilon,
    quality,
  });

  return {
    initialPoint: mu,
    quality,
    method: 'gradient',
  };
}
