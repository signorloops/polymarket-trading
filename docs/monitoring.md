# Polymarket Trading System - Monitoring Guide

## Overview

This document describes how to set up and use the monitoring system for the Polymarket trading bot.

## Components

- **Prometheus**: Metrics collection and storage
- **Grafana**: Visualization and dashboards
- **Node.js Metrics**: Application-level metrics exposed via `/metrics` endpoint

## Metrics Exposed

### Arbitrage Metrics
- `arbitrage_opportunities_found_total`: Total number of arbitrage opportunities detected
- `arbitrage_executed_total`: Total number of executed arbitrages
- `arbitrage_profit_usd_total`: Total profit in USD

### Algorithm Metrics
- `frank_wolfe_iterations`: Number of iterations for convergence
- `frank_wolfe_gap`: Optimality gap
- `frank_wolfe_converged`: Whether the algorithm converged

### Order Metrics
- `orders_submitted_total`: Total orders submitted
- `orders_filled_total`: Total orders filled
- `orders_cancelled_total`: Total orders cancelled
- `order_latency_seconds`: Order execution latency histogram

### System Metrics
- `websocket_connected`: WebSocket connection status (0/1)
- `circuit_breaker_open`: Circuit breaker status (0/1)
- `daily_loss_usd`: Current daily loss
- `current_exposure_usd`: Current market exposure

## Starting Monitoring

```bash
# Start all services including monitoring
docker-compose --profile monitoring up -d

# Access Prometheus UI
open http://localhost:9090

# Access Grafana Dashboard
open http://localhost:3000
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
3. Check metrics endpoint: `curl http://localhost:8080/metrics`

### Grafana not loading
1. Check Grafana logs: `docker-compose logs grafana`
2. Verify datasource configuration
3. Check dashboard JSON syntax
