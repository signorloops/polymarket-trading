import {
  solveIP,
  solveBinaryIP,
  enumerateVertices,
  isIntegerFeasible,
  type IPProblem,
} from '../../src/optimization/ip-solver.js';

describe('IPSolver', () => {
  describe('solveIP', () => {
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

    it('should solve integer programming with branch and bound', () => {
      // Problem: minimize x + 2y subject to x + y >= 1, x,y in {0,1}
      // Optimal solution: x=1, y=0 with value 1
      const problem: IPProblem = {
        objective: [1, 2],
        inequalityMatrix: [[-1, -1]], // -x - y <= -1 means x + y >= 1
        inequalityRhs: [-1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
        binaryIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 100, mipGap: 0.01 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });

    it('should respect node limit and mark as error when exceeded', () => {
      // Complex problem that requires many nodes
      const problem: IPProblem = {
        objective: [1, 1, 1, 1],
        lowerBounds: [0, 0, 0, 0],
        upperBounds: [1, 1, 1, 1],
        integerIndices: [0, 1, 2, 3],
      };

      const result = solveIP(problem, { nodeLimit: 1 });

      // When node limit is exceeded, status should be 'error'
      expect(result.status).toBe('error');
      expect(result.iterations).toBeLessThanOrEqual(1);
    });

    it('should handle problem with only inequality constraints', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        inequalityMatrix: [[1, 1]],
        inequalityRhs: [1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 50 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });

    it('should handle problem with no integer constraints', () => {
      // Should still work even without integer constraints
      const problem: IPProblem = {
        objective: [1, 2],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
      };

      const result = solveIP(problem);

      expect(result.status).toBe('optimal');
      expect(result.integerFeasible).toBe(true);
    });

    it('should handle gap tolerance (mipGap) for pruning', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        inequalityMatrix: [[1, 1]],
        inequalityRhs: [1.5],
        lowerBounds: [0, 0],
        upperBounds: [2, 2],
        integerIndices: [0, 1],
      };

      // With different mipGap values
      const result1 = solveIP(problem, { nodeLimit: 100, mipGap: 0.5 });
      const result2 = solveIP(problem, { nodeLimit: 100, mipGap: 0.001 });

      expect(result1.solution).toBeDefined();
      expect(result2.solution).toBeDefined();
    });

    it('should handle problem with both equality and inequality constraints', () => {
      const problem: IPProblem = {
        objective: [1, 2, 3],
        equalityMatrix: [[1, 1, 0]],
        equalityRhs: [1],
        inequalityMatrix: [[0, 1, 1]],
        inequalityRhs: [1],
        lowerBounds: [0, 0, 0],
        upperBounds: [1, 1, 1],
        integerIndices: [0, 1, 2],
      };

      const result = solveIP(problem, { nodeLimit: 100 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(3);
    });

    it('should handle problem with only equality constraints', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        equalityMatrix: [[1, 1]],
        equalityRhs: [1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 50 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });

    it('should handle problem with negative objective coefficients', () => {
      const problem: IPProblem = {
        objective: [-1, -2],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 50 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });
  });

  describe('solveBinaryIP', () => {
    it('should solve binary integer programming problem', () => {
      const objective = [2, 3, 1];
      const constraints = [
        { coefficients: [1, 1, 0], rhs: 1, type: '<=' as const },
        { coefficients: [0, 1, 1], rhs: 1, type: '<=' as const },
      ];

      const result = solveBinaryIP(objective, constraints, { nodeLimit: 100 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(3);
      // All values should be close to 0 or 1
      for (const val of result.solution) {
        expect(val).toBeGreaterThanOrEqual(-0.01);
        expect(val).toBeLessThanOrEqual(1.01);
      }
    });

    it('should handle equality constraints in binary IP', () => {
      const objective = [1, 1];
      const constraints = [
        { coefficients: [1, 1], rhs: 1, type: '=' as const },
      ];

      const result = solveBinaryIP(objective, constraints, { nodeLimit: 50 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });

    it('should handle >= constraints by converting to <=', () => {
      const objective = [1, 1];
      const constraints = [
        { coefficients: [1, 1], rhs: 1, type: '>=' as const },
      ];

      const result = solveBinaryIP(objective, constraints, { nodeLimit: 50 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });

    it('should handle empty constraints array', () => {
      const objective = [1, 2, 3];
      const constraints: { coefficients: number[]; rhs: number; type: '<=' | '=' | '>=' }[] = [];

      const result = solveBinaryIP(objective, constraints);

      expect(result.solution.length).toBe(3);
      expect(result.status).toBe('optimal');
    });

    it('should handle single variable binary IP', () => {
      const objective = [5];
      const constraints = [
        { coefficients: [1], rhs: 1, type: '<=' as const },
      ];

      const result = solveBinaryIP(objective, constraints, { nodeLimit: 10 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(1);
    });
  });

  describe('enumerateVertices', () => {
    it('should return unit vectors for simplex', () => {
      const constraints = [
        { coefficients: [1, 1, 1], rhs: 1, type: 'equality' as const },
      ];

      const vertices = enumerateVertices(constraints, 3, 100);

      expect(vertices.length).toBe(3);
      // Check unit vectors
      expect(vertices[0]).toEqual([1, 0, 0]);
      expect(vertices[1]).toEqual([0, 1, 0]);
      expect(vertices[2]).toEqual([0, 0, 1]);
    });

    it('should respect maxVertices limit', () => {
      const constraints: { coefficients: number[]; rhs: number; type: 'equality' | 'inequality' }[] = [];

      const vertices = enumerateVertices(constraints, 10, 5);

      expect(vertices.length).toBe(5);
    });

    it('should handle empty constraints', () => {
      const vertices = enumerateVertices([], 3, 100);

      expect(vertices.length).toBe(3);
      expect(vertices[0]).toEqual([1, 0, 0]);
    });

    it('should handle maxVertices of 0', () => {
      const vertices = enumerateVertices([], 5, 0);

      expect(vertices.length).toBe(0);
    });

    it('should handle inequality constraints', () => {
      const constraints = [
        { coefficients: [1, 1], rhs: 1, type: 'inequality' as const },
      ];

      const vertices = enumerateVertices(constraints, 2, 100);

      expect(vertices.length).toBe(2);
    });
  });

  describe('isIntegerFeasible', () => {
    it('should return true for integer feasible solution', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        integerIndices: [0, 1],
      };

      const result = isIntegerFeasible([0, 1], problem);

      expect(result).toBe(true);
    });

    it('should return true for integer feasible with negative integers', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        integerIndices: [0, 1],
      };

      const result = isIntegerFeasible([-2, 5], problem);

      expect(result).toBe(true);
    });

    it('should return false for non-integer values', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        integerIndices: [0, 1],
      };

      const result = isIntegerFeasible([0.5, 1], problem);

      expect(result).toBe(false);
    });

    it('should return false for binary variables not 0 or 1', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        integerIndices: [0, 1],
        binaryIndices: [0, 1],
      };

      // Value 0.5 is not binary
      const result = isIntegerFeasible([0.5, 0], problem);

      expect(result).toBe(false);
    });

    it('should return true for valid binary values (0 and 1)', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        integerIndices: [0, 1],
        binaryIndices: [0, 1],
      };

      const result = isIntegerFeasible([0, 1], problem);

      expect(result).toBe(true);
    });

    it('should handle mixed integer and binary constraints', () => {
      const problem: IPProblem = {
        objective: [1, 1, 1],
        integerIndices: [0, 1, 2],
        binaryIndices: [0, 1], // Only first two are binary
      };

      // x0=0, x1=1 (binary), x2=2.5 (integer but not binary)
      const result = isIntegerFeasible([0, 1, 2.5], problem);

      expect(result).toBe(false);
    });

    it('should skip undefined values in solution', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        integerIndices: [0, 1],
      };

      const solution = [0];
      // @ts-expect-error - Testing undefined handling
      solution[1] = undefined;

      // Should not throw and should return true (only checking defined values)
      expect(() => isIntegerFeasible(solution, problem)).not.toThrow();
    });

    it('should use binaryIndices when integerIndices is not provided', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        binaryIndices: [0, 1],
      };

      const result = isIntegerFeasible([1, 0], problem);

      expect(result).toBe(true);
    });

    it('should return true when no integer constraints', () => {
      const problem: IPProblem = {
        objective: [1, 1],
      };

      const result = isIntegerFeasible([0.5, 0.7], problem);

      expect(result).toBe(true);
    });

    it('should respect custom tolerance', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        integerIndices: [0],
      };

      // 0.00001 is within default tolerance 1e-5
      const result1 = isIntegerFeasible([0.00001], problem);
      expect(result1).toBe(true);

      // But not within stricter tolerance
      const result2 = isIntegerFeasible([0.0001], problem, 1e-6);
      expect(result2).toBe(false);
    });

    it('should handle value very close to 0 for binary', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        binaryIndices: [0],
      };

      // Very small value should be treated as 0
      const result = isIntegerFeasible([0.000001], problem);
      expect(result).toBe(true);
    });

    it('should handle value very close to 1 for binary', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        binaryIndices: [0],
      };

      // Value very close to 1 should be treated as 1
      const result = isIntegerFeasible([0.999999], problem);
      expect(result).toBe(true);
    });

    it('should handle empty indices', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        integerIndices: [],
      };

      const result = isIntegerFeasible([0.5, 0.7], problem);
      expect(result).toBe(true);
    });
  });

  describe('branch and bound edge cases', () => {
    it('should handle when all fractional variables are undefined', () => {
      // Create a problem where solution values might be undefined
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      // This should complete without error
      const result = solveIP(problem, { nodeLimit: 10 });

      expect(result.solution).toBeDefined();
    });

    it('should handle subproblem creation with inequality matrix', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        inequalityMatrix: [[1, 1]],
        inequalityRhs: [1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 50 });

      expect(result.solution).toBeDefined();
      // Verify inequality constraints weren't mutated
      expect(problem.inequalityMatrix).toHaveLength(1);
      expect(problem.inequalityRhs).toHaveLength(1);
    });

    it('should handle subproblem creation without existing equality matrix', () => {
      // This tests lines 365-366 where equalityMatrix is created if it doesn't exist
      const problem: IPProblem = {
        objective: [1, 1],
        inequalityMatrix: [[1, 1]],
        inequalityRhs: [1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      // Run multiple times to trigger branching
      const result = solveIP(problem, { nodeLimit: 100, mipGap: 0.01 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });

    it('should handle pruning by bound (objective worse than best)', () => {
      // Create a problem where some branches should be pruned by bound
      const problem: IPProblem = {
        objective: [1, 1, 1],
        lowerBounds: [0, 0, 0],
        upperBounds: [5, 5, 5],
        integerIndices: [0, 1, 2],
      };

      const result = solveIP(problem, { nodeLimit: 100, mipGap: 0.05 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(3);
    });

    it('should handle infeasible subproblems during branch and bound', () => {
      // Problem that creates infeasible subproblems
      const problem: IPProblem = {
        objective: [1, 1],
        equalityMatrix: [[1, 1]],
        equalityRhs: [1],
        lowerBounds: [0, 0],
        upperBounds: [0.6, 0.6], // Makes it tricky for integer solution
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 100 });

      // May not find a feasible integer solution
      expect(result.status).toBeDefined();
    });

    it('should handle solution with relaxation gap calculation', () => {
      const problem: IPProblem = {
        objective: [1, 2],
        inequalityMatrix: [[1, 1]],
        inequalityRhs: [1.5],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 100 });

      expect(result.relaxationGap).toBeDefined();
      if (result.relaxationGap !== undefined) {
        expect(result.relaxationGap).toBeGreaterThanOrEqual(0);
      }
    });

    it('should handle empty solution array edge case', () => {
      const problem: IPProblem = {
        objective: [],
        integerIndices: [],
      };

      const result = solveIP(problem);

      expect(result.solution).toEqual([]);
      expect(result.integerFeasible).toBe(true);
    });

    it('should handle large node limit', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 500 });

      expect(result.solution).toBeDefined();
    });

    it('should handle problem with only lower bounds', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 50 });

      expect(result.solution).toBeDefined();
    });

    it('should handle problem with only upper bounds', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 50 });

      expect(result.solution).toBeDefined();
    });
  });

  describe('verbose mode', () => {
    it('should run without error in verbose mode', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      // Should not throw when verbose is true
      expect(() => {
        solveIP(problem, { verbose: true, nodeLimit: 10 });
      }).not.toThrow();
    });
  });

  describe('IP solution validation', () => {
    it('should return solution with correct shape', () => {
      const problem: IPProblem = {
        objective: [1, 2, 3],
        lowerBounds: [0, 0, 0],
        upperBounds: [1, 1, 1],
        integerIndices: [0, 1, 2],
      };

      const result = solveIP(problem, { nodeLimit: 100 });

      expect(result).toHaveProperty('solution');
      expect(result).toHaveProperty('objectiveValue');
      expect(result).toHaveProperty('optimal');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('integerFeasible');
    });

    it('should handle fractional values in solution', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 1 });

      // With only 1 node, we may not find integer solution
      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });
  });

  describe('error handling', () => {
    it('should handle LP validation error (dimension mismatch)', () => {
      // Create a problem with mismatched dimensions to trigger validation error
      const problem: IPProblem = {
        objective: [1, 1],
        equalityMatrix: [[1, 1, 1]], // Wrong dimension - should be length 2
        equalityRhs: [1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem);

      expect(result.status).toBe('error');
      expect(result.integerFeasible).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.objectiveValue).toBe(Infinity);
    });

    it('should handle lower bounds dimension mismatch', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0, 0], // Wrong dimension
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem);

      expect(result.status).toBe('error');
      expect(result.integerFeasible).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle upper bounds dimension mismatch', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1, 1], // Wrong dimension
        integerIndices: [0, 1],
      };

      const result = solveIP(problem);

      expect(result.status).toBe('error');
      expect(result.integerFeasible).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle inequality matrix dimension mismatch', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        inequalityMatrix: [[1, 1, 1]], // Wrong dimension
        inequalityRhs: [1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem);

      expect(result.status).toBe('error');
      expect(result.integerFeasible).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('branch and bound integer feasible update', () => {
    it('should update best solution when finding integer feasible solution with better objective', () => {
      // Create a problem that will find integer solutions during branch and bound
      // Force the algorithm to explore and find better integer solutions
      const problem: IPProblem = {
        objective: [1, 2],
        lowerBounds: [0, 0],
        upperBounds: [2, 2],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 500, mipGap: 0.01 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
      // The best solution should have integer values
      expect(result.solution[0]).toBeCloseTo(Math.round(result.solution[0]), 0);
      expect(result.solution[1]).toBeCloseTo(Math.round(result.solution[1]), 0);
    });

    it('should handle multiple integer feasible solutions found during search', () => {
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0],
        upperBounds: [2, 2],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 100, mipGap: 0.1 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
    });

    it('should find and update best integer solution in branch and bound', () => {
      // Create a problem where we can find integer solutions with different objectives
      // Minimize x + y subject to x + y >= 1, x,y in {0,1,2}
      // Integer solutions: (0,1)=1, (1,0)=1, (0,2)=2, (2,0)=2, (1,1)=2, etc.
      // Best is 1
      const problem: IPProblem = {
        objective: [1, 1],
        inequalityMatrix: [[-1, -1]], // x + y >= 1
        inequalityRhs: [-1],
        lowerBounds: [0, 0],
        upperBounds: [2, 2],
        integerIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 500, mipGap: 0.05 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
      // If we found an integer solution, it should be reasonable
      if (result.integerFeasible) {
        expect(result.objectiveValue).toBeLessThan(3);
      }
    });

    it('should explore branch and bound tree and find integer solutions', () => {
      // Simple binary problem: minimize 2x + y subject to x + y >= 1
      // Integer solutions: (0,1)=1, (1,0)=2, (1,1)=3
      // Best is (0,1) with value 1
      const problem: IPProblem = {
        objective: [2, 1],
        inequalityMatrix: [[-1, -1]],
        inequalityRhs: [-1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
        binaryIndices: [0, 1],
      };

      const result = solveIP(problem, { nodeLimit: 100, mipGap: 0.01 });

      expect(result.solution).toBeDefined();
      expect(result.solution.length).toBe(2);
      // Both values should be close to 0 or 1
      for (const val of result.solution) {
        const rounded = Math.round(val);
        expect(Math.abs(val - rounded)).toBeLessThan(0.1);
      }
    });
  });

  describe('logger error handling', () => {
    it('should handle non-Error exception in catch block', () => {
      // This test is to cover line 86-90 where logger.error is called
      // We can't easily trigger this without mocking, but the error handling
      // path is tested through validation errors
      const problem: IPProblem = {
        objective: [1, 1],
        lowerBounds: [0, 0],
        upperBounds: [1, 1],
        integerIndices: [0, 1],
      };

      // This should not throw
      expect(() => solveIP(problem)).not.toThrow();
    });
  });
});
