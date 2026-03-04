/**
 * Linear Programming Solver Interface
 *
 * Standard form:
 *   minimize: c^T x
 *   subject to: A x <= b, A_eq x = b_eq, lb <= x <= ub
 */

import lpSolver from 'javascript-lp-solver';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  validateProblem,
  buildSolverModel,
  checkFeasibility as checkFeasibilityImpl,
  fallbackSimplexVertex,
  dotProduct,
  type SolverResult,
  type SolverModel,
} from './lp-solver-utils.js';

export interface LPProblem {
  objective: number[];
  inequalityMatrix?: number[][];
  inequalityRhs?: number[];
  equalityMatrix?: number[][];
  equalityRhs?: number[];
  lowerBounds?: number[];
  upperBounds?: number[];
}

export interface LPSolution {
  solution: number[];
  objectiveValue: number;
  optimal: boolean;
  status: 'optimal' | 'infeasible' | 'unbounded' | 'error';
  iterations?: number;
  error?: string;
}

export interface LPSolverOptions {
  maxIterations?: number;
  tolerance?: number;
  verbose?: boolean;
}

export interface SolveLMOOptions {
  strict?: boolean;
}

const solverBackend = lpSolver as unknown as { Solve: (model: SolverModel) => SolverResult };
const logger = getLogger().child({ module: 'LPSolver' });

// Re-export for consumers
export { checkFeasibilityImpl as checkFeasibility };

/**
 * Solve a linear programming problem via javascript-lp-solver backend.
 */
export function solveLP(
  problem: LPProblem,
  options: LPSolverOptions = {}
): LPSolution {
  const { tolerance = 1e-6 } = options;
  const n = problem.objective.length;

  if (n === 0) {
    return { solution: [], objectiveValue: 0, optimal: true, status: 'optimal' };
  }

  try {
    validateProblem(problem);
    const { model, variableNames } = buildSolverModel(problem, options);
    const raw = solverBackend.Solve(model);

    if (raw.feasible === false) {
      return {
        solution: Array<number>(n).fill(0),
        objectiveValue: Infinity,
        optimal: false,
        status: raw.bounded === false ? 'unbounded' : 'infeasible',
      };
    }

    const solution = variableNames.map((name) => {
      const val = raw[name];
      return Number.isFinite(val as number) ? Number(val) : 0;
    });

    const objectiveValue = dotProduct(problem.objective, solution);
    const feasibility = checkFeasibilityImpl(solution, problem, tolerance);

    if (!feasibility.feasible) {
      return {
        solution,
        objectiveValue,
        optimal: false,
        status: 'error',
        error: `Backend produced infeasible solution: ${feasibility.violations.join('; ')}`,
      };
    }

    const iter = Number(raw.iter);
    return {
      solution,
      objectiveValue,
      optimal: true,
      status: 'optimal',
      ...(Number.isFinite(iter) ? { iterations: iter } : {}),
    };
  } catch (error) {
    logger.error('LP solver failed', { error: getErrorMessage(error) });
    return {
      solution: Array<number>(n).fill(0),
      objectiveValue: Infinity,
      optimal: false,
      status: 'error',
      error: getErrorMessage(error),
    };
  }
}

/**
 * Solve the linear minimization oracle (LMO) for Frank-Wolfe.
 */
export function solveLMO(
  gradient: number[],
  constraints: { coefficients: number[]; rhs: number; type: 'equality' | 'inequality' }[],
  options: SolveLMOOptions = {}
): number[] {
  const n = gradient.length;
  if (n === 0) return [1];

  if (constraints.length === 0) return fallbackSimplexVertex(gradient);

  const equalityMatrix: number[][] = [];
  const equalityRhs: number[] = [];
  const inequalityMatrix: number[][] = [];
  const inequalityRhs: number[] = [];

  for (const constraint of constraints) {
    if (constraint.type === 'equality') {
      equalityMatrix.push(constraint.coefficients);
      equalityRhs.push(constraint.rhs);
    } else {
      inequalityMatrix.push(constraint.coefficients);
      inequalityRhs.push(constraint.rhs);
    }
  }

  const result = solveLP({
    objective: gradient,
    ...(equalityMatrix.length > 0 ? { equalityMatrix, equalityRhs } : {}),
    ...(inequalityMatrix.length > 0 ? { inequalityMatrix, inequalityRhs } : {}),
    lowerBounds: Array<number>(n).fill(0),
  });

  if (result.status === 'optimal' && result.solution.length === n) {
    return result.solution;
  }

  if (options.strict) {
    throw new Error(
      `LMO LP solve failed under constraints (status=${result.status}${result.error ? `, error=${result.error}` : ''})`
    );
  }

  return fallbackSimplexVertex(gradient);
}
