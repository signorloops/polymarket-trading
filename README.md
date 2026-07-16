# Polymarket Arbitrage Trading System

English (Default) | [中文](./README.zh-CN.md)

An arbitrage research and paper-trading system built on the Marginal Polytope and Frank-Wolfe optimization algorithm.

## Project Status

[![CI](https://github.com/signorloops/polymarket-trading/actions/workflows/ci.yml/badge.svg)](https://github.com/signorloops/polymarket-trading/actions/workflows/ci.yml)
[![Security](https://github.com/signorloops/polymarket-trading/actions/workflows/security.yml/badge.svg)](https://github.com/signorloops/polymarket-trading/actions/workflows/security.yml)

- ✅ **Code quality**: ESLint with 0 errors, TypeScript strict mode
- ✅ **Automated verification**: Type checking, lint, formatting, dead-code checks, tests, build and smoke tests run in CI
- ✅ **Performance tooling**: Dedicated benchmarks for the math, optimizer and order-book paths
- ✅ **Documentation**: API docs, architecture guide, deployment guide

## Core Features

- **Auditable opportunity detection**: Executable single-market covers use fresh order-book depth and fees; cross-market USD opportunities require explicit exhaustive payoff scenarios
- **Bregman projection**: Compute optimal trade vectors using KL / generalized KL divergence
- **Frank-Wolfe algorithm**: Real-objective line search (golden-section) with feasible constrained updates
- **Real-time data processing**: WebSocket data pipeline and order book reconstruction (SkipList, O(log n))
- **Upgraded optimization solvers**: LP/MILP backed by `javascript-lp-solver` with feasibility validation
- **Risk management**: Circuit breakers, position limits, and partial-fill handling
- **High performance**: Float64Array memory pooling and sparse-constraint processing

## Documentation

- `docs/core-algorithm-theory-guide.md`: Full derivation and code walkthrough of core algorithms
- `docs/mermaid-learning-guide.md`: Mermaid-based learning path for this project
- `docs/architecture.md`: System architecture and module responsibilities
- `docs/api.md`: API reference
- `docs/deployment.md`: Deployment guide

## System Architecture

```text
src/
├── core/                     # Core algorithms
│   ├── marginal-polytope.ts  # Marginal polytope computation
│   ├── bregman-projection.ts # Bregman projection
│   ├── frank-wolfe.ts        # Frank-Wolfe algorithm
│   └── init-fw.ts            # Initialization logic
├── market/                   # Market data processing
│   ├── data-pipeline.ts      # WebSocket data pipeline
│   ├── order-book.ts         # Order book analytics
│   ├── arbitrage-detector.ts # Arbitrage detector
│   └── dependency-graph.ts   # Market dependency graph
├── execution/                # Trade execution
│   ├── execution-engine.ts   # Execution engine
│   ├── position-sizing.ts    # Position sizing
│   └── risk-manager.ts       # Risk management
├── optimization/             # Optimization solvers
│   ├── lp-solver.ts          # Linear programming solver
│   └── ip-solver.ts          # Integer programming solver
└── utils/                    # Utilities
    ├── math.ts               # Math helpers
    ├── logger.ts             # Logging
    └── config.ts             # Config management
```

## Installation

```bash
# Clone repository
git clone <repository-url>
cd polymarket-trading

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env and provide your API keys/config
```

## Configuration

Configure the following variables in `.env`:

```env
# Network
RPC_URL= # optional legacy Polygon transaction tracker
WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_api_secret
POLYMARKET_PASSPHRASE=your_api_passphrase
POLYMARKET_CHAIN_ID=137
POLYMARKET_SIGNATURE_TYPE=0 # 0=EOA, 1=proxy, 2=Gnosis Safe, 3=EIP-1271
POLYMARKET_FUNDER_ADDRESS=

# Wallet
PRIVATE_KEY= # signed CLOB adapter available; live orchestration remains disabled by default
WALLET_ADDRESS=your_wallet_address

# Algorithm parameters
ALPHA=0.9
INITIAL_EPSILON=0.1
MAX_ITERATIONS=150
MIN_PROFIT_THRESHOLD=0.05 # dimensionless KL diagnostic threshold, not USD profit

# Trading parameters
MAX_POSITION_PCT=0.5
SLIPPAGE_TOLERANCE=0.02
MAX_CONCURRENT_TRADES=5

# Risk management
MAX_DAILY_LOSS=1000
MAX_EXPOSURE=10000
EMERGENCY_STOP_THRESHOLD=500
```

## Manual Canary Trade

`npm run canary:trade` is a single-order canary entrypoint. It defaults to dry-run and does not enable automatic live trading.

Real submission requires all gates:

```env
CANARY_TOKEN_ID=1234567890
CANARY_SIDE=buy
CANARY_SIZE=1
CANARY_PRICE=0.01
CANARY_MAX_NOTIONAL_USD=5
CANARY_DRY_RUN=false
CANARY_TRADING_ENABLED=true
CANARY_CONFIRMATION=PLACE_ONE_REAL_POLYMARKET_CANARY_ORDER
CANARY_STATE_PATH=.state/canary-trades.json
CANARY_KILL_SWITCH_PATH=.state/canary-kill-switch.json
```

The canary CLI persists intent before submission and fails closed on ambiguous outcomes. A missing kill-switch file blocks real submission: run `npm run canary:kill-switch -- deactivate` explicitly only for the reviewed canary window. Preflight checks require exchange status, balance/allowance and heartbeat support. Partial fills, filled canaries and unresolved outcomes are marked for manual reconciliation.
`npm run canary:kill-switch -- activate "reason"` blocks future real canary submissions, and `npm run canary:cancel-all` attempts to cancel all non-terminal canary orders from the persisted state file.

Automatic live trading is still blocked. See the [live-trading readiness gate](docs/live-trading-readiness.md) for the canary, reconciliation, persistent idempotency, payoff-model and multi-leg atomicity status.

## Runtime Config CLI

Generate a daemon config from the built-in template:

```bash
npm run runtime-config:generate -- ./config/trading-system.json
```

Validate a daemon config before startup:

```bash
npm run runtime-config:validate -- ./config/trading-system.json
```

Smoke-test the built daemon process and Docker image before shipping:

```bash
npm run smoke:daemon
npm run smoke:docker
```

## Usage

### Basic Usage

```typescript
import { PolymarketTradingSystem } from './src/index.js';

const config = {
  liveTrading: false, // live trading is currently disabled by safety guard
  markets: [],
  events: [
    {
      id: 'event-1',
      markets: [
        { id: 'market-yes', outcome: 'YES', price: 0.6 },
        { id: 'market-no', outcome: 'NO', price: 0.4 },
      ],
    },
  ],
};

const system = new PolymarketTradingSystem(config);
system.initialize();
system.start();
```

### Run a Detection Cycle

```typescript
// Run one arbitrage detection cycle
const opportunities = system.runDetectionCycle();
console.log(`Found ${opportunities.length} arbitrage opportunities`);

// Execute opportunities
for (const opp of opportunities) {
  if (opp.guaranteedProfit > 0.05) {
    system.executeOpportunity(opp);
  }
}
```

## Core Algorithms

### Frank-Wolfe Optimization

```typescript
import { frankWolfe, linearMinimizationOracle } from './src/core/frank-wolfe.js';

const result = frankWolfe(
  initialPoint,
  objectiveFn, // objective function (e.g. KL divergence)
  gradientFn, // gradient function
  lmoFn, // linear minimization oracle
  { maxIterations: 150, tolerance: 1e-6 }
);

console.log(`Optimal solution: ${result.mu}`);
console.log(`Objective value: ${result.objective}`);
console.log(`Gap: ${result.gap}`);
```

### Recent Algorithm Improvements (2026-02-20)

- **Frank-Wolfe feasibility fix**: Removed in-loop global simplex projection that broke independent equality constraints across events.
- **Step-size upgrade**: `line-search` now performs golden-section search on the true objective along the `mu -> s` segment.
- **Barrier convergence fix**: Convergence condition now explicitly includes `tolerance`, preventing premature stopping.
- **Cross-market constraint consistency**: `MarketDependencyGraph.addMarket()` now auto-completes event nodes so event constraints are never dropped when building matrices.
- **Cross-market objective correction**: Cross-market strategy and detector now consistently use generalized KL (for non-normalized non-negative vectors).
- **Order-book hot-path optimization**: `OrderBook` now uses SkipList + incrementally maintained depth for O(1) best bid/ask lookup.
- **Solver capability upgrade**: `LP/IP` interfaces integrated with `javascript-lp-solver`, while retaining input validation, feasibility checks, and branch-and-bound fallback paths.

### Bregman Projection

```typescript
import { bregmanProjection } from './src/core/bregman-projection.js';

const result = bregmanProjection(
  priceVector, // current market prices
  constraints, // polytope constraints
  maxIterations,
  tolerance
);

console.log(`Projection: ${result.projection}`);
console.log(`Divergence: ${result.divergence}`);
```

### Position Sizing

```typescript
import { calculatePositionSize } from './src/execution/position-sizing.js';

const result = calculatePositionSize({
  probability: 0.6, // win probability
  price: 0.5, // market price
  capital: 10000, // available capital
  orderBook, // order book
  side: 'buy', // trade direction
});

console.log(`Recommended size: ${result.size}`);
console.log(`Capital fraction: ${result.fraction}`);
```

## Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run a specific test file
npm test -- tests/core/frank-wolfe.test.ts
```

## Development

```bash
# Type check
npm run typecheck

# Lint
npm run lint

# Format
npm run format

# Build
npm run build

# Dev mode (watch)
npm run dev
```

## Mathematical Background

### Marginal Polytope

The marginal polytope M is the convex hull of valid payoff vectors. For binary event markets, it encodes probability constraints:

```text
YES + NO = 1
YES >= 0, NO >= 0
```

### Bregman Divergence

For normalized distributions, use KL divergence:

```text
D_KL(mu || theta) = Σ mu_i * log(mu_i / theta_i)
```

For cross-market non-normalized vectors, use generalized KL divergence:

```text
D(mu || theta) = Σ [ mu_i * log(mu_i / theta_i) - mu_i + theta_i ]
```

Where `mu` is the projected point and `theta` is the price vector.

### Frank-Wolfe Update Rule

```text
mu_{t+1} = (1 - gamma) * mu_t + gamma * s_t
```

Where `s_t` is the vertex returned by the linear minimization oracle, and `gamma` is the step size.

### Modified Kelly Criterion

```text
f = (b*p - q) / b * sqrt(p)
```

Where:

- `f` = capital fraction
- `b` = odds
- `p` = win probability
- `q` = 1 - p

## Risk Disclaimer

**Warning**: Trading involves risk and may result in capital loss.

- Trading suggestions from this system are not financial advice
- Always paper trade before going live
- Understand smart contract risk and non-atomic execution risk
- Monitor slippage and liquidity conditions
- Set proper stop-loss and position limits

## License

MIT

## Contributing

Issues and pull requests are welcome.

## Performance Benchmarks

### Algorithm Performance

```text
Frank-Wolfe 2D (50 iterations):    0.10ms avg
Frank-Wolfe 5D (100 iterations):   0.28ms avg
Linear Minimization Oracle (5D):   0.00ms avg (100K iterations)
```

### Order Book Operations (SkipList-optimized)

```text
Get best bid/ask:                  0.001ms avg
Get mid price:                     0.003ms avg
Calculate VWAP:                    0.001ms avg
Update order book:                 0.0002ms avg
```

### Memory Optimizations

- **Float64Array object pool**: Reuses buffers to reduce GC pressure
- **Sparse constraints**: Stores only non-zero coefficients, reducing memory usage by 60%+
- **SkipList data structure**: O(log n) insert/delete, ~10x faster than sorted arrays

## Docker Deployment

### Build Image

```bash
docker build -t polymarket-trading .
```

### Run Container

```bash
mkdir -p .secrets
openssl rand -hex 32 > .secrets/metrics-token
docker run -d \
  --name polymarket-trading \
  --env-file .env \
  -e HTTP_HOST=0.0.0.0 \
  -e HTTP_METRICS_TOKEN_FILE=/run/secrets/metrics-token \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/.secrets/metrics-token:/run/secrets/metrics-token:ro \
  --mount source=polymarket-state,target=/app/.state \
  -p 127.0.0.1:3000:3000 \
  polymarket-trading
```

### Docker Compose

```bash
mkdir -p .secrets
openssl rand -hex 32 > .secrets/metrics-token
openssl rand -hex 32 > .secrets/grafana-admin-password
docker compose --profile monitoring up -d
```

Includes:

- trading service
- Prometheus monitoring
- Grafana dashboard

## Monitoring and Logging

### Prometheus Metrics

- `trading_arbitrage_opportunities_total`: recorded opportunities
- `trading_orders_submitted_total`: submitted orders
- `trading_position_size`: current position size
- `trading_position_pnl`: unrealized position P&L
- `trading_total_exposure`: current total exposure

### Grafana Dashboard

Trading daemon endpoints:

- `http://localhost:3000/health`
- `http://localhost:3000/ready`
- `http://localhost:3000/metrics` (Bearer auth is mandatory when binding outside loopback)
- `http://localhost:3000/api/risk/status` (hidden unless `HTTP_RISK_STATUS_TOKEN` is set;
  send it as `Authorization: Bearer <token>`)

Grafana dashboard:

- `http://localhost:3001`

### Log Levels

```bash
# Development
LOG_LEVEL=debug npm run dev

# Production
npm run build
TRADING_SYSTEM_CONFIG_PATH=./config/trading-system.example.json LOG_LEVEL=warn npm start
```

## Changelog

### v1.0.0 (2026-02-17)

- ✅ Completed ESLint fixes (401 -> 0)
- ✅ Completed API integration (Polymarket REST + WebSocket)
- ✅ Refactored code (frank-wolfe.ts 414 lines -> 242 lines)
- ✅ Performance optimizations (SkipList, Float64ArrayPool, sparse constraints)
- ✅ Added automated tests and CI quality gates
- ✅ Added Docker support
- ✅ Added Prometheus/Grafana monitoring

## API Documentation

See [docs/api.md](./docs/api.md).

## Mermaid Learning Guide

See [docs/mermaid-learning-guide.md](./docs/mermaid-learning-guide.md).

## References

1. "Arbitrage in Prediction Markets" - marginal polytope theory foundations
2. "Frank-Wolfe Algorithms for Prediction Market Aggregation"
3. "Bregman Projection for Arbitrage Detection"
