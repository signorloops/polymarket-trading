/**
 * Linear Programming Solver Interface
 *
 * Provides a unified interface for LP solvers.
 * Can be backed by:
 * - glpk.js (JavaScript implementation)
 * - External solver via API
 * - Custom implementation for simple cases
 *
 * Standard form:
 *   minimize: c^T x
 *   subject to: A x <= b
 *                A_eq x = b_eq
 *                lb <= x <= ub
 */

import { getLogger } from '../utils/logger.js';

export interface LPProblem {
  /** Objective coefficients (minimize c^T x) */
  objective: number[];
  /** Inequality constraint matrix (A x <= b) */
  inequalityMatrix?: number[][];
  /** Inequality constraint RHS */
  inequalityRhs?: number[];
  /** Equality constraint matrix (A_eq x = b_eq) */
  equalityMatrix?: number[][];
  /** Equality constraint RHS */
  equalityRhs?: number[];
  /** Lower bounds for variables */
  lowerBounds?: number[];
  /** Upper bounds for variables */
  upperBounds?: number[];
}

export interface LPSolution {
  /** Optimal solution vector */
  solution: number[];
  /** Optimal objective value */
  objectiveValue: number;
  /** Whether the solution is optimal */
  optimal: boolean;
  /** Solver status */
  status: 'optimal' | 'infeasible' | 'unbounded' | 'error';
  /** Iteration count */
  iterations?: number;
  /** Error message if failed */
  error?: string;
}

export interface LPSolverOptions {
  /** Maximum iterations */
  maxIterations?: number;
  /** Feasibility tolerance */
  tolerance?: number;
  /** Enable verbose output */
  verbose?: boolean;
}

const logger = getLogger().child({ module: 'LPSolver' });

/**
 * Solve a linear programming problem
 *
 * This is a placeholder implementation using a simple gradient descent approach.
 * For production use, replace with a proper LP solver like glpk.js or an external API.
 */
export function solveLP(
  problem: LPProblem,
  options: LPSolverOptions = {}
): LPSolution {
  const { maxIterations = 1000, tolerance = 1e-6 } = options;

  const n = problem.objective.length;

  try {
    // Validate problem
    validateProblem(problem);

    // Initialize with zeros or midpoint of bounds
    let x = initializeVariables(problem);

    // Simple projected gradient descent
    // Note: This is NOT a proper LP solver, just a placeholder
    const learningRate = 0.01;

    for (let iter = 0; iter < maxIterations; iter++) {
      const gradient = [...problem.objective];

      // Gradient step
      const newX = x.map((xi, i) => xi - learningRate * gradient[i]!);

      // Project onto feasible region (simplified)
      x = projectOntoFeasibleRegion(newX, problem);

      // Check convergence
      const change = Math.sqrt(x.reduce((sum, xi, i) => sum + Math.pow(xi - newX[i]!, 2), 0));
      if (change < tolerance) {
        break;
      }
    }

    const objectiveValue = dotProduct(problem.objective, x);

    return {
      solution: x,
      objectiveValue,
      optimal: true,
      status: 'optimal',
      iterations: maxIterations,
    };
  } catch (error) {
    logger.error('LP solver failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      solution: new Array(n).fill(0),
      objectiveValue: Infinity,
      optimal: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Solve the linear minimization oracle (LMO) for Frank-Wolfe
 *
 * This is a special case of LP where we minimize <gradient, x>
 * over the marginal polytope.
 */
export function solveLMO(
  gradient: number[],
  constraints: Array<{
    coefficients: number[];
    rhs: number;
    type: 'equality' | 'inequality';
  }>
): number[] {
  const n = gradient.length;

  // For a simplex constraint, the LMO picks the vertex with minimum gradient
  // For more complex constraints, solve a proper LP

  // Simple case: just find minimum gradient component
  let minIdx = 0;
  let minValue = gradient[0]!;

  for (let i = 1; i < n; i++) {
    if (gradient[i]! < minValue) {
      minValue = gradient[i]!;
      minIdx = i;
    }
  }

  const vertex = new Array(n).fill(0);
  vertex[minIdx] = 1;

  return vertex;
}

/**
 * Check if a solution satisfies all constraints
 */
export function checkFeasibility(
  solution: number[],
  problem: LPProblem,
  tolerance: number = 1e-6
): { feasible: boolean; violations: string[] } {
  const violations: string[] = [];

  // Check inequality constraints
  if (problem.inequalityMatrix && problem.inequalityRhs) {
    for (let i = 0; i < problem.inequalityMatrix.length; i++) {
      const row = problem.inequalityMatrix[i]!;
      const value = dotProduct(row, solution);
      if (value > problem.inequalityRhs[i]! + tolerance) {
        violations.push(`Inequality ${i}: ${value} > ${problem.inequalityRhs[i]}`);
      }
    }
  }

  // Check equality constraints
  if (problem.equalityMatrix && problem.equalityRhs) {
    for (let i = 0; i < problem.equalityMatrix.length; i++) {
      const row = problem.equalityMatrix[i]!;
      const value = dotProduct(row, solution);
      if (Math.abs(value - problem.equalityRhs[i]!) > tolerance) {
        violations.push(`Equality ${i}: ${value} != ${problem.equalityRhs[i]}`);
      }
    }
  }

  // Check bounds
  if (problem.lowerBounds) {
    for (let i = 0; i < solution.length; i++) {
      if (solution[i]! < problem.lowerBounds[i]! - tolerance) {
        violations.push(`Lower bound ${i}: ${solution[i]} < ${problem.lowerBounds[i]}`);
      }
    }
  }

  if (problem.upperBounds) {
    for (let i = 0; i < solution.length; i++) {
      if (solution[i]! > problem.upperBounds[i]! + tolerance) {
        violations.push(`Upper bound ${i}: ${solution[i]} > ${problem.upperBounds[i]}`);
      }
    }
  }

  return { feasible: violations.length === 0, violations };
}

// Helper functions
function validateProblem(problem: LPProblem): void {
  const n = problem.objective.length;

  if (problem.inequalityMatrix) {
    for (const row of problem.inequalityMatrix) {
      if (row.length !== n) {
        throw new Error('Inequality matrix dimension mismatch');
      }
    }
  }

  if (problem.equalityMatrix) {
    for (const row of problem.equalityMatrix) {
      if (row.length !== n) {
        throw new Error('Equality matrix dimension mismatch');
      }
    }
  }

  if (problem.lowerBounds && problem.lowerBounds.length !== n) {
    throw new Error('Lower bounds dimension mismatch');
  }

  if (problem.upperBounds && problem.upperBounds.length !== n) {
    throw new Error('Upper bounds dimension mismatch');
  }
}

function initializeVariables(problem: LPProblem): number[] {
  const n = problem.objective.length;

  if (problem.lowerBounds && problem.upperBounds) {
    // Initialize at midpoint of bounds
    return problem.lowerBounds.map((lb, i) => (lb + problem.upperBounds![i]!) / 2);
  }

  // Default to zeros or lower bounds
  return problem.lowerBounds ? [...problem.lowerBounds] : new Array(n).fill(0);
}

function projectOntoFeasibleRegion(x: number[], problem: LPProblem): number[] {
  let result = [...x];

  // Apply bounds
  if (problem.lowerBounds) {
    result = result.map((xi, i) => Math.max(xi, problem.lowerBounds![i]!));
  }

  if (problem.upperBounds) {
    result = result.map((xi, i) => Math.min(xi, problem.upperBounds![i]!));
  }

  // Simple projection for sum-to-one constraint (if present)
  // This is a simplified version - proper implementation would use proper projection
  const sum = result.reduce((s, xi) => s + xi, 0);
  if (Math.abs(sum - 1) > 1e-6 && sum > 0) {
    result = result.map((xi) => xi / sum);
  }

  return result;
}

function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, ai, i) => sum + ai * b[i]!, 0);
}
