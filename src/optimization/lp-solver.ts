/**
 * Linear Programming Solver Interface
 *
 * Provides a unified interface for LP solvers.
 *
 * Standard form:
 *   minimize: c^T x
 *   subject to: A x <= b
 *                A_eq x = b_eq
 *                lb <= x <= ub
 */

import lpSolver from 'javascript-lp-solver';
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

export interface SolveLMOOptions {
  /** When true, constrained LP failure throws instead of returning simplex fallback */
  strict?: boolean;
}

interface SolverConstraint {
  max?: number;
  min?: number;
  equal?: number;
}

interface SolverModel {
  optimize: string;
  opType: 'max' | 'min';
  constraints: Record<string, SolverConstraint>;
  variables: Record<string, Record<string, number>>;
  ints?: Record<string, 1>;
  binaries?: Record<string, 1>;
  unrestricted?: Record<string, 1>;
  timeout?: number;
}

interface SolverResult {
  feasible?: boolean;
  bounded?: boolean;
  result?: number;
  [key: string]: unknown;
}

const solverBackend = lpSolver as unknown as { Solve: (model: SolverModel) => SolverResult };
const logger = getLogger().child({ module: 'LPSolver' });

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
    return {
      solution: [],
      objectiveValue: 0,
      optimal: true,
      status: 'optimal',
    };
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
    const feasibility = checkFeasibility(solution, problem, tolerance);

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
    logger.error('LP solver failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      solution: Array<number>(n).fill(0),
      objectiveValue: Infinity,
      optimal: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Solve the linear minimization oracle (LMO) for Frank-Wolfe.
 */
export function solveLMO(
  gradient: number[],
  constraints: {
    coefficients: number[];
    rhs: number;
    type: 'equality' | 'inequality';
  }[],
  options: SolveLMOOptions = {}
): number[] {
  const n = gradient.length;
  if (n === 0) {
    return [1];
  }

  if (constraints.length === 0) {
    return fallbackSimplexVertex(gradient);
  }

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

/**
 * Check if a solution satisfies all constraints
 */
export function checkFeasibility(
  solution: number[],
  problem: LPProblem,
  tolerance = 1e-6
): { feasible: boolean; violations: string[] } {
  const violations: string[] = [];

  // Check inequality constraints
  if (problem.inequalityMatrix && problem.inequalityRhs) {
    for (let i = 0; i < problem.inequalityMatrix.length; i++) {
      const row = problem.inequalityMatrix[i];
      const rhs = problem.inequalityRhs[i];
      if (!row || rhs === undefined) continue;
      const value = dotProduct(row, solution);
      if (value > rhs + tolerance) {
        violations.push('Inequality ' + String(i) + ': ' + String(value) + ' > ' + String(rhs));
      }
    }
  }

  // Check equality constraints
  if (problem.equalityMatrix && problem.equalityRhs) {
    for (let i = 0; i < problem.equalityMatrix.length; i++) {
      const row = problem.equalityMatrix[i];
      const rhs = problem.equalityRhs[i];
      if (!row || rhs === undefined) continue;
      const value = dotProduct(row, solution);
      if (Math.abs(value - rhs) > tolerance) {
        violations.push('Equality ' + String(i) + ': ' + String(value) + ' != ' + String(rhs));
      }
    }
  }

  // Check bounds
  if (problem.lowerBounds) {
    for (let i = 0; i < solution.length; i++) {
      const solVal = solution[i];
      const lb = problem.lowerBounds[i];
      if (solVal === undefined || lb === undefined) continue;
      if (solVal < lb - tolerance) {
        violations.push('Lower bound ' + String(i) + ': ' + String(solVal) + ' < ' + String(lb));
      }
    }
  }

  if (problem.upperBounds) {
    for (let i = 0; i < solution.length; i++) {
      const solVal = solution[i];
      const ub = problem.upperBounds[i];
      if (solVal === undefined || ub === undefined) continue;
      if (solVal > ub + tolerance) {
        violations.push('Upper bound ' + String(i) + ': ' + String(solVal) + ' > ' + String(ub));
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

  if (problem.inequalityMatrix && problem.inequalityRhs && problem.inequalityMatrix.length !== problem.inequalityRhs.length) {
    throw new Error('Inequality RHS dimension mismatch');
  }

  if (problem.equalityMatrix && problem.equalityRhs && problem.equalityMatrix.length !== problem.equalityRhs.length) {
    throw new Error('Equality RHS dimension mismatch');
  }

  if (problem.lowerBounds && problem.lowerBounds.length !== n) {
    throw new Error('Lower bounds dimension mismatch');
  }

  if (problem.upperBounds && problem.upperBounds.length !== n) {
    throw new Error('Upper bounds dimension mismatch');
  }
}

function buildSolverModel(
  problem: LPProblem,
  options: LPSolverOptions
): { model: SolverModel; variableNames: string[] } {
  const n = problem.objective.length;
  const variableNames = Array.from({ length: n }, (_, i) => `x_${String(i)}`);

  const model: SolverModel = {
    optimize: 'objective',
    opType: 'max',
    constraints: {},
    variables: {},
  };

  if (options.maxIterations !== undefined) {
    model.timeout = Math.max(1, options.maxIterations);
  }

  // Objective: backend maximizes, so negate to represent minimization.
  for (let i = 0; i < n; i++) {
    const varName = variableNames[i] ?? `x_${String(i)}`;
    model.variables[varName] = {
      objective: -(problem.objective[i] ?? 0),
    };
  }

  const unrestricted: Record<string, 1> = {};

  // Variable bounds. Default lower bound is 0 to keep legacy behavior.
  for (let i = 0; i < n; i++) {
    const varName = variableNames[i] ?? `x_${String(i)}`;
    const lb = problem.lowerBounds?.[i] ?? 0;
    const ub = problem.upperBounds?.[i];

    if (lb < 0) {
      unrestricted[varName] = 1;
    }

    const variable = model.variables[varName];
    if (!variable) {
      continue;
    }
    addConstraint(model, variable, `lb_${String(i)}`, 'min', lb, 1);

    if (ub !== undefined) {
      addConstraint(model, variable, `ub_${String(i)}`, 'max', ub, 1);
    }
  }

  if (Object.keys(unrestricted).length > 0) {
    model.unrestricted = unrestricted;
  }

  if (problem.inequalityMatrix && problem.inequalityRhs) {
    for (let r = 0; r < problem.inequalityMatrix.length; r++) {
      const row = problem.inequalityMatrix[r] ?? [];
      const rhs = problem.inequalityRhs[r];
      if (rhs === undefined) continue;

      const name = `ineq_${String(r)}`;
      model.constraints[name] = { max: rhs };

      for (let c = 0; c < n; c++) {
        const coef = row[c] ?? 0;
        if (coef !== 0) {
          const varName = variableNames[c] ?? `x_${String(c)}`;
          const variable = model.variables[varName];
          if (variable) {
            variable[name] = coef;
          }
        }
      }
    }
  }

  if (problem.equalityMatrix && problem.equalityRhs) {
    for (let r = 0; r < problem.equalityMatrix.length; r++) {
      const row = problem.equalityMatrix[r] ?? [];
      const rhs = problem.equalityRhs[r];
      if (rhs === undefined) continue;

      const name = `eq_${String(r)}`;
      model.constraints[name] = { equal: rhs };

      for (let c = 0; c < n; c++) {
        const coef = row[c] ?? 0;
        if (coef !== 0) {
          const varName = variableNames[c] ?? `x_${String(c)}`;
          const variable = model.variables[varName];
          if (variable) {
            variable[name] = coef;
          }
        }
      }
    }
  }

  return { model, variableNames };
}

function addConstraint(
  model: SolverModel,
  variable: Record<string, number>,
  name: string,
  type: 'min' | 'max' | 'equal',
  value: number,
  coefficient: number
): void {
  if (!Number.isFinite(value)) {
    return;
  }

  model.constraints[name] ??= {};
  model.constraints[name][type] = value;
  variable[name] = coefficient;
}

function fallbackSimplexVertex(gradient: number[]): number[] {
  const n = gradient.length;
  const vertex: number[] = Array<number>(n).fill(0);
  let minIdx = 0;
  let minValue = gradient[0] ?? Infinity;

  for (let i = 1; i < n; i++) {
    const grad = gradient[i];
    if (grad !== undefined && grad < minValue) {
      minValue = grad;
      minIdx = i;
    }
  }

  vertex[minIdx] = 1;
  return vertex;
}

function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, ai, i) => {
    const bi = b[i];
    return bi !== undefined ? sum + ai * bi : sum;
  }, 0);
}
