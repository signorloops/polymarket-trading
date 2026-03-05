/**
 * Execution metrics helpers and alert functions.
 */

import { getLogger } from '../utils/logger.js';
import { TradingMetrics, recordTrade, recordArbitrage } from '../utils/metrics.js';
import { sendAlert } from '../alerts/index.js';
import type { OrderStatus, TradeLeg, TradeOrder, ExecutionResult } from './types.js';

const logger = getLogger().child({ module: 'ExecutionEngine' });

/**
 * Record metrics for a completed order execution.
 */
export function recordOrderMetrics(
  order: TradeOrder,
  status: OrderStatus,
  executionTimeMs: number
): void {
  recordTrade(
    order.marketId,
    order.side,
    status.filledSize,
    status.avgPrice,
    executionTimeMs,
    status.status !== 'error'
  );
  TradingMetrics.orderExecutionLatency.observe({ market_id: order.marketId }, executionTimeMs);
}

/**
 * Record arbitrage execution result and detection latency.
 */
export function recordArbitrageMetrics(
  arbitrageId: string,
  result: ExecutionResult,
  detectionLatencyMs: number
): void {
  TradingMetrics.arbitrageDetectionLatency.observe(
    { arbitrage_id: arbitrageId },
    detectionLatencyMs
  );
  const totalProfit = result.success ? result.totalFilled * 0.01 : 0;
  recordArbitrage(arbitrageId, totalProfit, result.success, totalProfit);
}

/**
 * Send alert for partial fills requiring manual intervention.
 */
export async function alertPartialFills(context: {
  arbitrageId: string;
  partialFills: { orderId: string; filled: number; remaining: number }[];
  totalFilled: number;
}): Promise<void> {
  const { arbitrageId, partialFills, totalFilled } = context;

  logger.warn(`Manual intervention required for arbitrage ${arbitrageId}`, {
    partialFills,
    totalFilled,
  });

  await sendAlert(
    'critical',
    'Arbitrage Partial Fill - Manual Intervention Required',
    `Arbitrage ${arbitrageId} has partial fills that may require manual intervention. ` +
      `Total filled: ${String(totalFilled)}. Partial orders: ${String(partialFills.length)}`,
    {
      arbitrageId,
      partialFills,
      totalFilled,
      timestamp: Date.now(),
      recommendation: 'Review positions and consider unwinding or hedging',
    }
  );
}

/**
 * Convert trade legs to orders.
 */
export function legsToOrders(legs: TradeLeg[], arbitrageId: string): TradeOrder[] {
  return legs.map((leg, index) => ({
    id: `${arbitrageId}-${String(index)}`,
    marketId: leg.marketId,
    side: leg.side,
    size: leg.size,
    price: leg.expectedPrice,
    orderType: 'limit' as const,
    timeInForce: 'IOC' as const,
  }));
}

/**
 * Detect partial fills from execution result.
 */
export function detectPartialFills(
  result: ExecutionResult,
  orders: TradeOrder[]
): { orderId: string; filled: number; remaining: number }[] {
  return result.orders
    .filter(
      (o) =>
        o.status === 'partial' ||
        (o.status === 'filled' &&
          o.filledSize < (orders.find((oo) => oo.id === o.orderId)?.size ?? 0))
    )
    .map((o) => ({
      orderId: o.orderId,
      filled: o.filledSize,
      remaining: o.remainingSize,
    }));
}
