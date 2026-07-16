# Polymarket Trading System - Monitoring Guide

## Overview

This document describes how to set up and use the monitoring system for the Polymarket trading bot.

## Components

- **Prometheus**: Metrics collection and storage
- **Grafana**: Visualization and dashboards
- **Node.js Metrics**: Application-level metrics exposed via `/metrics` endpoint

When the daemon binds outside loopback, `/metrics` requires a bearer token. Docker Compose mounts the same token into the daemon and Prometheus from `.secrets/metrics-token`.

## Metrics Exposed

### Business Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `arbitrage_opportunities_found_total` | Counter | Total number of arbitrage opportunities detected |
| `arbitrage_opportunities_executed_total` | Counter | Total number of executed arbitrages |
| `arbitrage_profit_usd_total` | Gauge | Total profit in USD |
| `arbitrage_opportunity_duration_seconds` | Histogram | Time from detection to execution |
| `position_size_usd` | Gauge | Current position size |
| `daily_pnl_usd` | Gauge | Daily profit/loss |

### Algorithm Performance Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `frank_wolfe_iterations` | Histogram | Number of iterations for convergence |
| `frank_wolfe_gap` | Gauge | Optimality gap |
| `frank_wolfe_converged` | Counter | Convergence count |
| `frank_wolfe_duration_ms` | Histogram | Algorithm execution time |
| `bregman_projection_iterations` | Histogram | Bregman projection iterations |
| `bregman_projection_duration_ms` | Histogram | Projection execution time |
| `order_book_operations_total` | Counter | Order book operations (insert/update/delete) |
| `order_book_operation_duration_ms` | Histogram | Order book operation latency |

### Order Execution Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `orders_submitted_total` | Counter | Total orders submitted |
| `orders_filled_total` | Counter | Total orders filled |
| `orders_partial_filled_total` | Counter | Partial fills |
| `orders_cancelled_total` | Counter | Cancelled orders |
| `orders_failed_total` | Counter | Failed orders |
| `order_latency_ms` | Histogram | Order execution latency |
| `order_fill_ratio` | Gauge | Fill ratio (filled/total) |

### Risk Management Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `risk_checks_total` | Counter | Total risk checks |
| `risk_checks_blocked_total` | Counter | Blocked by risk manager |
| `daily_loss_usd` | Gauge | Current daily loss |
| `current_exposure_usd` | Gauge | Current market exposure |
| `circuit_breaker_open` | Gauge | Circuit breaker status (0/1) |
| `emergency_stop_triggered` | Counter | Emergency stop count |
| `position_limit_hit_total` | Counter | Position limit violations |

### System Health Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `websocket_connected` | Gauge | WebSocket connection status (0/1) |
| `websocket_reconnects_total` | Counter | WebSocket reconnections |
| `websocket_messages_received_total` | Counter | Messages received |
| `api_requests_total` | Counter | API requests |
| `api_errors_total` | Counter | API errors |
| `api_latency_ms` | Histogram | API latency |
| `memory_usage_bytes` | Gauge | Memory usage |
| `gc_pause_ms` | Histogram | GC pause duration |
| `event_loop_lag_ms` | Gauge | Event loop lag |

### Data Pipeline Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `market_data_updates_total` | Counter | Market data updates |
| `order_book_updates_total` | Counter | Order book updates |
| `trade_events_total` | Counter | Trade events received |
| `price_changes_total` | Counter | Price change events |
| `data_processing_lag_ms` | Histogram | Processing lag |

## Starting Monitoring

```bash
# Start all services including monitoring
docker-compose --profile monitoring up -d

# Access Prometheus UI
open http://localhost:9090

# Access Grafana Dashboard
open http://localhost:3001
# Default credentials: admin/admin
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
- Daily loss threshold exceeded
- Circuit breaker triggered
- WebSocket disconnection
- High order latency
- Low success rate

## Troubleshooting

### No metrics showing
1. Check if the trading bot is running: `docker-compose ps`
2. Verify Prometheus targets: http://localhost:9090/targets
3. Check metrics endpoint: `curl -H "Authorization: Bearer $HTTP_METRICS_TOKEN" http://localhost:3000/metrics`

### Grafana not loading
1. Check Grafana logs: `docker-compose logs grafana`
2. Verify datasource configuration
3. Check dashboard JSON syntax
