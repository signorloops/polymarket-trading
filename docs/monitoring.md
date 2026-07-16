# Polymarket Trading System - Monitoring Guide

## Overview

This document describes how to set up and use the monitoring system for the Polymarket trading bot.

## Components

- **Prometheus**: Metrics collection and storage
- **Grafana**: Visualization and dashboards
- **Node.js Metrics**: Application-level metrics exposed via `/metrics` endpoint

When the daemon binds outside loopback, `/metrics` requires a bearer token. Docker Compose mounts the same token into the daemon and Prometheus from `.secrets/metrics-token`.

## Metrics Exposed

The current registry exports only the metrics below. Prometheus adds `_bucket`, `_sum`, and `_count` series for histograms.

| Metric | Type | Description |
| --- | --- | --- |
| `trading_orders_submitted_total` | Counter | Orders submitted |
| `trading_orders_filled_total` | Counter | Orders recorded as successful |
| `trading_orders_failed_total` | Counter | Failed orders |
| `trading_orders_cancelled_total` | Counter | Confirmed cancellations |
| `trading_position_size` | Gauge | Current position size |
| `trading_position_pnl` | Gauge | Unrealized position P&L |
| `trading_total_exposure` | Gauge | Total exposure |
| `trading_daily_pnl` | Gauge | Current UTC trading-day realized P&L |
| `trading_unrealized_pnl` | Gauge | Current unrealized P&L |
| `trading_max_drawdown` | Gauge | Current UTC trading-day max drawdown |
| `trading_circuit_breaker_open` | Gauge | Circuit breaker state (1=open) |
| `trading_arbitrage_opportunities_total` | Counter | Opportunities recorded |
| `trading_arbitrage_executed_total` | Counter | Successful executions |
| `trading_arbitrage_failed_total` | Counter | Failed executions |
| `trading_arbitrage_profit_total` | Counter | Settled USD profit only; execution does not fabricate P&L |
| `trading_order_execution_seconds` | Histogram | Order execution duration |
| `trading_frank_wolfe_iterations` | Histogram | Frank-Wolfe iteration count |
| `trading_frank_wolfe_gap` | Histogram | Frank-Wolfe optimality gap |
| `trading_orderbook_updates_total` | Counter | Order-book updates |
| `trading_websocket_reconnects_total` | Counter | WebSocket reconnects |
| `trading_websocket_errors_total` | Counter | WebSocket errors |
| `trading_websocket_connected` | Gauge | Market WebSocket state (1=connected) |
| `trading_orderbook_update_latency_ms` | Histogram | Order-book update latency |
| `trading_arbitrage_detection_latency_ms` | Histogram | Detection-cycle latency |
| `trading_arbitrage_execution_latency_ms` | Histogram | Multi-leg execution and recovery latency |
| `trading_ws_message_processing_ms` | Histogram | WebSocket processing time |
| `trading_order_execution_latency_ms` | Histogram | Submission-to-confirmation latency |
| `trading_risk_check_latency_ms` | Histogram | Risk-check latency |

## Starting Monitoring

```bash
# Create the file-backed secrets required by Compose.
mkdir -p .secrets
openssl rand -hex 32 > .secrets/metrics-token
openssl rand -hex 32 > .secrets/grafana-admin-password
chmod 600 .secrets/metrics-token .secrets/grafana-admin-password

# Start all services including monitoring
docker compose --profile monitoring up -d

# Access Prometheus UI
open http://localhost:9090

# Access Grafana Dashboard
open http://localhost:3001
# Username: admin; password: contents of .secrets/grafana-admin-password
```

## Grafana Dashboard

The dashboard includes panels for:
- Arbitrage opportunity tracking
- Profit and loss monitoring
- Algorithm performance metrics
- Order execution statistics
- System health indicators
- Risk management alerts

## Alerts

Configure alerts in Grafana for:

- `trading_daily_pnl` below the reviewed daily-loss threshold
- `trading_circuit_breaker_open == 1`
- `trading_websocket_connected == 0`
- sustained growth in `trading_websocket_errors_total`
- high quantiles of `trading_order_execution_latency_ms_bucket`
- a high failed-to-submitted order rate

## Troubleshooting

### No metrics showing
1. Check if the trading bot is running: `docker compose ps`
2. Verify Prometheus targets: http://localhost:9090/targets
3. Check metrics endpoint: `curl -H "Authorization: Bearer $HTTP_METRICS_TOKEN" http://localhost:3000/metrics`

### Grafana not loading
1. Check Grafana logs: `docker compose logs grafana`
2. Verify datasource configuration
3. Check dashboard JSON syntax
