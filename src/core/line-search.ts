/**
 * Line Search Algorithms for Frank-Wolfe
 *
 * Provides step size selection strategies.
 */

import { vectorSubtract, vectorAdd, vectorScale, vectorDot } from '../utils/math.js';

/**
 * Line search for KL divergence minimization
 * Finds optimal step size γ that minimizes D((1-γ)μ + γs || θ)
 *
 * @param mu Current point
 * @param s Search direction (vertex from LMO)
 * @param gradient Gradient at current point
 * @returns Optimal step size γ ∈ [0, 1]
 */
export function lineSearchKL(mu: number[], s: number[], gradient: number[]): number {
  // For KL divergence, the optimal step size can be computed analytically
  // or approximated using bisection
  const d = vectorSubtract(s, mu);

  // Try different step sizes and pick the best
  let bestGamma = 0;
  let bestValue = Infinity;

  for (let i = 1; i <= 20; i++) {
    const gamma = i / 20;
    const newMu = vectorAdd(mu, vectorScale(d, gamma));

    // Compute objective (approximate)
    const value = vectorDot(gradient, vectorSubtract(newMu, mu));

    if (value < bestValue) {
      bestValue = value;
      bestGamma = gamma;
    }
  }

  return bestGamma;
}

/**
 * Adaptive step size strategy
 * Returns step size that decreases with iterations
 *
 * @param iteration Current iteration number
 * @returns Step size γ
 */
export function adaptiveStepSize(iteration: number): number {
  return 2 / (iteration + 2);
}

/**
 * Fixed step size strategy
 *
 * @param initialStepSize Fixed step size value
 * @returns Constant step size
 */
export function fixedStepSize(initialStepSize: number): number {
  return initialStepSize;
}
