/**
 * Linear Minimization Oracle (LMO)
 *
 * Finds the vertex of the polytope that minimizes the inner product with gradient.
 * For the marginal polytope, vertices correspond to deterministic outcomes.
 */

import type { Constraint } from './frank-wolfe-types.js';
import { solveLMO as solveLPOBasedLMO } from '../optimization/lp-solver.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger().child({ module: 'LMO' });

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
export function linearMinimizationOracle(gradient: number[], constraints: Constraint[]): number[] {
  const n = gradient.length;
  if (n === 0) {
    throw new Error('Empty gradient array');
  }

  const equalityConstraints = constraints.filter(
    (constraint) => constraint.type === 'equality' && constraint.coefficients.length === n
  );
  const inequalityConstraints = constraints.filter(
    (constraint) => constraint.type === 'inequality' && constraint.coefficients.length === n
  );

  const droppedEqualities = constraints.filter(
    (constraint) =>
      constraint.type === 'equality' &&
      constraint.coefficients.length === n &&
      !constraint.coefficients.some((c) => c > 0)
  );
  if (droppedEqualities.length > 0) {
    logger.warn('LMO equality constraints have no positive coefficients; routing to LP', {
      dropped: droppedEqualities.length,
    });
  }

  if (equalityConstraints.length === 0 && inequalityConstraints.length === 0) {
    return fallbackSimplexVertex(gradient);
  }

  // Fast path only when equalities form a product-of-simplex: disjoint supports,
  // all coefficients ≥ 0, and at least one positive coeff per constraint (CORE-2).
  if (inequalityConstraints.length === 0 && equalityConstraints.length > 0) {
    if (isProductOfSimplexEqualities(equalityConstraints, n)) {
      return solveProductOfSimplexLMO(gradient, equalityConstraints);
    }
    logger.warn('LMO fast path structure check failed; falling back to LP', {
      equalities: equalityConstraints.length,
    });
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

  // Prefer a structured product-of-simplex fallback over a single global e_i
  // when the LP backend fails (CORE-3).
  const structuredFallback = (): number[] => {
    const usable = equalityConstraints.filter((c) => c.coefficients.some((coef) => coef > 0));
    if (usable.length > 0 && isProductOfSimplexEqualities(usable, n)) {
      return solveProductOfSimplexLMO(gradient, usable);
    }
    return fallbackSimplexVertex(gradient);
  };

  try {
    return solveLPOBasedLMO(gradient, lpConstraints, { strict: true });
  } catch {
    // Non-strict historical behavior: degrade instead of aborting FW (CORE-3).
    logger.warn('LMO LP solve failed; using structured simplex fallback');
    return structuredFallback();
  }
}

function isProductOfSimplexEqualities(equalities: Constraint[], n: number): boolean {
  const claimed = new Array<boolean>(n).fill(false);
  for (const constraint of equalities) {
    let hasPositive = false;
    for (let i = 0; i < n; i++) {
      const c = constraint.coefficients[i] ?? 0;
      if (c < 0) {
        return false;
      }
      if (c > 0) {
        hasPositive = true;
        if (claimed[i]) {
          return false;
        }
        claimed[i] = true;
      }
    }
    if (!hasPositive) {
      return false;
    }
  }
  return true;
}

function solveProductOfSimplexLMO(gradient: number[], equalityConstraints: Constraint[]): number[] {
  const n = gradient.length;
  const vertex: number[] = Array.from<number>({ length: n }).fill(0);
  let hasAssignedCoordinate = false;

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

  return hasAssignedCoordinate ? vertex : fallbackSimplexVertex(gradient);
}

function fallbackSimplexVertex(gradient: number[]): number[] {
  const n = gradient.length;
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
}
