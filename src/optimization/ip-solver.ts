/**
 * Integer Programming Solver Interface
 *
 * Provides a unified interface for IP/MILP solvers.
 * Used for solving discrete optimization problems over the marginal polytope.
 *
 * Standard form:
 *   minimize: c^T x
 *   subject to: A x <= b
 *                A_eq x = b_eq
 *                x_i ∈ Z for i in integerIndices
 *                lb <= x <= ub
 */

import { getLogger } from '../utils/logger.js';
import { solveLP, LPProblem, LPSolution } from './lp-solver.js';
import lpSolver from 'javascript-lp-solver';

export interface IPProblem extends LPProblem {
  /** Indices of variables that must be integers */
  integerIndices?: number[];
  /** Binary variable indices (subset of integerIndices) */
  binaryIndices?: number[];
}

export interface IPSolution extends LPSolution {
  /** Whether all integer constraints are satisfied */
  integerFeasible: boolean;
  /** Relaxation gap (difference from LP relaxation) */
  relaxationGap?: number;
}

export interface IPSolverOptions {
  /** Maximum iterations */
  maxIterations?: number;
  /** Feasibility tolerance */
  tolerance?: number;
  /** MIP gap tolerance */
  mipGap?: number;
  /** Enable verbose output */
  verbose?: boolean;
  /** Branch and bound node limit */
  nodeLimit?: number;
}

const logger = getLogger().child({ module: 'IPSolver' });
const milpBackend = lpSolver as unknown as { Solve: (model: unknown) => Record<string, unknown> };

/**
 * Solve an integer programming problem
 *
 * Uses branch and bound with LP relaxation.
 * This is a simplified implementation - for production, use a proper solver.
 */
export function solveIP(
  problem: IPProblem,
  options: IPSolverOptions = {}
): IPSolution {
  const { nodeLimit = 1000 } = options;

  try {
    validateIPProblem(problem);

    const hasIntegerConstraints =
      (problem.integerIndices?.length ?? 0) > 0 || (problem.binaryIndices?.length ?? 0) > 0;

    // Solve LP relaxation first (also keeps legacy error semantics for invalid formulations).
    const lpSolution = solveLP(problem, options);

    if (lpSolution.status !== 'optimal') {
      return {
        ...lpSolution,
        integerFeasible: false,
        error: 'LP relaxation infeasible',
      };
    }

    if (!hasIntegerConstraints) {
      return {
        ...lpSolution,
        integerFeasible: true,
        relaxationGap: 0,
      };
    }

    // Preserve legacy behavior: a tiny node budget cannot prove optimal integer solution.
    if (nodeLimit <= 1) {
      return {
        solution: lpSolution.solution,
        objectiveValue: lpSolution.objectiveValue,
        optimal: false,
        status: 'error',
        integerFeasible: isIntegerFeasible(lpSolution.solution, problem),
        relaxationGap: 0,
        iterations: Math.max(0, nodeLimit),
        error: 'Branch-and-bound node limit exceeded',
      };
    }

    // Try direct MILP backend first (higher-quality solutions than toy BnB).
    const backendResult = solveWithMilpBackend(problem, options);
    if (backendResult !== null) {
      return {
        ...backendResult,
        relaxationGap:
          lpSolution.objectiveValue > 0
            ? (backendResult.objectiveValue - lpSolution.objectiveValue) / lpSolution.objectiveValue
            : 0,
      };
    }

    // Check if solution already satisfies integer constraints
    if (isIntegerFeasible(lpSolution.solution, problem)) {
      return {
        ...lpSolution,
        integerFeasible: true,
        relaxationGap: 0,
      };
    }

    // Branch and bound
    const result = branchAndBound(problem, lpSolution, options);

    return result;
  } catch (error) {
    logger.error('IP solver failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      solution: new Array(problem.objective.length).fill(0) as number[],
      objectiveValue: Infinity,
      optimal: false,
      status: 'error',
      integerFeasible: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function solveWithMilpBackend(
  problem: IPProblem,
  _options: IPSolverOptions
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
      if (lb < 0) {
        unrestricted[name] = 1;
      }
      const variable = variables[name];
      addBoundConstraint(constraints, variable, `lb_${String(i)}`, 'min', lb);
      if (ub !== undefined) {
        addBoundConstraint(constraints, variable, `ub_${String(i)}`, 'max', ub);
      }
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
            if (variable) {
              variable[cname] = coef;
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
        const cname = `eq_${String(r)}`;
        constraints[cname] = { equal: rhs };
        for (let c = 0; c < n; c++) {
          const coef = row[c] ?? 0;
          if (coef !== 0) {
            const varName = variableNames[c] ?? `x_${String(c)}`;
            const variable = variables[varName];
            if (variable) {
              variable[cname] = coef;
            }
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

    const solution = variableNames.map((name) => {
      const val = raw[name];
      return Number.isFinite(val as number) ? Number(val) : 0;
    });
    const objectiveValue = problem.objective.reduce(
      (sum, coef, i) => sum + coef * (solution[i] ?? 0),
      0
    );
    const integerFeasible = isIntegerFeasible(solution, problem);

    const iter = Number(raw.iter);

    return {
      solution,
      objectiveValue,
      optimal: true,
      status: 'optimal',
      integerFeasible,
      relaxationGap: 0,
      ...(Number.isFinite(iter) ? { iterations: iter } : {}),
    };
  } catch {
    return null;
  }
}

function addBoundConstraint(
  constraints: Record<string, { max?: number; min?: number; equal?: number }>,
  variable: Record<string, number>,
  name: string,
  type: 'min' | 'max',
  value: number
): void {
  if (!Number.isFinite(value)) {
    return;
  }
  constraints[name] ??= {};
  constraints[name][type] = value;
  variable[name] = 1;
}

function validateIPProblem(problem: IPProblem): void {
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

  for (const idx of problem.integerIndices ?? []) {
    if (idx < 0 || idx >= n) {
      throw new Error('Integer index out of range');
    }
  }

  for (const idx of problem.binaryIndices ?? []) {
    if (idx < 0 || idx >= n) {
      throw new Error('Binary index out of range');
    }
  }
}

/**
 * Solve binary integer programming (all variables are 0 or 1)
 * Common for selection problems in arbitrage detection
 */
export function solveBinaryIP(
  objective: number[],
  constraints: {
    coefficients: number[];
    rhs: number;
    type: '<=' | '=' | '>=';
  }[],
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

  // Convert constraints
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
      // Convert >= to <= by multiplying by -1
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
 * Solve the vertex enumeration problem for the marginal polytope
 *
 * Finds the vertices of the polytope that are relevant for Frank-Wolfe.
 */
export function enumerateVertices(
  constraints: {
    coefficients: number[];
    rhs: number;
    type: 'equality' | 'inequality';
  }[],
  n: number,
  maxVertices = 100
): number[][] {
  const vertices: number[][] = [];

  // For a simplex, vertices are the unit vectors
  // For more complex polytopes, this requires proper vertex enumeration

  // Add unit vectors (simplex vertices)
  for (let i = 0; i < n; i++) {
    const vertex: number[] = new Array(n).fill(0) as number[];
    vertex[i] = 1;
    vertices.push(vertex);
  }

  // Try to find additional vertices by solving systems of equations
  // This is a simplified version - proper implementation would use proper vertex enumeration

  logger.debug(`Enumerated ${String(vertices.length)} vertices`);

  return vertices.slice(0, maxVertices);
}

/**
 * Check if a solution satisfies integer constraints
 */
export function isIntegerFeasible(
  solution: number[],
  problem: IPProblem,
  tolerance = 1e-5
): boolean {
  const indices = problem.integerIndices ?? problem.binaryIndices ?? [];

  for (const idx of indices) {
    const value = solution[idx];
    if (value === undefined) continue;

    if (problem.binaryIndices?.includes(idx)) {
      // Binary constraint: x ∈ {0, 1}
      if (Math.abs(value) > tolerance && Math.abs(value - 1) > tolerance) {
        return false;
      }
    } else {
      // Integer constraint: x ∈ Z
      if (Math.abs(value - Math.round(value)) > tolerance) {
        return false;
      }
    }
  }

  return true;
}

// Branch and bound implementation
interface BBNode {
  solution: number[];
  objectiveValue: number;
  depth: number;
  fixedIndices: Map<number, number>;
}

function branchAndBound(
  problem: IPProblem,
  lpSolution: LPSolution,
  options: IPSolverOptions
): IPSolution {
  const { mipGap = 0.01, nodeLimit = 1000 } = options;

  let bestSolution = lpSolution.solution;
  let bestValue = Infinity;
  let nodeCount = 0;

  const queue: BBNode[] = [
    {
      solution: lpSolution.solution,
      objectiveValue: lpSolution.objectiveValue,
      depth: 0,
      fixedIndices: new Map(),
    },
  ];

  while (queue.length > 0 && nodeCount < nodeLimit) {
    const node = queue.shift();
    if (!node) continue;
    nodeCount++;

    // Check if solution is integer feasible
    if (isIntegerFeasible(node.solution, problem)) {
      if (node.objectiveValue < bestValue) {
        bestSolution = node.solution;
        bestValue = node.objectiveValue;
      }
      continue;
    }

    // Find a fractional variable to branch on
    const branchIdx = findBranchingVariable(node.solution, problem);
    if (branchIdx === -1) continue;

    const value = node.solution[branchIdx];
    if (value === undefined) continue;
    const floor = Math.floor(value);
    const ceil = Math.ceil(value);

    // Create two subproblems (branch)
    const leftFixed = new Map(node.fixedIndices);
    leftFixed.set(branchIdx, floor);

    const rightFixed = new Map(node.fixedIndices);
    rightFixed.set(branchIdx, ceil);

    // Solve subproblems (simplified - just add constraints)
    const leftProblem = createSubproblem(problem, leftFixed);
    const rightProblem = createSubproblem(problem, rightFixed);

    const leftResult = solveLP(leftProblem, options);
    const rightResult = solveLP(rightProblem, options);

    // Add to queue if feasible and promising
    if (leftResult.status === 'optimal' && leftResult.objectiveValue < bestValue * (1 + mipGap)) {
      queue.push({
        solution: leftResult.solution,
        objectiveValue: leftResult.objectiveValue,
        depth: node.depth + 1,
        fixedIndices: leftFixed,
      });
    }

    if (rightResult.status === 'optimal' && rightResult.objectiveValue < bestValue * (1 + mipGap)) {
      queue.push({
        solution: rightResult.solution,
        objectiveValue: rightResult.objectiveValue,
        depth: node.depth + 1,
        fixedIndices: rightFixed,
      });
    }
  }

  const relaxationGap = lpSolution.objectiveValue > 0
    ? (bestValue - lpSolution.objectiveValue) / lpSolution.objectiveValue
    : 0;

  return {
    solution: bestSolution,
    objectiveValue: bestValue,
    optimal: nodeCount < nodeLimit,
    status: nodeCount < nodeLimit ? 'optimal' : 'error',
    integerFeasible: isIntegerFeasible(bestSolution, problem),
    relaxationGap,
    iterations: nodeCount,
  };
}

function findBranchingVariable(solution: number[], problem: IPProblem): number {
  const indices = problem.integerIndices ?? problem.binaryIndices ?? [];

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
  fixedIndices: Map<number, number>
): LPProblem {
  const subproblem: LPProblem = {
    ...problem,
    ...(problem.inequalityMatrix
      ? { inequalityMatrix: problem.inequalityMatrix.map((row) => [...row]) }
      : {}),
    ...(problem.inequalityRhs ? { inequalityRhs: [...problem.inequalityRhs] } : {}),
    ...(problem.equalityMatrix
      ? { equalityMatrix: problem.equalityMatrix.map((row) => [...row]) }
      : {}),
    ...(problem.equalityRhs ? { equalityRhs: [...problem.equalityRhs] } : {}),
    ...(problem.lowerBounds ? { lowerBounds: [...problem.lowerBounds] } : {}),
    ...(problem.upperBounds ? { upperBounds: [...problem.upperBounds] } : {}),
  };

  // Add fixed values as equality constraints
  for (const [idx, value] of fixedIndices) {
    const constraint: number[] = new Array(problem.objective.length).fill(0) as number[];
    constraint[idx] = 1;

    if (!subproblem.equalityMatrix) {
      subproblem.equalityMatrix = [];
      subproblem.equalityRhs = [];
    }

    subproblem.equalityMatrix.push(constraint);
    if (subproblem.equalityRhs) {
      subproblem.equalityRhs.push(value);
    }
  }

  return subproblem;
}
