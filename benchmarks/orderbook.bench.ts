/**
 * Order book benchmarks
 */

import { OrderBook } from '../src/market/order-book.js';

function bench(name: string, fn: () => void, iterations = 100000): void {
  // Warmup
  for (let i = 0; i < 100; i++) {
    fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const avg = (end - start) / iterations;
  console.log(`${name}: ${avg.toFixed(4)}ms avg (${iterations} iterations)`);
}

console.log('=== Order Book Benchmarks ===\n');

// Create order book with sample data
const book = new OrderBook('test-market');

// Setup with initial data
const bids = Array.from({ length: 20 }, (_, i) => ({
  price: 0.6 - i * 0.01,
  size: 1000 + i * 100,
}));

const asks = Array.from({ length: 20 }, (_, i) => ({
  price: 0.7 + i * 0.01,
  size: 1000 + i * 100,
}));

book.update(bids, asks);

bench('Get best bid', () => {
  book.getBestBid();
});

bench('Get best ask', () => {
  book.getBestAsk();
});

bench('Get mid price', () => {
  book.getMidPrice();
});

bench('Get spread', () => {
  book.getSpread();
});

bench('Calculate VWAP (small order)', () => {
  book.calculateVWAP(500, 'buy');
});

bench('Calculate VWAP (large order)', () => {
  book.calculateVWAP(5000, 'buy');
});

bench('Calculate slippage', () => {
  book.calculateSlippage(1000, 'buy');
});

bench('Get liquidity metrics', () => {
  book.getLiquidityMetrics();
});

// Update benchmarks
const updateBids = [{ price: 0.55, size: 500 }];
const updateAsks = [{ price: 0.75, size: 500 }];

bench('Update order book', () => {
  book.update(updateBids, updateAsks);
}, 10000);

console.log('\n=== Benchmarks Complete ===');
