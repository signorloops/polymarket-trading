/**
 * Frank-Wolfe Algorithm Type Definitions
 *
 * Centralized type definitions for Frank-Wolfe optimization.
 */

/**
 * Result of Frank-Wolfe optimization
 */
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

/**
 * Options for Frank-Wolfe algorithm
 */
export interface FrankWolfeOptions {
  maxIterations?: number;
  tolerance?: number;
  stepSize?: 'line-search' | 'fixed' | 'adaptive';
  initialStepSize?: number;
  verbose?: boolean;
}

/**
 * Constraint definition for the marginal polytope
 */
export interface Constraint {
  coefficients: number[];
  rhs: number;
  type: 'equality' | 'inequality';
}
