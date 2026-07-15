/**
 * Mathematical utility functions for vector operations and probability calculations
 */

/**
 * Add two vectors element-wise
 */
export function vectorAdd(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length.toString()} vs ${b.length.toString()}`);
  }
  return a.map((val, i) => {
    const bVal = b[i];
    if (bVal === undefined) return val;
    return val + bVal;
  });
}

/**
 * Subtract vector b from vector a element-wise
 */
export function vectorSubtract(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length.toString()} vs ${b.length.toString()}`);
  }
  return a.map((val, i) => {
    const bVal = b[i];
    if (bVal === undefined) return val;
    return val - bVal;
  });
}

/**
 * Scale a vector by a scalar
 */
export function vectorScale(a: number[], scalar: number): number[] {
  return a.map((val) => val * scalar);
}

/**
 * Compute dot product of two vectors
 */
export function vectorDot(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length.toString()} vs ${b.length.toString()}`);
  }
  return a.reduce((sum, val, i) => {
    const bVal = b[i];
    if (bVal === undefined) return sum;
    return sum + val * bVal;
  }, 0);
}

/**
 * Compute L2 norm (Euclidean length) of a vector
 */
export function vectorNorm(a: number[]): number {
  return Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
}

/**
 * Element-wise multiplication of two vectors
 */
export function vectorMultiply(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length.toString()} vs ${b.length.toString()}`);
  }
  return a.map((val, i) => {
    const bVal = b[i];
    if (bVal === undefined) return val;
    return val * bVal;
  });
}

/**
 * Element-wise division of two vectors
 */
export function vectorDivide(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length.toString()} vs ${b.length.toString()}`);
  }
  return a.map((val, i) => {
    const bVal = b[i];
    if (bVal === 0) {
      throw new Error('Division by zero in vector division');
    }
    if (bVal === undefined) return val;
    return val / bVal;
  });
}

/**
 * Sum all elements of a vector
 */
export function vectorSum(a: number[]): number {
  return a.reduce((sum, val) => sum + val, 0);
}

/**
 * Compute element-wise log of a vector
 */
export function vectorLog(a: number[], epsilon = 1e-10): number[] {
  return a.map((val) => Math.log(Math.max(val, epsilon)));
}

/**
 * Compute element-wise exp of a vector
 */
export function vectorExp(a: number[]): number[] {
  return a.map((val) => Math.exp(val));
}

/**
 * KL divergence (Kullback-Leibler divergence) between two distributions
 * D_KL(p || q) = sum(p_i * log(p_i / q_i))
 * Returns infinity if p and q have different support
 */
export function klDivergence(p: number[], q: number[], epsilon = 1e-10): number {
  if (p.length !== q.length) {
    throw new Error(
      `Distribution length mismatch: ${p.length.toString()} vs ${q.length.toString()}`
    );
  }

  let divergence = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i];
    const qi = q[i];

    if (pi === undefined || qi === undefined) continue;

    if (pi < -epsilon) {
      throw new Error('Negative probability in KL divergence');
    }

    if (pi > epsilon) {
      if (qi < epsilon) {
        return Infinity;
      }
      divergence += pi * Math.log(pi / qi);
    }
  }
  return divergence;
}

/**
 * Generalized KL divergence for non-normalized non-negative vectors:
 * D(p || q) = sum_i [ p_i * log(p_i / q_i) - p_i + q_i ]
 *
 * This is always non-negative for p_i, q_i >= 0 and equals standard KL
 * when p and q are both normalized probability distributions.
 */
export function generalizedKLDivergence(p: number[], q: number[], epsilon = 1e-10): number {
  if (p.length !== q.length) {
    throw new Error(
      `Distribution length mismatch: ${p.length.toString()} vs ${q.length.toString()}`
    );
  }

  let divergence = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i];
    const qi = q[i];
    if (pi === undefined || qi === undefined) continue;
    if (pi < -epsilon || qi < -epsilon) {
      throw new Error('Negative value in generalized KL divergence');
    }

    const safeP = Math.max(pi, epsilon);
    const safeQ = Math.max(qi, epsilon);
    divergence += safeP * Math.log(safeP / safeQ) - safeP + safeQ;
  }

  return divergence;
}

/**
 * Softmax function: converts logits to probabilities
 * softmax(x_i) = exp(x_i) / sum(exp(x_j))
 */
export function softmax(logits: number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - maxLogit));
  const sumExps = exps.reduce((sum, val) => sum + val, 0);
  return exps.map((exp) => exp / sumExps);
}

/**
 * Log-sum-exp trick for numerical stability
 * log(sum(exp(x_i))) = max(x) + log(sum(exp(x_i - max(x))))
 */
export function logSumExp(values: number[]): number {
  if (values.length === 0) {
    return -Infinity;
  }
  const maxVal = Math.max(...values);
  return maxVal + Math.log(values.reduce((sum, val) => sum + Math.exp(val - maxVal), 0));
}

/**
 * Clip values to a range [min, max]
 */
export function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clip all elements of a vector to a range
 */
export function vectorClip(a: number[], min: number, max: number): number[] {
  return a.map((val) => clip(val, min, max));
}

/**
 * Check if two numbers are approximately equal
 */
export function approxEqual(a: number, b: number, epsilon = 1e-10): boolean {
  return Math.abs(a - b) < epsilon;
}

/**
 * Check if two vectors are approximately equal
 */
export function vectorApproxEqual(a: number[], b: number[], epsilon = 1e-10): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((val, i) => {
    const bVal = b[i];
    if (bVal === undefined) return false;
    return approxEqual(val, bVal, epsilon);
  });
}

/**
 * Normalize a vector to sum to 1 (for probability distributions)
 */
export function normalizeToProbability(a: number[], epsilon = 1e-10): number[] {
  const sum = vectorSum(a);
  if (sum < epsilon) {
    // Return uniform distribution if sum is too small
    return a.map(() => 1 / a.length);
  }
  return a.map((val) => val / sum);
}

/**
 * Generate an array of zeros
 */
export function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

/**
 * Generate an array of ones
 */
export function ones(n: number): number[] {
  return new Array<number>(n).fill(1);
}

/**
 * Generate a range of numbers [start, end)
 */
export function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

/**
 * Compute the mean of an array
 */
export function mean(a: number[]): number {
  if (a.length === 0) {
    return 0;
  }
  return vectorSum(a) / a.length;
}

/**
 * Compute the standard deviation of an array
 */
export function std(a: number[]): number {
  if (a.length <= 1) {
    return 0;
  }
  const m = mean(a);
  const variance = a.reduce((sum, val) => sum + Math.pow(val - m, 2), 0) / (a.length - 1);
  return Math.sqrt(variance);
}

/**
 * Project a vector onto the probability simplex
 * Uses an efficient algorithm that preserves the sum = 1 constraint
 */
export function projectOntoSimplex(v: number[]): number[] {
  const n = v.length;
  if (n === 0) return [];

  // Sort in descending order
  const sorted = [...v].sort((a, b) => b - a);

  // Find the threshold (Duchi et al., 2008). rho is the largest index j (0-indexed)
  // for which u[j] > (sum_{k<=j} u[k] - 1) / (j + 1). lambda must use the partial sum
  // up to and including rho — NOT the total sum (the previous code used the running
  // total after the loop, which produced degenerate non-simplex projections).
  let cumsum = 0;
  let rho = 0;
  let rhoSum = 0;

  for (let i = 0; i < n; i++) {
    const sortedVal = sorted[i];
    if (sortedVal === undefined) continue;
    cumsum += sortedVal;
    if (sortedVal > (cumsum - 1) / (i + 1)) {
      rho = i;
      rhoSum = cumsum;
    }
  }

  const lambda = (rhoSum - 1) / (rho + 1);

  // Project
  return v.map((x) => Math.max(x - lambda, 0));
}
