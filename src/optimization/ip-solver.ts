/**
 * Integer Programming Solver Interface
 *
 * Provides a unified interface for IP/MILP solvers.
 * Standard form:
 *   minimize: c^T x
 *   subject to: A x <= b, A_eq x = b_eq,
 *               x_i ∈ Z for i in integerIndices, lb <= x <= ub
 */

import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';
import { solveLP, type LPProblem, type LPSolution } from './lp-solver.js';
import {
  validateIPProblem,
  isIntegerFeasible,
  solveWithMilpBackend,
  branchAndBound,
} from './ip-solver-utils.js';

export interface IPProblem extends LPProblem {
  integerIndices?: number[];
  binaryIndices?: number[];
}

export interface IPSolution extends LPSolution {
  integerFeasible: boolean;
  relaxationGap?: number;
}

export interface IPSolverOptions {
  /**
   * @deprecated Misnamed wall-clock timeout alias. Prefer timeoutMs.
   */
  maxIterations?: number;
  /** Wall-clock timeout in ms passed to the MILP backend (OPT-6). */
  timeoutMs?: number;
  tolerance?: number;
  mipGap?: number;
  nodeLimit?: number;
}

const logger = getLogger().child({ module: 'IPSolver' });

// Re-export for consumers
export { isIntegerFeasible } from './ip-solver-utils.js';

/**
 * Solve an integer programming problem using branch and bound with LP relaxation.
 */
export function solveIP(problem: IPProblem, options: IPSolverOptions = {}): IPSolution {
  const { nodeLimit = 1000 } = options;

  try {
    validateIPProblem(problem);

    const hasIntegerConstraints =
      (problem.integerIndices?.length ?? 0) > 0 || (problem.binaryIndices?.length ?? 0) > 0;

    const lpSolution = solveLP(problem, options);

    if (lpSolution.status !== 'optimal') {
      const detail = lpSolution.error ? `: ${lpSolution.error}` : '';
      return {
        ...lpSolution,
        integerFeasible: false,
        error: `LP relaxation ${lpSolution.status}${detail}`,
      };
    }

    if (!hasIntegerConstraints) {
      return { ...lpSolution, integerFeasible: true, relaxationGap: 0 };
    }

    if (nodeLimit <= 1) {
      return {
        solution: lpSolution.solution,
        objectiveValue: lpSolution.objectiveValue,
        optimal: false,
        status: 'error',
        integerFeasible: isIntegerFeasible(lpSolution.solution, problem),
        iterations: 0,
        error: 'Branch-and-bound skipped: nodeLimit <= 1 (LP relaxation only)',
      };
    }

    const backendResult = solveWithMilpBackend(problem, options);
    if (backendResult !== null) {
      const denom = Math.abs(lpSolution.objectiveValue);
      return {
        ...backendResult,
        relaxationGap:
          denom > 0 ? (backendResult.objectiveValue - lpSolution.objectiveValue) / denom : 0,
      };
    }

    if (isIntegerFeasible(lpSolution.solution, problem)) {
      return { ...lpSolution, integerFeasible: true, relaxationGap: 0 };
    }

    return branchAndBound(problem, lpSolution, options);
  } catch (error) {
    logger.error('IP solver failed', { error: getErrorMessage(error) });
    return {
      solution: new Array(problem.objective.length).fill(0) as number[],
      objectiveValue: Infinity,
      optimal: false,
      status: 'error',
      integerFeasible: false,
      error: getErrorMessage(error),
    };
  }
}

/**
 * Solve binary integer programming (all variables are 0 or 1).
 */
export function solveBinaryIP(
  objective: number[],
  constraints: { coefficients: number[]; rhs: number; type: '<=' | '=' | '>=' }[],
  options: IPSolverOptions = {}
): IPSolution {
  const n = objective.length;

  const problem: IPProblem = {
    objective,
    integerIndices: Array.from({ length: n }, (_, i) => i),
    binaryIndices: Array.from({ length: n }, (_, i) => i),
    lowerBounds: new Array(n).fill(0) as number[],
    upperBounds: new Array(n).fill(1) as number[],
  };

  const inequalityMatrix: number[][] = [];
  const inequalityRhs: number[] = [];
  const equalityMatrix: number[][] = [];
  const equalityRhs: number[] = [];

  for (const constraint of constraints) {
    if (constraint.type === '=') {
      equalityMatrix.push(constraint.coefficients);
      equalityRhs.push(constraint.rhs);
    } else if (constraint.type === '<=') {
      inequalityMatrix.push(constraint.coefficients);
      inequalityRhs.push(constraint.rhs);
    } else {
      inequalityMatrix.push(constraint.coefficients.map((c) => -c));
      inequalityRhs.push(-constraint.rhs);
    }
  }

  if (inequalityMatrix.length > 0) {
    problem.inequalityMatrix = inequalityMatrix;
    problem.inequalityRhs = inequalityRhs;
  }
  if (equalityMatrix.length > 0) {
    problem.equalityMatrix = equalityMatrix;
    problem.equalityRhs = equalityRhs;
  }

  return solveIP(problem, options);
}

/**
 * @deprecated OPT-8: previously ignored constraints and returned unit vectors.
 * Removed — use the LP-backed LMO (`solveLMO` / `linearMinimizationOracle`) instead.
 */
export function enumerateVertices(
  _constraints: { coefficients: number[]; rhs: number; type: 'equality' | 'inequality' }[],
  _n: number,
  _maxVertices = 100
): number[][] {
  throw new Error(
    'enumerateVertices was a stub that ignored constraints (OPT-8); use solveLMO / linearMinimizationOracle'
  );
}
