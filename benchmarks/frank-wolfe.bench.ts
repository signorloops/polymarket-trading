/**
 * Frank-Wolfe algorithm benchmarks
 */

import { frankWolfe, linearMinimizationOracle } from '../src/core/frank-wolfe.js';
import { klDivergence } from '../src/utils/math.js';

function bench(name: string, fn: () => void, iterations = 100): void {
  // Warmup
  for (let i = 0; i < 10; i++) {
    fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const avg = (end - start) / iterations;
  console.log(`${name}: ${avg.toFixed(2)}ms avg (${iterations} iterations)`);
}

console.log('=== Frank-Wolfe Benchmarks ===\n');

// Simple 2D case
const theta2D = [0.6, 0.4];
const initial2D = [0.5, 0.5];

const objectiveFn2D = (mu: number[] | Float64Array) => klDivergence(Array.from(mu), theta2D);
const gradientFn2D = (mu: number[] | Float64Array) => {
  const epsilon = 1e-10;
  return Array.from(mu).map((m, i) => Math.log(Math.max(m, epsilon) / Math.max(theta2D[i]!, epsilon)) + 1);
};
const lmoFn2D = (grad: number[] | Float64Array): number[] => {
  const vertex = new Array(grad.length).fill(0);
  let minIdx = 0;
  let minValue = grad[0]!;
  for (let i = 1; i < grad.length; i++) {
    if (grad[i]! < minValue) {
      minValue = grad[i]!;
      minIdx = i;
    }
  }
  vertex[minIdx] = 1;
  return vertex;
};

bench('Frank-Wolfe 2D (50 iterations)', () => {
  frankWolfe(initial2D, objectiveFn2D, gradientFn2D, lmoFn2D, {
    maxIterations: 50,
    stepSize: 'adaptive',
  });
}, 100);

// 5D case
const theta5D = [0.3, 0.2, 0.2, 0.15, 0.15];
const initial5D = [0.2, 0.2, 0.2, 0.2, 0.2];

const objectiveFn5D = (mu: number[] | Float64Array) => klDivergence(Array.from(mu), theta5D);
const gradientFn5D = (mu: number[] | Float64Array) => {
  const epsilon = 1e-10;
  return Array.from(mu).map((m, i) => Math.log(Math.max(m, epsilon) / Math.max(theta5D[i]!, epsilon)) + 1);
};
const lmoFn5D = (grad: number[] | Float64Array): number[] => {
  const vertex = new Array(grad.length).fill(0);
  let minIdx = 0;
  let minValue = grad[0]!;
  for (let i = 1; i < grad.length; i++) {
    if (grad[i]! < minValue) {
      minValue = grad[i]!;
      minIdx = i;
    }
  }
  vertex[minIdx] = 1;
  return vertex;
};

bench('Frank-Wolfe 5D (100 iterations)', () => {
  frankWolfe(initial5D, objectiveFn5D, gradientFn5D, lmoFn5D, {
    maxIterations: 100,
    stepSize: 'adaptive',
  });
}, 50);

// LMO only
bench('Linear Minimization Oracle (5D)', () => {
  linearMinimizationOracle([0.1, 0.2, 0.3, 0.4, 0.5], []);
}, 100000);

console.log('\n=== Benchmarks Complete ===');
