import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  calculatePercentile,
  calculatePercentiles,
  calculateHistogramPercentiles,
  LatencyBuffer,
} from '../../src/utils/percentile.js';

describe('calculatePercentile', () => {
  it('should calculate median (p50) correctly', () => {
    const values = [1, 2, 3, 4, 5];
    expect(calculatePercentile(values, 50)).toBe(3);
  });

  it('should calculate p95 correctly', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const p95 = calculatePercentile(values, 95);
    expect(p95).toBeGreaterThanOrEqual(19);
    expect(p95).toBeLessThanOrEqual(20);
  });

  it('should return 0 for empty array', () => {
    expect(calculatePercentile([], 50)).toBe(0);
  });

  it('should handle single value', () => {
    expect(calculatePercentile([42], 50)).toBe(42);
  });

  it('should handle p0 (minimum)', () => {
    const values = [5, 2, 8, 1, 9];
    expect(calculatePercentile(values, 0)).toBe(1);
  });

  it('should handle p100 (maximum)', () => {
    const values = [5, 2, 8, 1, 9];
    expect(calculatePercentile(values, 100)).toBe(9);
  });

  it('should throw error for invalid percentile', () => {
    expect(() => calculatePercentile([1, 2, 3], -1)).toThrow();
    expect(() => calculatePercentile([1, 2, 3], 101)).toThrow();
  });

  it('should use linear interpolation', () => {
    const values = [10, 20, 30, 40];
    // p25 should be between 10 and 20
    const p25 = calculatePercentile(values, 25);
    expect(p25).toBeGreaterThan(10);
    expect(p25).toBeLessThan(20);
  });
});

describe('calculatePercentiles', () => {
  it('should calculate multiple percentiles at once', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = calculatePercentiles(values, [50, 90, 99]);

    expect(result.p50).toBeDefined();
    expect(result.p90).toBeDefined();
    expect(result.p99).toBeDefined();
    expect(result.p50).toBeGreaterThanOrEqual(5);
    expect(result.p90).toBeGreaterThanOrEqual(9);
  });

  it('should return empty object for empty percentiles array', () => {
    const values = [1, 2, 3];
    const result = calculatePercentiles(values, []);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('calculateHistogramPercentiles', () => {
  it('should calculate percentiles from histogram buckets', () => {
    const buckets = [
      { value: 10, count: 10 },
      { value: 50, count: 20 },
      { value: 100, count: 30 },
      { value: 500, count: 40 },
    ];

    const result = calculateHistogramPercentiles(buckets, [50, 95]);

    expect(result.p50).toBeDefined();
    expect(result.p95).toBeDefined();
    expect(result.p50).toBeGreaterThanOrEqual(10);
  });

  it('should return zeros for empty buckets', () => {
    const result = calculateHistogramPercentiles([], [50, 95, 99]);
    expect(result.p50).toBe(0);
    expect(result.p95).toBe(0);
    expect(result.p99).toBe(0);
  });

  it('should handle zero total count', () => {
    const buckets = [
      { value: 10, count: 0 },
      { value: 50, count: 0 },
    ];

    const result = calculateHistogramPercentiles(buckets, [50]);
    expect(result.p50).toBe(0);
  });
});

describe('LatencyBuffer', () => {
  let buffer: LatencyBuffer;

  beforeEach(() => {
    buffer = new LatencyBuffer(100);
  });

  it('should add values and calculate percentiles', () => {
    buffer.add(10);
    buffer.add(20);
    buffer.add(30);

    const percentiles = buffer.getPercentiles([50]);
    expect(percentiles.p50).toBe(20);
  });

  it('should maintain max size limit', () => {
    const smallBuffer = new LatencyBuffer(5);

    for (let i = 0; i < 10; i++) {
      smallBuffer.add(i);
    }

    expect(smallBuffer.getValues()).toHaveLength(5);
    expect(smallBuffer.getValues()).toEqual([5, 6, 7, 8, 9]);
  });

  it('should return stats correctly', () => {
    buffer.add(10);
    buffer.add(20);
    buffer.add(30);

    const stats = buffer.getStats();
    expect(stats.count).toBe(3);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
    expect(stats.mean).toBe(20);
  });

  it('should return zero stats for empty buffer', () => {
    const stats = buffer.getStats();
    expect(stats.count).toBe(0);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.mean).toBe(0);
  });

  it('should clear all values', () => {
    buffer.add(10);
    buffer.add(20);

    buffer.clear();

    expect(buffer.getValues()).toHaveLength(0);
    expect(buffer.getStats().count).toBe(0);
  });
});
