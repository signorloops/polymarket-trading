import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('monitoring provisioning', () => {
  it('provides a file-provisioned Grafana dashboard model', () => {
    const dashboard = JSON.parse(
      readFileSync(
        join(process.cwd(), 'monitoring/grafana/dashboards/trading-dashboard.json'),
        'utf8'
      )
    ) as { uid?: string; dashboard?: unknown; panels?: unknown[] };
    const provisioning = readFileSync(
      join(process.cwd(), 'monitoring/grafana/provisioning/dashboards.yml'),
      'utf8'
    );

    expect(dashboard.uid).toBe('polymarket-trading');
    expect(dashboard.dashboard).toBeUndefined();
    expect(dashboard.panels?.length).toBeGreaterThan(0);
    expect(provisioning).toContain('path: /etc/grafana/dashboards');
  });

  it('queries the metric names exported by the current registry', () => {
    const dashboard = readFileSync(
      join(process.cwd(), 'monitoring/grafana/dashboards/trading-dashboard.json'),
      'utf8'
    );

    expect(dashboard).toContain('trading_arbitrage_opportunities_total');
    expect(dashboard).toContain('trading_order_execution_latency_ms_bucket');
    expect(dashboard).toContain('trading_websocket_connected');
    expect(dashboard).toContain('trading_circuit_breaker_open');
    expect(dashboard).not.toContain('arbitrage_opportunities_found_total');
    expect(dashboard).not.toContain('order_latency_seconds_bucket');
  });
});
