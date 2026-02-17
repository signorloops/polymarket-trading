import { solveIP, type IPProblem } from '../../src/optimization/ip-solver.js';

describe('IPSolver', () => {
  it('should not mutate input equality constraints during branch-and-bound', () => {
    const problem: IPProblem = {
      objective: [0, 0],
      equalityMatrix: [[1, 1]],
      equalityRhs: [1],
      lowerBounds: [0, 0],
      upperBounds: [1, 1],
      integerIndices: [0, 1],
    };

    const originalEqRows = problem.equalityMatrix?.length ?? 0;
    const originalEqRhsRows = problem.equalityRhs?.length ?? 0;

    solveIP(problem, { nodeLimit: 20, maxIterations: 50 });

    expect(problem.equalityMatrix).toHaveLength(originalEqRows);
    expect(problem.equalityRhs).toHaveLength(originalEqRhsRows);
  });
});
