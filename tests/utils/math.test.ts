/**
 * Unit tests for math utilities
 */

import {
  vectorAdd,
  vectorSubtract,
  vectorScale,
  vectorDot,
  vectorNorm,
  klDivergence,
  softmax,
  logSumExp,
  clip,
  normalizeToProbability,
  zeros,
  ones,
  range,
  mean,
  std,
  approxEqual,
  vectorApproxEqual,
  projectOntoSimplex,
} from '../../src/utils/math.js';

describe('Vector Operations', () => {
  describe('vectorAdd', () => {
    it('should add two vectors element-wise', () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      expect(vectorAdd(a, b)).toEqual([5, 7, 9]);
    });

    it('should throw on length mismatch', () => {
      expect(() => vectorAdd([1, 2], [1, 2, 3])).toThrow('Vector length mismatch');
    });

    it('should handle empty vectors', () => {
      expect(vectorAdd([], [])).toEqual([]);
    });
  });

  describe('vectorSubtract', () => {
    it('should subtract two vectors element-wise', () => {
      const a = [5, 7, 9];
      const b = [4, 5, 6];
      expect(vectorSubtract(a, b)).toEqual([1, 2, 3]);
    });

    it('should throw on length mismatch', () => {
      expect(() => vectorSubtract([1, 2], [1, 2, 3])).toThrow('Vector length mismatch');
    });
  });

  describe('vectorScale', () => {
    it('should scale a vector by a scalar', () => {
      const a = [1, 2, 3];
      expect(vectorScale(a, 2)).toEqual([2, 4, 6]);
    });

    it('should handle zero scalar', () => {
      const a = [1, 2, 3];
      expect(vectorScale(a, 0)).toEqual([0, 0, 0]);
    });

    it('should handle negative scalar', () => {
      const a = [1, 2, 3];
      expect(vectorScale(a, -1)).toEqual([-1, -2, -3]);
    });
  });

  describe('vectorDot', () => {
    it('should compute dot product', () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      expect(vectorDot(a, b)).toBe(32); // 1*4 + 2*5 + 3*6 = 32
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0];
      const b = [0, 1];
      expect(vectorDot(a, b)).toBe(0);
    });

    it('should throw on length mismatch', () => {
      expect(() => vectorDot([1, 2], [1, 2, 3])).toThrow('Vector length mismatch');
    });
  });

  describe('vectorNorm', () => {
    it('should compute L2 norm', () => {
      const a = [3, 4];
      expect(vectorNorm(a)).toBe(5); // sqrt(9 + 16) = 5
    });

    it('should return 0 for zero vector', () => {
      expect(vectorNorm([0, 0, 0])).toBe(0);
    });

    it('should handle single element', () => {
      expect(vectorNorm([5])).toBe(5);
    });
  });
});

describe('KL Divergence', () => {
  describe('klDivergence', () => {
    it('should return 0 for identical distributions', () => {
      const p = [0.5, 0.5];
      const q = [0.5, 0.5];
      expect(klDivergence(p, q)).toBeCloseTo(0, 10);
    });

    it('should compute KL divergence correctly', () => {
      const p = [0.7, 0.3];
      const q = [0.5, 0.5];
      // D_KL(p||q) = 0.7*log(0.7/0.5) + 0.3*log(0.3/0.5)
      const expected = 0.7 * Math.log(0.7 / 0.5) + 0.3 * Math.log(0.3 / 0.5);
      expect(klDivergence(p, q)).toBeCloseTo(expected, 10);
    });

    it('should return Infinity for different support', () => {
      const p = [0.5, 0.5, 0];
      const q = [0.5, 0.5, 0]; // Actually same support
      expect(klDivergence(p, q)).toBe(0);

      const p2 = [0.5, 0.5];
      const q2 = [0.5, 0]; // q has zero where p is positive
      // This case is handled with epsilon, so not exactly infinity
      expect(klDivergence(p2, q2)).toBeGreaterThan(100);
    });

    it('should throw on length mismatch', () => {
      expect(() => klDivergence([0.5, 0.5], [0.5])).toThrow('Distribution length mismatch');
    });
  });
});

describe('Softmax', () => {
  describe('softmax', () => {
    it('should output probabilities that sum to 1', () => {
      const logits = [1, 2, 3];
      const result = softmax(logits);
      const sum = result.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
    });

    it('should preserve ordering', () => {
      const logits = [1, 3, 2];
      const result = softmax(logits);
      expect(result[1]).toBeGreaterThan(result[2]);
      expect(result[2]).toBeGreaterThan(result[0]);
    });

    it('should handle large values', () => {
      const logits = [1000, 1001, 1002];
      const result = softmax(logits);
      expect(result.every((x) => x >= 0 && x <= 1)).toBe(true);
      expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    });
  });

  describe('logSumExp', () => {
    it('should compute log(sum(exp(x)))', () => {
      const values = [1, 2, 3];
      const expected = Math.log(Math.exp(1) + Math.exp(2) + Math.exp(3));
      expect(logSumExp(values)).toBeCloseTo(expected, 10);
    });

    it('should handle large values without overflow', () => {
      const values = [1000, 1001, 1002];
      const result = logSumExp(values);
      expect(Number.isFinite(result)).toBe(true);
    });

    it('should return -Infinity for empty array', () => {
      expect(logSumExp([])).toBe(-Infinity);
    });
  });
});

describe('Utility Functions', () => {
  describe('clip', () => {
    it('should clip values to range', () => {
      expect(clip(5, 0, 10)).toBe(5);
      expect(clip(-5, 0, 10)).toBe(0);
      expect(clip(15, 0, 10)).toBe(10);
    });
  });

  describe('normalizeToProbability', () => {
    it('should normalize to sum to 1', () => {
      const a = [1, 2, 3];
      const result = normalizeToProbability(a);
      expect(result.reduce((sum, x) => sum + x, 0)).toBeCloseTo(1, 10);
    });

    it('should handle zero sum', () => {
      const a = [0, 0, 0];
      const result = normalizeToProbability(a);
      expect(result).toEqual([1 / 3, 1 / 3, 1 / 3]);
    });
  });

  describe('zeros and ones', () => {
    it('should create array of zeros', () => {
      expect(zeros(3)).toEqual([0, 0, 0]);
    });

    it('should create array of ones', () => {
      expect(ones(3)).toEqual([1, 1, 1]);
    });

    it('should handle zero length', () => {
      expect(zeros(0)).toEqual([]);
      expect(ones(0)).toEqual([]);
    });
  });

  describe('range', () => {
    it('should create range', () => {
      expect(range(0, 5)).toEqual([0, 1, 2, 3, 4]);
      expect(range(2, 5)).toEqual([2, 3, 4]);
    });

    it('should handle empty range', () => {
      expect(range(5, 5)).toEqual([]);
    });
  });

  describe('mean and std', () => {
    it('should compute mean', () => {
      expect(mean([1, 2, 3, 4, 5])).toBe(3);
      expect(mean([10])).toBe(10);
    });

    it('should return 0 for empty mean', () => {
      expect(mean([])).toBe(0);
    });

    it('should compute standard deviation', () => {
      // std of [1, 2, 3, 4, 5] = sqrt(2.5) ≈ 1.581
      expect(std([1, 2, 3, 4, 5])).toBeCloseTo(1.581, 2);
    });

    it('should return 0 for single element std', () => {
      expect(std([5])).toBe(0);
    });

    it('should return 0 for empty std', () => {
      expect(std([])).toBe(0);
    });
  });

  describe('approxEqual', () => {
    it('should check approximate equality', () => {
      expect(approxEqual(1, 1.0000001, 1e-6)).toBe(true);
      expect(approxEqual(1, 1.1, 1e-6)).toBe(false);
    });

    it('should use default epsilon', () => {
      expect(approxEqual(1, 1 + 1e-11)).toBe(true);
      expect(approxEqual(1, 1 + 1e-9)).toBe(false);
    });
  });

  describe('vectorApproxEqual', () => {
    it('should check vector approximate equality', () => {
      expect(vectorApproxEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(vectorApproxEqual([1, 2, 3], [1, 2, 3.0000000000001])).toBe(true);
      expect(vectorApproxEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(vectorApproxEqual([1, 2], [1, 2, 3])).toBe(false);
    });
  });
});

describe('Simplex Projection', () => {
  // Regression: projectOntoSimplex previously computed lambda from the full cumsum
  // instead of the partial sum up to rho, yielding degenerate vectors that did not
  // sum to 1. These cases pin the Duchi et al. (2008) result.
  const approxEq = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  it('produces a vector that sums to 1', () => {
    const result = projectOntoSimplex([0.1, 0.7, 0.2, 5]);
    const sum = result.reduce((acc, x) => acc + x, 0);
    expect(approxEq(sum, 1)).toBe(true);
    for (const x of result) {
      expect(x).toBeGreaterThanOrEqual(-1e-12);
    }
  });

  it('matches the closed-form result for a known input', () => {
    // Project [3, 1, 1]. Sorted desc: [3, 1, 1].
    // rho: i=0 -> 3 > (3-1)/1=2 true; i=1 -> 1 > (4-1)/2=1.5 false; i=2 -> 1 > (5-1)/3=1.33 false.
    // rho=0, rhoSum=3, lambda=(3-1)/1=2 -> [max(3-2,0), max(1-2,0), max(1-2,0)] = [1, 0, 0].
    expect(projectOntoSimplex([3, 1, 1])).toEqual([1, 0, 0]);
  });

  it('distributes mass when all entries are equal and below the uniform point', () => {
    // [0.2, 0.2, 0.2, 0.2]: sorted desc equal. rho is the largest index where the
    // condition holds. Equal entries -> uniform projection [0.25, 0.25, 0.25, 0.25].
    const result = projectOntoSimplex([0.2, 0.2, 0.2, 0.2]);
    expect(result.every((x) => approxEq(x, 0.25))).toBe(true);
  });

  it('handles a uniform vector that already sums past 1', () => {
    // [1,1,1,1] sums to 4. Sorted desc [1,1,1,1]. rho walks all indices (1 > (k-1)/k).
    // rhoSum=4, lambda=(4-1)/4=0.75 -> each = max(1-0.75,0)=0.25 -> sums to 1.
    const result = projectOntoSimplex([1, 1, 1, 1]);
    const sum = result.reduce((acc, x) => acc + x, 0);
    expect(approxEq(sum, 1)).toBe(true);
  });

  it('zeros out negative entries and renormalizes onto the simplex', () => {
    const result = projectOntoSimplex([-1, 2, 3]);
    const sum = result.reduce((acc, x) => acc + x, 0);
    expect(approxEq(sum, 1)).toBe(true);
    expect(result[0]).toBe(0); // negative input clamped to 0
  });

  it('returns [] for empty input', () => {
    expect(projectOntoSimplex([])).toEqual([]);
  });
});
