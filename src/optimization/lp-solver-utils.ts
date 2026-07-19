/**
 * LP solver internal helpers: model building, validation, feasibility checks.
 */

import type { LPProblem, LPSolverOptions } from './lp-solver.js';

export interface SolverConstraint {
  max?: number;
  min?: number;
  equal?: number;
}

export interface SolverModel {
  optimize: string;
  opType: 'max' | 'min';
  constraints: Record<string, SolverConstraint>;
  variables: Record<string, Record<string, number>>;
  ints?: Record<string, 1>;
  binaries?: Record<string, 1>;
  unrestricted?: Record<string, 1>;
  timeout?: number;
}

export interface SolverResult {
  feasible?: boolean;
  bounded?: boolean;
  result?: number;
  [key: string]: unknown;
}

export function validateProblem(problem: LPProblem): void {
  const n = problem.objective.length;

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(problem.objective[i])) {
      throw new Error(`Objective coefficient ${String(i)} is not finite`);
    }
  }

  if (problem.inequalityMatrix) {
    for (const row of problem.inequalityMatrix) {
      if (row.length !== n) throw new Error('Inequality matrix dimension mismatch');
      for (const value of row) {
        if (!Number.isFinite(value))
          throw new Error('Inequality matrix contains non-finite values');
      }
    }
  }

  if (problem.equalityMatrix) {
    for (const row of problem.equalityMatrix) {
      if (row.length !== n) throw new Error('Equality matrix dimension mismatch');
      for (const value of row) {
        if (!Number.isFinite(value)) throw new Error('Equality matrix contains non-finite values');
      }
    }
  }

  const hasIneqMatrix = Boolean(problem.inequalityMatrix?.length);
  const hasIneqRhs = Boolean(problem.inequalityRhs?.length);
  if (hasIneqMatrix !== hasIneqRhs) {
    throw new Error('Inequality matrix and RHS must both be provided together');
  }

  const hasEqMatrix = Boolean(problem.equalityMatrix?.length);
  const hasEqRhs = Boolean(problem.equalityRhs?.length);
  if (hasEqMatrix !== hasEqRhs) {
    throw new Error('Equality matrix and RHS must both be provided together');
  }

  if (
    problem.inequalityMatrix &&
    problem.inequalityRhs &&
    problem.inequalityMatrix.length !== problem.inequalityRhs.length
  ) {
    throw new Error('Inequality RHS dimension mismatch');
  }

  if (
    problem.equalityMatrix &&
    problem.equalityRhs &&
    problem.equalityMatrix.length !== problem.equalityRhs.length
  ) {
    throw new Error('Equality RHS dimension mismatch');
  }

  if (problem.inequalityRhs) {
    for (const rhs of problem.inequalityRhs) {
      if (!Number.isFinite(rhs)) throw new Error('Inequality RHS contains non-finite values');
    }
  }
  if (problem.equalityRhs) {
    for (const rhs of problem.equalityRhs) {
      if (!Number.isFinite(rhs)) throw new Error('Equality RHS contains non-finite values');
    }
  }

  if (problem.lowerBounds && problem.lowerBounds.length !== n)
    throw new Error('Lower bounds dimension mismatch');
  if (problem.upperBounds && problem.upperBounds.length !== n)
    throw new Error('Upper bounds dimension mismatch');

  if (problem.lowerBounds) {
    for (const bound of problem.lowerBounds) {
      if (!Number.isFinite(bound) && bound !== -Infinity) {
        throw new Error('Lower bounds contain non-finite values');
      }
    }
  }
  if (problem.upperBounds) {
    for (const bound of problem.upperBounds) {
      if (!Number.isFinite(bound) && bound !== Infinity) {
        throw new Error('Upper bounds contain non-finite values');
      }
    }
  }
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
    throw new Error(`Constraint ${name} has a non-finite RHS`);
  }
  model.constraints[name] ??= {};
  model.constraints[name][type] = value;
  variable[name] = coefficient;
}

export function buildSolverModel(
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

  if (options.timeoutMs !== undefined || options.maxIterations !== undefined) {
    // javascript-lp-solver reads `timeout` as wall-clock milliseconds (OPT-6).
    model.timeout = Math.max(1, options.timeoutMs ?? options.maxIterations ?? 1);
  }

  for (let i = 0; i < n; i++) {
    const varName = variableNames[i] ?? `x_${String(i)}`;
    model.variables[varName] = { objective: -(problem.objective[i] ?? 0) };
  }

  const unrestricted: Record<string, 1> = {};

  for (let i = 0; i < n; i++) {
    const varName = variableNames[i] ?? `x_${String(i)}`;
    const lb = problem.lowerBounds?.[i] ?? 0;
    const ub = problem.upperBounds?.[i];

    if (lb < 0) unrestricted[varName] = 1;

    const variable = model.variables[varName];
    if (!variable) continue;
    if (Number.isFinite(lb)) {
      addConstraint(model, variable, `lb_${String(i)}`, 'min', lb, 1);
    }
    if (ub !== undefined && Number.isFinite(ub)) {
      addConstraint(model, variable, `ub_${String(i)}`, 'max', ub, 1);
    }
  }

  if (Object.keys(unrestricted).length > 0) model.unrestricted = unrestricted;

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
          if (variable) variable[name] = coef;
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
          if (variable) variable[name] = coef;
        }
      }
    }
  }

  return { model, variableNames };
}

export function checkFeasibility(
  solution: number[],
  problem: LPProblem,
  tolerance = 1e-6
): { feasible: boolean; violations: string[] } {
  const violations: string[] = [];
  const absTol = (scale: number): number => tolerance * Math.max(1, Math.abs(scale));

  if (problem.inequalityMatrix && problem.inequalityRhs) {
    for (let i = 0; i < problem.inequalityMatrix.length; i++) {
      const row = problem.inequalityMatrix[i];
      const rhs = problem.inequalityRhs[i];
      if (!row || rhs === undefined) continue;
      const value = dotProduct(row, solution);
      if (value > rhs + absTol(rhs)) {
        violations.push('Inequality ' + String(i) + ': ' + String(value) + ' > ' + String(rhs));
      }
    }
  }

  if (problem.equalityMatrix && problem.equalityRhs) {
    for (let i = 0; i < problem.equalityMatrix.length; i++) {
      const row = problem.equalityMatrix[i];
      const rhs = problem.equalityRhs[i];
      if (!row || rhs === undefined) continue;
      const value = dotProduct(row, solution);
      if (Math.abs(value - rhs) > absTol(rhs)) {
        violations.push('Equality ' + String(i) + ': ' + String(value) + ' != ' + String(rhs));
      }
    }
  }

  if (problem.lowerBounds) {
    for (let i = 0; i < solution.length; i++) {
      const solVal = solution[i];
      const lb = problem.lowerBounds[i];
      if (solVal === undefined || lb === undefined) continue;
      if (solVal < lb - absTol(lb)) {
        violations.push('Lower bound ' + String(i) + ': ' + String(solVal) + ' < ' + String(lb));
      }
    }
  }

  if (problem.upperBounds) {
    for (let i = 0; i < solution.length; i++) {
      const solVal = solution[i];
      const ub = problem.upperBounds[i];
      if (solVal === undefined || ub === undefined) continue;
      if (solVal > ub + absTol(ub)) {
        violations.push('Upper bound ' + String(i) + ': ' + String(solVal) + ' > ' + String(ub));
      }
    }
  }

  return { feasible: violations.length === 0, violations };
}

export function fallbackSimplexVertex(gradient: number[]): number[] {
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

export function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, ai, i) => {
    const bi = b[i];
    return bi !== undefined ? sum + ai * bi : sum;
  }, 0);
}
