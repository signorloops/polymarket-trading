/**
 * Line Search Algorithms for Frank-Wolfe
 *
 * Provides step size selection strategies.
 */

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
  if (mu.length !== s.length || mu.length !== gradient.length) {
    throw new Error('Line search dimension mismatch');
  }

  // Fallback (objective-free): one-step quadratic approximation around current point.
  let numer = 0;
  let denom = 0;
  for (let i = 0; i < mu.length; i++) {
    const direction = (s[i] ?? 0) - (mu[i] ?? 0);
    numer += (gradient[i] ?? 0) * direction;
    denom += direction * direction;
  }
  if (denom <= 0) {
    return 0;
  }

  const gamma = -numer / denom;
  return Math.max(0, Math.min(1, gamma));
}

/**
 * Line search using the real objective along segment [mu, s].
 * Uses golden-section search in [0,1], which is robust and derivative-free.
 */
export function lineSearchObjective(
  mu: ArrayLike<number>,
  s: ArrayLike<number>,
  objectiveFn: (candidate: number[] | Float64Array) => number,
  maxIterations = 40,
  candidateBuffer?: Float64Array
): number {
  if (mu.length !== s.length) {
    throw new Error('Line search dimension mismatch');
  }

  const n = mu.length;
  const candidate =
    candidateBuffer?.length === n
      ? candidateBuffer
      : new Float64Array(n);

  const evaluateAtGamma = (gamma: number): number => {
    for (let i = 0; i < n; i++) {
      const muVal = mu[i] ?? 0;
      const sVal = s[i] ?? 0;
      candidate[i] = muVal + gamma * (sVal - muVal);
    }
    return objectiveFn(candidate);
  };

  let left = 0;
  let right = 1;
  const phi = (Math.sqrt(5) - 1) / 2;

  let x1 = right - phi * (right - left);
  let x2 = left + phi * (right - left);
  let f1 = evaluateAtGamma(x1);
  let f2 = evaluateAtGamma(x2);

  for (let iter = 0; iter < maxIterations && right - left > 1e-8; iter++) {
    if (f1 > f2) {
      left = x1;
      x1 = x2;
      f1 = f2;
      x2 = left + phi * (right - left);
      f2 = evaluateAtGamma(x2);
    } else {
      right = x2;
      x2 = x1;
      f2 = f1;
      x1 = right - phi * (right - left);
      f1 = evaluateAtGamma(x1);
    }
  }

  const gamma = (left + right) / 2;
  return Math.max(0, Math.min(1, gamma));
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
