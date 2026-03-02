/**
 * Linear Minimization Oracle (LMO)
 *
 * Finds the vertex of the polytope that minimizes the inner product with gradient.
 * For the marginal polytope, vertices correspond to deterministic outcomes.
 */

import type { Constraint } from './frank-wolfe-types.js';
import { solveLMO as solveLPOBasedLMO } from '../optimization/lp-solver.js';

/**
 * Linear Minimization Oracle (LMO)
 * Finds the vertex of the polytope that minimizes the inner product with gradient
 *
 * For the marginal polytope, vertices correspond to deterministic outcomes
 *
 * @param gradient Current gradient
 * @param constraints Polytope constraints
 * @returns Vertex minimizing ⟨gradient, v⟩
 */
export function linearMinimizationOracle(
  gradient: number[],
  constraints: Constraint[]
): number[] {
  const n = gradient.length;
  if (n === 0) {
    throw new Error('Empty gradient array');
  }

  const fallbackSimplexVertex = (): number[] => {
    const vertex: number[] = Array.from<number>({ length: n }).fill(0);
    let minIdx = 0;
    let minValue = gradient[0] ?? Infinity;

    for (let i = 1; i < n; i++) {
      const gradientValue = gradient[i] ?? Infinity;
      if (gradientValue < minValue) {
        minValue = gradientValue;
        minIdx = i;
      }
    }

    vertex[minIdx] = 1;
    return vertex;
  };

  const equalityConstraints = constraints.filter(
    (constraint) =>
      constraint.type === 'equality' &&
      constraint.coefficients.length === n &&
      constraint.coefficients.some((c) => c > 0)
  );
  const inequalityConstraints = constraints.filter(
    (constraint) =>
      constraint.type === 'inequality' &&
      constraint.coefficients.length === n
  );

  if (equalityConstraints.length === 0 && inequalityConstraints.length === 0) {
    return fallbackSimplexVertex();
  }

  // Fast path for product-of-simplex equalities only.
  if (inequalityConstraints.length === 0 && equalityConstraints.length > 0) {
    const vertex: number[] = Array.from<number>({ length: n }).fill(0);
    let hasAssignedCoordinate = false;

    // For product-of-simplex style constraints (common in this project),
    // pick the best coordinate within each equality group independently.
    for (const constraint of equalityConstraints) {
      const support: number[] = [];
      for (let i = 0; i < n; i++) {
        const coeffValue = constraint.coefficients[i] ?? 0;
        if (coeffValue > 0) {
          support.push(i);
        }
      }

      if (support.length === 0) {
        continue;
      }

      const firstIdx = support[0] ?? 0;
      let bestIdx = firstIdx;
      const firstGradient = gradient[firstIdx] ?? 0;
      const firstCoeff = constraint.coefficients[firstIdx] ?? 1;
      let bestScore = firstGradient / firstCoeff;

      for (let i = 1; i < support.length; i++) {
        const idx = support[i] ?? 0;
        const gradientValue = gradient[idx] ?? 0;
        const coeffValue = constraint.coefficients[idx] ?? 1;
        const score = gradientValue / coeffValue;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      }

      const coeff = constraint.coefficients[bestIdx] ?? 1;
      const assignedValue = coeff !== 0 ? constraint.rhs / coeff : 0;
      vertex[bestIdx] = Math.max(0, assignedValue);
      hasAssignedCoordinate = true;
    }

    return hasAssignedCoordinate ? vertex : fallbackSimplexVertex();
  }

  // General path: solve linear objective with all constraints via LP backend.
  // Core inequality convention is coefficients · x >= rhs; convert to LP <= form.
  const lpConstraints = constraints.map((constraint) => {
    if (constraint.type === 'equality') {
      return constraint;
    }
    return {
      type: 'inequality' as const,
      coefficients: constraint.coefficients.map((c) => -c),
      rhs: -constraint.rhs,
    };
  });

  return solveLPOBasedLMO(gradient, lpConstraints);
}
