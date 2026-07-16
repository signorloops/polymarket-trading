/**
 * Execution Engine for Polymarket Arbitrage Trades
 *
 * Handles trade execution with:
 * - Parallel order submission for multi-legged arbitrage
 * - Order status tracking and confirmation
 * - Partial fill handling
 * - Error recovery
 */

import { getLogger } from '../utils/logger.js';
import { TRADING_CONFIG } from '../utils/config.js';
import type {
  TradeOrder,
  OrderStatus,
  ExecutionResult,
  ExecutionRecoveryResult,
  TradeLeg,
} from './types.js';
import { OrderManager } from './order-manager.js';
import type { TradingClient } from '../api/trading-client.js';
import { TradingMetrics } from '../utils/metrics.js';
import { getErrorMessage } from '../utils/errors.js';
import { createSingleton } from '../utils/singleton.js';
import { getRiskManager, type RiskManager } from './risk-manager.js';
import {
  recordOrderMetrics,
  recordArbitrageMetrics,
  alertPartialFills,
  legsToOrders,
  detectPartialFills,
} from './execution-metrics.js';
import { isTradingStatusClient, pollOrderUntilTerminal } from './order-lifecycle.js';

export type { TradeOrder, OrderStatus, ExecutionResult, ExecutionRecoveryResult, TradeLeg };

export interface ExecutionEngineOptions {
  recoveryPollIntervalMs?: number;
  recoveryPollTimeoutMs?: number;
  maxUnwindSlippage?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * ExecutionEngine handles order submission and tracking
 */
export class ExecutionEngine {
  private orderManager: OrderManager;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private logger = getLogger().child({ module: 'ExecutionEngine' });
  private apiClient: TradingClient | null = null;
  private riskManager: RiskManager;
  private readonly options: Required<ExecutionEngineOptions>;

  constructor(
    orderManager?: OrderManager,
    apiClient?: TradingClient,
    riskManager?: RiskManager,
    options: ExecutionEngineOptions = {}
  ) {
    this.orderManager = orderManager ?? new OrderManager();
    this.apiClient = apiClient ?? null;
    this.riskManager = riskManager ?? getRiskManager();
    this.options = {
      recoveryPollIntervalMs: options.recoveryPollIntervalMs ?? 500,
      recoveryPollTimeoutMs: options.recoveryPollTimeoutMs ?? 5_000,
      maxUnwindSlippage: options.maxUnwindSlippage ?? 0.05,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
    };

    // Start automatic cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.orderManager.clearOldOrders(3600000); // Clean orders older than 1 hour
    }, 300000);
    this.cleanupInterval.unref();
  }

  /**
   * Set the API client for real order submission
   */
  setApiClient(client: TradingClient): void {
    this.apiClient = client;
  }

  /**
   * Stop the execution engine and cleanup resources
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Execute a single order
   */
  async executeOrder(order: TradeOrder): Promise<OrderStatus> {
    const startTime = performance.now();
    this.logger.info(`Executing order ${order.id}`, {
      marketId: order.marketId,
      side: order.side,
      size: order.size,
      price: order.price,
    });

    this.orderManager.addPending(order);
    TradingMetrics.ordersSubmitted.inc({ market_id: order.marketId, side: order.side });

    try {
      // Simulate order submission (replace with actual API call)
      const status = await this.submitOrder(order);
      const executionTime = performance.now() - startTime;

      this.orderManager.updateStatus(status);
      this.orderManager.removePending(order.id);
      this.riskManager.updatePosition(status, order.marketId, order.side);
      recordOrderMetrics(order, status, executionTime);
      return status;
    } catch (error) {
      const executionTime = performance.now() - startTime;
      const errorStatus: OrderStatus = {
        orderId: order.id,
        status: 'error',
        filledSize: 0,
        remainingSize: order.size,
        avgPrice: 0,
        timestamp: Date.now(),
        error: getErrorMessage(error),
      };

      this.orderManager.updateStatus(errorStatus);
      this.orderManager.removePending(order.id);
      TradingMetrics.ordersFailed.inc({ market_id: order.marketId, side: order.side });
      recordOrderMetrics(order, errorStatus, executionTime);
      this.logger.error(`Order ${order.id} failed`, { error: errorStatus.error });
      return errorStatus;
    }
  }

  /**
   * Execute multiple orders in parallel
   * Used for multi-legged arbitrage trades
   */
  async executeParallel(orders: TradeOrder[]): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.logger.info(`Executing ${String(orders.length)} orders in parallel`);

    // Check if we exceed max concurrent trades
    if (orders.length > TRADING_CONFIG.MAX_CONCURRENT_TRADES) {
      return {
        success: false,
        orders: [],
        totalFilled: 0,
        totalCost: 0,
        errors: [`Too many concurrent trades: ${String(orders.length)}`],
        executionTime: 0,
      };
    }

    // Execute all orders in parallel
    const results = await Promise.all(
      orders.map((order) =>
        this.executeOrder(order).catch(
          (error: unknown): OrderStatus => ({
            orderId: order.id,
            status: 'error',
            filledSize: 0,
            remainingSize: order.size,
            avgPrice: 0,
            timestamp: Date.now(),
            error: getErrorMessage(error),
          })
        )
      )
    );

    const executionTime = Date.now() - startTime;

    // Analyze results
    const errors: string[] = [];
    let totalFilled = 0;
    let totalCost = 0;

    for (const result of results) {
      if (result.error) {
        errors.push(`Order ${result.orderId}: ${result.error}`);
      }
      totalFilled += result.filledSize;
      totalCost += result.filledSize * result.avgPrice;
    }

    const success = errors.length === 0;

    this.logger.info(`Parallel execution completed`, {
      success,
      executionTime,
      totalFilled,
      errorCount: errors.length,
    });

    return {
      success,
      orders: results,
      totalFilled,
      totalCost,
      errors,
      executionTime,
    };
  }

  /**
   * Execute an arbitrage trade with multiple legs
   */
  async executeArbitrage(legs: TradeLeg[], arbitrageId: string): Promise<ExecutionResult> {
    const startTime = performance.now();
    this.logger.info(`Executing arbitrage ${arbitrageId} with ${String(legs.length)} legs`);

    const orders = legsToOrders(legs, arbitrageId);
    const result = await this.executeParallel(orders);
    recordArbitrageMetrics(arbitrageId, result, performance.now() - startTime);

    const partialFills = detectPartialFills(result, orders);
    const incomplete =
      partialFills.length > 0 ||
      result.orders.some((order) => order.status !== 'filled') ||
      result.orders.length !== orders.length;
    if (incomplete) {
      this.logger.warn(`Arbitrage ${arbitrageId} has partial fills`, { partialFills });
      result.success = false;
      result.recovery = await this.recoverIncompleteArbitrage(arbitrageId, orders, result.orders);
      result.errors.push(...result.recovery.errors);
      await alertPartialFills({ arbitrageId, partialFills, totalFilled: result.totalFilled });
    }

    return result;
  }

  /**
   * Cancel a pending order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    this.logger.info(`Cancelling order ${orderId}`);

    const order = this.orderManager.getPending(orderId);
    const trackedStatus = this.orderManager.getStatus(orderId);
    if (!order && !this.isCancellableStatus(trackedStatus)) {
      this.logger.warn(`Order ${orderId} not found or not pending`);
      return false;
    }

    try {
      await this.submitCancel(trackedStatus?.exchangeOrderId ?? orderId);

      const status: OrderStatus = {
        orderId,
        status: 'cancelled',
        ...(trackedStatus?.exchangeOrderId
          ? { exchangeOrderId: trackedStatus.exchangeOrderId }
          : {}),
        filledSize: trackedStatus?.filledSize ?? 0,
        remainingSize: order?.size ?? trackedStatus?.remainingSize ?? 0,
        avgPrice: trackedStatus?.avgPrice ?? order?.price ?? 0,
        timestamp: Date.now(),
      };

      this.orderManager.updateStatus(status);
      this.orderManager.removePending(orderId);

      // Record cancellation metric. NOTE: do NOT label by order_id — that creates
      // one unbounded time series per order (a cardinality leak). Count as a total;
      // per-order detail belongs in structured logs, not metrics.
      TradingMetrics.ordersCancelled.inc({});

      return true;
    } catch (error) {
      this.logger.error(`Failed to cancel order ${orderId}`, {
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Get status of an order
   */
  getOrderStatus(orderId: string): OrderStatus | undefined {
    return this.orderManager.getStatus(orderId);
  }

  /**
   * Get all pending orders
   */
  getPendingOrders(): TradeOrder[] {
    return this.orderManager.getAllPending();
  }

  /**
   * Get all order statuses
   */
  getAllOrderStatuses(): OrderStatus[] {
    return this.orderManager.getAllStatuses();
  }

  /**
   * Clear completed orders older than specified time
   */
  clearOldOrders(maxAgeMs = 3600000) {
    this.orderManager.clearOldOrders(maxAgeMs);
  }

  private async submitOrder(order: TradeOrder): Promise<OrderStatus> {
    // Kill-switch: never place an order while the risk circuit breaker is active.
    // This is the last line of defense on the order-submission path — even if an
    // upstream caller skipped the risk check, no real-money order leaves the system.
    if (this.riskManager.isCircuitBreakerActive()) {
      this.logger.error('Order submission blocked: risk circuit breaker is active', {
        orderId: order.id,
        marketId: order.marketId,
      });
      return {
        orderId: order.id,
        status: 'cancelled',
        filledSize: 0,
        remainingSize: order.size,
        avgPrice: 0,
        timestamp: Date.now(),
      };
    }

    // If API client is not configured, use simulation mode (for testing)
    if (!this.apiClient) {
      return this.simulateOrderSubmission(order);
    }

    try {
      const response = await this.apiClient.placeOrder({
        idempotencyKey: order.id,
        marketId: order.marketId,
        side: order.side,
        size: order.size,
        price: order.price,
        orderType: order.orderType,
        timeInForce: order.timeInForce ?? 'GTC',
      });

      // Map API response to OrderStatus
      const filledSize = response.filledSize;
      const remainingSize = response.remainingSize;

      return {
        orderId: order.id,
        exchangeOrderId: response.id,
        status: this.mapOrderStatus(response.status),
        filledSize,
        remainingSize,
        avgPrice: response.price,
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to submit order', { orderId: order.id, error: errorMessage });
      throw error;
    }
  }

  private async submitCancel(orderId: string): Promise<void> {
    if (!this.apiClient) {
      // Simulation mode - just log
      this.logger.info('Simulating order cancellation', { orderId });
      return;
    }

    try {
      await this.apiClient.cancelOrder(orderId);
      this.logger.info('Order cancelled successfully', { orderId });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to cancel order', { orderId, error: errorMessage });
      throw error;
    }
  }

  private async simulateOrderSubmission(order: TradeOrder): Promise<OrderStatus> {
    // Simulation mode for testing without real API
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Simulate 95% fill rate
    const fillRate = Math.random();
    const filledSize = fillRate > 0.05 ? order.size : order.size * 0.5;

    return {
      orderId: order.id,
      status: filledSize >= order.size ? 'filled' : 'partial',
      filledSize,
      remainingSize: order.size - filledSize,
      avgPrice: order.price * (0.995 + Math.random() * 0.01),
      timestamp: Date.now(),
    };
  }

  private mapOrderStatus(apiStatus: string): OrderStatus['status'] {
    switch (apiStatus.toLowerCase()) {
      case 'filled':
        return 'filled';
      case 'partial':
      case 'partially_filled':
        return 'partial';
      case 'open':
      case 'pending':
        return 'open';
      case 'cancelled':
        return 'cancelled';
      case 'error':
      case 'rejected':
        return 'error';
      default:
        return 'pending';
    }
  }

  private isCancellableStatus(status: OrderStatus | undefined): boolean {
    return (
      status?.status === 'open' || status?.status === 'pending' || status?.status === 'partial'
    );
  }

  private async recoverIncompleteArbitrage(
    arbitrageId: string,
    requestedOrders: TradeOrder[],
    observedOrders: OrderStatus[]
  ): Promise<ExecutionRecoveryResult> {
    const cancelledOrderIds: string[] = [];
    const errors: string[] = [];
    const finalFilledByOrder = new Map<string, number>();
    let cancellationsConfirmed = true;

    for (const observed of observedOrders) {
      finalFilledByOrder.set(observed.orderId, observed.filledSize);
      if (
        observed.status !== 'open' &&
        observed.status !== 'pending' &&
        observed.status !== 'partial'
      ) {
        continue;
      }

      const cancelled = await this.cancelOrder(observed.orderId);
      if (!cancelled) {
        cancellationsConfirmed = false;
        errors.push(`Failed to cancel incomplete order ${observed.orderId}`);
        continue;
      }
      cancelledOrderIds.push(observed.orderId);

      if (!this.apiClient || !isTradingStatusClient(this.apiClient) || !observed.exchangeOrderId) {
        cancellationsConfirmed = false;
        errors.push(
          `Cancellation for ${observed.orderId} could not be confirmed from the exchange`
        );
        continue;
      }

      let terminal;
      try {
        terminal = await pollOrderUntilTerminal({
          tradingClient: this.apiClient,
          orderId: observed.exchangeOrderId,
          pollIntervalMs: this.options.recoveryPollIntervalMs,
          pollTimeoutMs: this.options.recoveryPollTimeoutMs,
          sleep: this.options.sleep,
          now: this.options.now,
          mapStatus: (status) => status,
          openStatuses: new Set(['open', 'partial']),
        });
      } catch (error) {
        cancellationsConfirmed = false;
        errors.push(
          `Cancellation confirmation failed for ${observed.orderId}: ${getErrorMessage(error)}`
        );
        continue;
      }
      if (!terminal) {
        cancellationsConfirmed = false;
        errors.push(`Cancellation for ${observed.orderId} remained unconfirmed`);
        continue;
      }

      const additionalFill = Math.max(terminal.filledSize - observed.filledSize, 0);
      if (additionalFill > 0) {
        const requested = requestedOrders.find((order) => order.id === observed.orderId);
        if (requested) {
          this.riskManager.updatePosition(
            {
              orderId: observed.orderId,
              exchangeOrderId: observed.exchangeOrderId,
              status: terminal.status === 'filled' ? 'filled' : 'partial',
              filledSize: additionalFill,
              remainingSize: terminal.remainingSize,
              avgPrice: terminal.price,
              timestamp: this.options.now(),
            },
            requested.marketId,
            requested.side
          );
        }
      }
      finalFilledByOrder.set(observed.orderId, terminal.filledSize);
    }

    const unwindOrders: OrderStatus[] = [];
    let unwindComplete = cancellationsConfirmed;
    if (cancellationsConfirmed) {
      for (const requested of requestedOrders) {
        const filledSize = finalFilledByOrder.get(requested.id) ?? 0;
        if (filledSize <= 0) {
          continue;
        }
        const observed = observedOrders.find((order) => order.orderId === requested.id);
        const referencePrice = observed?.avgPrice ?? requested.price;
        const unwindSide = requested.side === 'buy' ? 'sell' : 'buy';
        const unwindPrice =
          unwindSide === 'sell'
            ? Math.max(0.001, referencePrice - this.options.maxUnwindSlippage)
            : Math.min(0.999, referencePrice + this.options.maxUnwindSlippage);
        const unwind = await this.executeOrder({
          id: `${arbitrageId}-unwind-${requested.id}`,
          marketId: requested.marketId,
          side: unwindSide,
          size: filledSize,
          price: unwindPrice,
          orderType: 'limit',
          timeInForce: 'GTC',
        });
        unwindOrders.push(unwind);
        if (unwind.status !== 'filled' || unwind.filledSize + 1e-8 < filledSize) {
          unwindComplete = false;
          errors.push(`Unwind order ${unwind.orderId} did not fill completely`);
          if (unwind.status === 'open' || unwind.status === 'partial') {
            await this.cancelOrder(unwind.orderId);
          }
        }
      }
    }

    this.riskManager.triggerCircuitBreaker(
      `Incomplete multi-leg arbitrage ${arbitrageId}; operator review required`
    );
    const unwindAttempted = unwindOrders.length > 0;
    return {
      attempted: true,
      cancellationsConfirmed,
      unwindAttempted,
      unwindComplete: unwindAttempted && unwindComplete,
      // Every incomplete multi-leg trade requires human review, even if the
      // compensating orders appear to have flattened the position.
      manualInterventionRequired: true,
      cancelledOrderIds,
      unwindOrders,
      errors,
    };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Global execution engine instance
 */
const executionEngineSingleton = createSingleton(() => new ExecutionEngine());
export const getExecutionEngine = executionEngineSingleton.get;

/**
 * Reset the global engine (for testing)
 */
export function resetExecutionEngine(): void {
  executionEngineSingleton.get().stop();
  executionEngineSingleton.reset();
}
