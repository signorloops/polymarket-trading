/**
 * Metrics Tests
 */

import {
  Counter,
  Gauge,
  Histogram,
  getRegistry,
  TradingMetrics,
  recordTrade,
  recordArbitrage,
  getMetricsForScraping,
} from '../../src/utils/metrics.js';

describe('Counter', () => {
  let counter: Counter;

  beforeEach(() => {
    counter = new Counter('test_counter', 'Test counter');
  });

  it('should increment by 1 by default', () => {
    counter.inc();
    expect(counter.get()).toBe(1);
  });

  it('should increment by specified value', () => {
    counter.inc({}, 5);
    expect(counter.get()).toBe(5);
  });

  it('should accumulate values', () => {
    counter.inc({}, 2);
    counter.inc({}, 3);
    expect(counter.get()).toBe(5);
  });

  it('should handle labels', () => {
    counter.inc({ method: 'GET' }, 1);
    counter.inc({ method: 'POST' }, 2);

    expect(counter.get({ method: 'GET' })).toBe(1);
    expect(counter.get({ method: 'POST' })).toBe(2);
  });

  it('should output prometheus format', () => {
    counter.inc({ method: 'GET' }, 5);
    const output = counter.toPrometheusFormat();

    expect(output).toContain('# HELP test_counter Test counter');
    expect(output).toContain('# TYPE test_counter counter');
    expect(output).toContain('test_counter{method="GET"} 5');
  });
});

describe('Gauge', () => {
  let gauge: Gauge;

  beforeEach(() => {
    gauge = new Gauge('test_gauge', 'Test gauge');
  });

  it('should set value', () => {
    gauge.set({}, 42);
    expect(gauge.get()).toBe(42);
  });

  it('should increment', () => {
    gauge.set({}, 10);
    gauge.inc({}, 5);
    expect(gauge.get()).toBe(15);
  });

  it('should decrement', () => {
    gauge.set({}, 10);
    gauge.dec({}, 3);
    expect(gauge.get()).toBe(7);
  });

  it('should handle negative values', () => {
    gauge.set({}, -5);
    expect(gauge.get()).toBe(-5);
  });
});

describe('Histogram', () => {
  let histogram: Histogram;

  beforeEach(() => {
    histogram = new Histogram('test_histogram', 'Test histogram', [0.1, 0.5, 1.0, 2.0]);
  });

  it('should observe values', () => {
    histogram.observe({}, 0.5);
    histogram.observe({}, 1.5);

    const output = histogram.toPrometheusFormat();
    expect(output).toContain('test_histogram_bucket');
  });

  it('should count values in buckets', () => {
    histogram.observe({}, 0.05);
    histogram.observe({}, 0.3);
    histogram.observe({}, 1.5);

    const output = histogram.toPrometheusFormat();
    expect(output).toContain('test_histogram_count');
    expect(output).toContain('test_histogram_sum');
  });

  it('should handle +Inf bucket', () => {
    histogram.observe({}, 10.0);

    const output = histogram.toPrometheusFormat();
    expect(output).toContain('le="+Inf"');
  });
});

describe('Registry', () => {
  beforeEach(() => {
    getRegistry().clear();
  });

  afterEach(() => {
    // Re-register trading metrics
    Object.values(TradingMetrics).forEach((metric) => getRegistry().register(metric));
  });

  it('should register metrics', () => {
    const counter = new Counter('reg_counter', 'Registered counter');
    getRegistry().register(counter);

    expect(getRegistry().get('reg_counter')).toBe(counter);
  });

  it('should output all metrics', () => {
    const counter = new Counter('all_counter', 'All counter');
    counter.inc({}, 1);
    getRegistry().register(counter);

    const output = getMetricsForScraping();
    expect(output).toContain('all_counter');
  });
});

describe('recordTrade', () => {
  beforeEach(() => {
    // Reset metrics
    TradingMetrics.ordersSubmitted = new Counter('trading_orders_submitted_total', 'Total number of orders submitted');
    TradingMetrics.ordersFilled = new Counter('trading_orders_filled_total', 'Total number of orders filled');
    TradingMetrics.ordersFailed = new Counter('trading_orders_failed_total', 'Total number of orders that failed');
    TradingMetrics.orderExecutionTime = new Histogram('trading_order_execution_seconds', 'Order execution time in seconds', [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]);
  });

  it('should record successful trade', () => {
    recordTrade('market-1', 'buy', 100, 0.5, 50, true);

    expect(TradingMetrics.ordersSubmitted.get({ market_id: 'market-1', side: 'buy' })).toBe(1);
    expect(TradingMetrics.ordersFilled.get({ market_id: 'market-1', side: 'buy' })).toBe(1);
  });

  it('should record failed trade', () => {
    recordTrade('market-1', 'sell', 50, 0.6, 100, false);

    expect(TradingMetrics.ordersSubmitted.get({ market_id: 'market-1', side: 'sell' })).toBe(1);
    expect(TradingMetrics.ordersFailed.get({ market_id: 'market-1', side: 'sell' })).toBe(1);
  });
});

describe('recordArbitrage', () => {
  beforeEach(() => {
    TradingMetrics.arbitrageOpportunitiesFound = new Counter('trading_arbitrage_opportunities_total', 'Total arbitrage opportunities detected');
    TradingMetrics.arbitrageExecuted = new Counter('trading_arbitrage_executed_total', 'Successful arbitrage executions');
    TradingMetrics.arbitrageProfit = new Counter('trading_arbitrage_profit_total', 'Total profit from arbitrage (USD)');
  });

  it('should record found opportunity', () => {
    recordArbitrage('event-1', 0.05, false);

    expect(TradingMetrics.arbitrageOpportunitiesFound.get({ event_id: 'event-1' })).toBe(1);
  });

  it('should record executed arbitrage', () => {
    recordArbitrage('event-1', 0.05, true, 0.03);

    expect(TradingMetrics.arbitrageExecuted.get({ event_id: 'event-1' })).toBe(1);
    expect(TradingMetrics.arbitrageProfit.get({ event_id: 'event-1' })).toBeCloseTo(0.03, 5);
  });
});
