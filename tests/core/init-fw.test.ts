/**
 * Unit tests for InitFW initialization algorithm
 */

import {
  initFW,
  storeWarmStart,
  getWarmStart,
  clearWarmStartCache,
  initFWBarrier,
} from '../../src/core/init-fw.js';
import { klDivergence } from '../../src/utils/math.js';

describe('InitFW', () => {
  beforeEach(() => {
    clearWarmStartCache();
  });

  describe('initFW', () => {
    it('should return a valid initialization', () => {
      const dimension = 3;
      const theta = [0.5, 0.3, 0.2];

      const gradientFn = (mu: number[]) =>
        mu.map((m, i) => Math.log(m / theta[i]!) + 1);
      const objectiveFn = (mu: number[]) => klDivergence(mu, theta);

      const result = initFW(dimension, gradientFn, objectiveFn);

      expect(result.initialPoint).toHaveLength(dimension);
      expect(result.initialPoint.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      expect(result.quality).toBeGreaterThanOrEqual(0);
      expect(['warm-start', 'uniform', 'vertex', 'gradient']).toContain(result.method);
    });

    it('should use warm-start when available', () => {
      const dimension = 3;
      const warmStart = [0.4, 0.4, 0.2];

      const gradientFn = (mu: number[]) => mu.map(() => 0);
      const objectiveFn = () => 0;

      const result = initFW(dimension, gradientFn, objectiveFn, { warmStart });

      expect(result.method).toBe('warm-start');
      expect(result.initialPoint).toEqual(warmStart);
    });

    it('should reject invalid warm-start', () => {
      const dimension = 3;
      const warmStart = [0.5, 0.5]; // Wrong dimension

      const gradientFn = (mu: number[]) => mu.map(() => 0);
      const objectiveFn = () => 0;

      const result = initFW(dimension, gradientFn, objectiveFn, { warmStart });

      expect(result.method).not.toBe('warm-start');
    });

    it('should reject negative warm-start values', () => {
      const dimension = 3;
      const warmStart = [-0.1, 0.6, 0.5]; // Has negative value

      const gradientFn = (mu: number[]) => mu.map(() => 0);
      const objectiveFn = () => 0;

      const result = initFW(dimension, gradientFn, objectiveFn, { warmStart });

      expect(result.method).not.toBe('warm-start');
    });
  });

  describe('warmStartCache', () => {
    it('should store and retrieve warm-start', () => {
      const key = 'test-key';
      const point = [0.3, 0.4, 0.3];

      storeWarmStart(key, point);
      const retrieved = getWarmStart(key);

      expect(retrieved).toEqual(point);
    });

    it('should return undefined for missing key', () => {
      const retrieved = getWarmStart('non-existent');

      expect(retrieved).toBeUndefined();
    });

    it('should clear all cache entries', () => {
      storeWarmStart('key1', [0.5, 0.5]);
      storeWarmStart('key2', [0.3, 0.7]);

      clearWarmStartCache();

      expect(getWarmStart('key1')).toBeUndefined();
      expect(getWarmStart('key2')).toBeUndefined();
    });
  });

  describe('initFWBarrier', () => {
    it('should return a valid initialization', () => {
      const dimension = 3;
      const epsilon = 0.1;
      const theta = [0.5, 0.3, 0.2];

      const gradientFn = (mu: number[], eps: number) =>
        mu.map((m, i) => Math.log(m / theta[i]!) + 1 + eps / (m + eps));
      const objectiveFn = (mu: number[], eps: number) =>
        klDivergence(mu, theta) - eps * mu.reduce((sum, m) => sum + Math.log(m + eps), 0);

      const result = initFWBarrier(dimension, gradientFn, objectiveFn, epsilon);

      expect(result.initialPoint).toHaveLength(dimension);
      expect(result.initialPoint.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      expect(result.quality).toBeGreaterThanOrEqual(0);
    });

    it('should handle small epsilon values', () => {
      const dimension = 2;
      const epsilon = 0.01;
      const theta = [0.6, 0.4];

      const gradientFn = (mu: number[], eps: number) =>
        mu.map((m, i) => Math.log(m / theta[i]!) + 1 + eps / (m + eps));
      const objectiveFn = (mu: number[], eps: number) =>
        klDivergence(mu, theta) - eps * mu.reduce((sum, m) => sum + Math.log(m + eps), 0);

      const result = initFWBarrier(dimension, gradientFn, objectiveFn, epsilon);

      expect(result.initialPoint).toHaveLength(dimension);
      expect(result.initialPoint.every((x) => x > 0)).toBe(true);
    });
  });
});
