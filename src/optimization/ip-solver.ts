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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { mipGap = 0.01, nodeLimit = 1000 } = options;

  try {
    // Solve LP relaxation first
    const lpSolution = solveLP(problem, options);

    if (lpSolution.status !== 'optimal') {
      return {
        ...lpSolution,
        integerFeasible: false,
        error: 'LP relaxation infeasible',
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
