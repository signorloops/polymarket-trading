/**
 * IP solver internal helpers: MILP backend, validation, branch & bound.
 */

import { solveLP, type LPProblem, type LPSolution } from './lp-solver.js';
import { checkFeasibility } from './lp-solver-utils.js';
import lpSolver from 'javascript-lp-solver';
import type { IPProblem, IPSolution, IPSolverOptions } from './ip-solver.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';

const milpBackend = lpSolver as unknown as { Solve: (model: unknown) => Record<string, unknown> };
const logger = getLogger().child({ module: 'IPSolverUtils' });

export function validateIPProblem(problem: IPProblem): void {
  const n = problem.objective.length;

  if (problem.inequalityMatrix) {
    for (const row of problem.inequalityMatrix) {
      if (row.length !== n) throw new Error('Inequality matrix dimension mismatch');
    }
  }

  if (problem.equalityMatrix) {
    for (const row of problem.equalityMatrix) {
      if (row.length !== n) throw new Error('Equality matrix dimension mismatch');
    }
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

  if (problem.lowerBounds && problem.lowerBounds.length !== n)
    throw new Error('Lower bounds dimension mismatch');
  if (problem.upperBounds && problem.upperBounds.length !== n)
    throw new Error('Upper bounds dimension mismatch');

  for (const idx of problem.integerIndices ?? []) {
    if (idx < 0 || idx >= n) throw new Error('Integer index out of range');
  }
  for (const idx of problem.binaryIndices ?? []) {
    if (idx < 0 || idx >= n) throw new Error('Binary index out of range');
  }
}

/**
 * Check if a solution satisfies integer constraints
 */
export function isIntegerFeasible(
  solution: number[],
  problem: IPProblem,
  tolerance = 1e-5
): boolean {
  const indices = getDiscreteIndices(problem);

  for (const idx of indices) {
    const value = solution[idx];
    if (value === undefined) continue;

    if (problem.binaryIndices?.includes(idx)) {
      if (Math.abs(value) > tolerance && Math.abs(value - 1) > tolerance) return false;
    } else {
      if (Math.abs(value - Math.round(value)) > tolerance) return false;
    }
  }

  return true;
}

/** Union of integerIndices and binaryIndices (OPT-4). */
export function getDiscreteIndices(problem: IPProblem): number[] {
  const indices = new Set<number>([
    ...(problem.integerIndices ?? []),
    ...(problem.binaryIndices ?? []),
  ]);
  return [...indices];
}

function addBoundConstraint(
  constraints: Record<string, { max?: number; min?: number; equal?: number }>,
  variable: Record<string, number>,
  name: string,
  type: 'min' | 'max',
  value: number
): void {
  if (!Number.isFinite(value)) return;
  constraints[name] ??= {};
  constraints[name][type] = value;
  variable[name] = 1;
}

export function solveWithMilpBackend(
  problem: IPProblem,
  options: IPSolverOptions
): IPSolution | null {
  const n = problem.objective.length;
  if (n === 0) {
    return {
      solution: [],
      objectiveValue: 0,
      optimal: true,
      status: 'optimal',
      integerFeasible: true,
      relaxationGap: 0,
    };
  }

  try {
    const variableNames = Array.from({ length: n }, (_, i) => `x_${String(i)}`);
    const constraints: Record<string, { max?: number; min?: number; equal?: number }> = {};
    const variables: Record<string, Record<string, number>> = {};
    const ints: Record<string, 1> = {};
    const binaries: Record<string, 1> = {};
    const unrestricted: Record<string, 1> = {};

    for (let i = 0; i < n; i++) {
      const name = variableNames[i] ?? `x_${String(i)}`;
      variables[name] = { objective: -(problem.objective[i] ?? 0) };

      const lb = problem.lowerBounds?.[i] ?? 0;
      const ub = problem.upperBounds?.[i];
      if (lb < 0) unrestricted[name] = 1;
      const variable = variables[name];
      addBoundConstraint(constraints, variable, `lb_${String(i)}`, 'min', lb);
      if (ub !== undefined) addBoundConstraint(constraints, variable, `ub_${String(i)}`, 'max', ub);
    }

    if (problem.inequalityMatrix && problem.inequalityRhs) {
      for (let r = 0; r < problem.inequalityMatrix.length; r++) {
        const row = problem.inequalityMatrix[r] ?? [];
        const rhs = problem.inequalityRhs[r];
        if (rhs === undefined) continue;
        const cname = `ineq_${String(r)}`;
        constraints[cname] = { max: rhs };
        for (let c = 0; c < n; c++) {
          const coef = row[c] ?? 0;
          if (coef !== 0) {
            const varName = variableNames[c] ?? `x_${String(c)}`;
            const variable = variables[varName];
            if (variable) variable[cname] = coef;
          }
        }
      }
    }

    if (problem.equalityMatrix && problem.equalityRhs) {
      for (let r = 0; r < problem.equalityMatrix.length; r++) {
        const row = problem.equalityMatrix[r] ?? [];
        const rhs = problem.equalityRhs[r];
        if (rhs === undefined) continue;
        const cname = `eq_${String(r)}`;
        constraints[cname] = { equal: rhs };
        for (let c = 0; c < n; c++) {
          const coef = row[c] ?? 0;
          if (coef !== 0) {
            const varName = variableNames[c] ?? `x_${String(c)}`;
            const variable = variables[varName];
            if (variable) variable[cname] = coef;
          }
        }
      }
    }

    for (const idx of problem.integerIndices ?? []) {
      const name = variableNames[idx];
      if (name) ints[name] = 1;
    }
    for (const idx of problem.binaryIndices ?? []) {
      const name = variableNames[idx];
      if (name) binaries[name] = 1;
    }

    const model: Record<string, unknown> = {
      optimize: 'objective',
      opType: 'max',
      constraints,
      variables,
    };
    if (Object.keys(ints).length > 0) model.ints = ints;
    if (Object.keys(binaries).length > 0) model.binaries = binaries;
    if (Object.keys(unrestricted).length > 0) model.unrestricted = unrestricted;
    if (options.timeoutMs !== undefined || options.maxIterations !== undefined) {
      model.timeout = Math.max(1, options.timeoutMs ?? options.maxIterations ?? 1);
    }
    if (options.mipGap !== undefined) {
      model.tolerance = options.mipGap;
    }

    const raw = milpBackend.Solve(model) as Record<string, unknown> & {
      feasible?: boolean;
      bounded?: boolean;
      iter?: number;
    };

    if (raw.feasible === false) {
      return {
        solution: Array<number>(n).fill(0),
        objectiveValue: Infinity,
        optimal: false,
        status: raw.bounded === false ? 'unbounded' : 'infeasible',
        integerFeasible: false,
      };
    }

    // Mirror solveLP unbounded detection (OPT-1).
    if (raw.bounded === false || !Number.isFinite(Number(raw.result))) {
      return {
        solution: Array<number>(n).fill(0),
        objectiveValue: Infinity,
        optimal: false,
        status: 'unbounded',
        integerFeasible: false,
      };
    }

    const solution = variableNames.map((name) => {
      const val = raw[name];
      return Number.isFinite(val as number) ? Number(val) : 0;
    });
    const objectiveValue = problem.objective.reduce(
      (sum, coef, i) => sum + coef * (solution[i] ?? 0),
      0
    );
    const tolerance = options.tolerance ?? 1e-6;
    const feasibility = checkFeasibility(solution, problem, tolerance);
    if (!feasibility.feasible) {
      return {
        solution,
        objectiveValue,
        optimal: false,
        status: 'error',
        integerFeasible: false,
        error: `MILP backend produced infeasible solution: ${feasibility.violations.join('; ')}`,
      };
    }
    const integerFeasible = isIntegerFeasible(solution, problem);
    const iter = Number(raw.iter);

    return {
      solution,
      objectiveValue,
      optimal: integerFeasible,
      status: integerFeasible ? 'optimal' : 'error',
      integerFeasible,
      relaxationGap: 0,
      ...(integerFeasible ? {} : { error: 'MILP backend returned a non-integer solution' }),
      ...(Number.isFinite(iter) ? { iterations: iter } : {}),
    };
  } catch (error) {
    // Mirror solveLP: log the failure instead of swallowing it silently, so a
    // broken MILP backend is observable rather than degrading to a null result
    // that callers (solveIP) then treat as "no MILP, fall back to B&B".
    logger.error('MILP backend solve failed', { error: getErrorMessage(error) });
    return null;
  }
}

// Branch and bound implementation
interface BBNode {
  solution: number[];
  objectiveValue: number;
  depth: number;
  lowerBounds: number[];
  upperBounds: number[];
}

export function branchAndBound(
  problem: IPProblem,
  lpSolution: LPSolution,
  options: IPSolverOptions
): IPSolution {
  const { mipGap = 0.01, nodeLimit = 1000 } = options;
  const n = problem.objective.length;

  let bestSolution: number[] | undefined;
  let bestValue = Infinity;
  let nodeCount = 0;
  let foundInteger = false;

  const initialLower = problem.lowerBounds ? [...problem.lowerBounds] : Array<number>(n).fill(0);
  const initialUpper = problem.upperBounds
    ? [...problem.upperBounds]
    : Array<number>(n).fill(Infinity);

  const queue: BBNode[] = [
    {
      solution: lpSolution.solution,
      objectiveValue: lpSolution.objectiveValue,
      depth: 0,
      lowerBounds: initialLower,
      upperBounds: initialUpper,
    },
  ];

  while (queue.length > 0 && nodeCount < nodeLimit) {
    const node = queue.shift();
    if (!node) continue;
    nodeCount++;

    if (isIntegerFeasible(node.solution, problem)) {
      if (node.objectiveValue < bestValue) {
        bestSolution = node.solution;
        bestValue = node.objectiveValue;
        foundInteger = true;
      }
      continue;
    }

    const branchIdx = findBranchingVariable(node.solution, problem);
    if (branchIdx === -1) continue;

    const value = node.solution[branchIdx];
    if (value === undefined) continue;
    const floor = Math.floor(value);
    const ceil = Math.ceil(value);

    // Standard B&B: tighten bounds, do not fix variables to a single point (OPT-2).
    const leftUpper = [...node.upperBounds];
    leftUpper[branchIdx] = Math.min(leftUpper[branchIdx] ?? Infinity, floor);
    const rightLower = [...node.lowerBounds];
    rightLower[branchIdx] = Math.max(rightLower[branchIdx] ?? -Infinity, ceil);

    const leftResult = solveLP(createSubproblem(problem, node.lowerBounds, leftUpper), options);
    const rightResult = solveLP(createSubproblem(problem, rightLower, node.upperBounds), options);

    if (leftResult.status === 'optimal' && leftResult.objectiveValue < bestValue * (1 - mipGap)) {
      queue.push({
        solution: leftResult.solution,
        objectiveValue: leftResult.objectiveValue,
        depth: node.depth + 1,
        lowerBounds: [...node.lowerBounds],
        upperBounds: leftUpper,
      });
    }
    if (rightResult.status === 'optimal' && rightResult.objectiveValue < bestValue * (1 - mipGap)) {
      queue.push({
        solution: rightResult.solution,
        objectiveValue: rightResult.objectiveValue,
        depth: node.depth + 1,
        lowerBounds: rightLower,
        upperBounds: [...node.upperBounds],
      });
    }
  }

  // No integer-feasible incumbent found (OPT-3).
  if (!foundInteger || bestSolution === undefined || !Number.isFinite(bestValue)) {
    return {
      solution: lpSolution.solution,
      objectiveValue: Infinity,
      optimal: false,
      status: 'infeasible',
      integerFeasible: false,
      relaxationGap: 0,
      iterations: nodeCount,
    };
  }

  const denom = Math.abs(lpSolution.objectiveValue);
  const relaxationGap = denom > 0 ? (bestValue - lpSolution.objectiveValue) / denom : 0;

  return {
    solution: bestSolution,
    objectiveValue: bestValue,
    optimal: nodeCount < nodeLimit,
    status: nodeCount < nodeLimit ? 'optimal' : 'error',
    integerFeasible: true,
    relaxationGap,
    iterations: nodeCount,
  };
}

function findBranchingVariable(solution: number[], problem: IPProblem): number {
  const indices = getDiscreteIndices(problem);
  let maxFractional = 0;
  let branchIdx = -1;

  for (const idx of indices) {
    const value = solution[idx];
    if (value === undefined) continue;
    const fractional = Math.abs(value - Math.round(value));
    if (fractional > maxFractional) {
      maxFractional = fractional;
      branchIdx = idx;
    }
  }

  return branchIdx;
}

function createSubproblem(
  problem: IPProblem,
  lowerBounds: number[],
  upperBounds: number[]
): LPProblem {
  return {
    ...problem,
    ...(problem.inequalityMatrix
      ? { inequalityMatrix: problem.inequalityMatrix.map((row) => [...row]) }
      : {}),
    ...(problem.inequalityRhs ? { inequalityRhs: [...problem.inequalityRhs] } : {}),
    ...(problem.equalityMatrix
      ? { equalityMatrix: problem.equalityMatrix.map((row) => [...row]) }
      : {}),
    ...(problem.equalityRhs ? { equalityRhs: [...problem.equalityRhs] } : {}),
    lowerBounds: [...lowerBounds],
    upperBounds: [...upperBounds],
  };
}
