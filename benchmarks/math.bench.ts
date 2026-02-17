/**
 * Math utilities benchmarks
 */

import {
  vectorAdd,
  vectorDot,
  vectorNorm,
  klDivergence,
  softmax,
  projectOntoSimplex,
} from '../src/utils/math.js';

// Simple benchmark runner
function bench(name: string, fn: () => void, iterations = 100000): void {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const avg = (end - start) / iterations;
  console.log(`${name}: ${avg.toFixed(4)}ms avg (${iterations} iterations)`);
}

console.log('=== Math Utilities Benchmarks ===\n');

// Vector operations
const vec1 = [1, 2, 3, 4, 5];
const vec2 = [5, 4, 3, 2, 1];

bench('vectorAdd (5 elements)', () => {
  vectorAdd(vec1, vec2);
});

bench('vectorDot (5 elements)', () => {
  vectorDot(vec1, vec2);
});

bench('vectorNorm (5 elements)', () => {
  vectorNorm(vec1);
});

// KL Divergence
const p = [0.2, 0.3, 0.3, 0.2];
const q = [0.25, 0.25, 0.25, 0.25];

bench('klDivergence (4 elements)', () => {
  klDivergence(p, q);
});

// Softmax
const logits = [1.0, 2.0, 3.0, 4.0, 5.0];

bench('softmax (5 elements)', () => {
  softmax(logits);
});

// Project onto simplex
const v = [0.1, 0.2, 0.3, 0.4];

bench('projectOntoSimplex (4 elements)', () => {
  projectOntoSimplex(v);
});

// Larger vectors
const largeVec1 = new Array(100).fill(0).map((_, i) => i / 100);
const largeVec2 = new Array(100).fill(0).map((_, i) => 1 - i / 100);

bench('vectorAdd (100 elements)', () => {
  vectorAdd(largeVec1, largeVec2);
}, 10000);

bench('vectorDot (100 elements)', () => {
  vectorDot(largeVec1, largeVec2);
}, 10000);

console.log('\n=== Benchmarks Complete ===');
