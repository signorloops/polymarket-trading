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
import type { TradeOrder, OrderStatus, ExecutionResult, TradeLeg } from './types.js';
import { OrderManager } from './order-manager.js';
import { PolymarketClient } from '../api/polymarket-client.js';
import { TradingMetrics } from '../utils/metrics.js';
import { getErrorMessage } from '../utils/errors.js';
import { createSingleton } from '../utils/singleton.js';
import {
  recordOrderMetrics,
  recordArbitrageMetrics,
  alertPartialFills,
  legsToOrders,
  detectPartialFills,
} from './execution-metrics.js';

export type { TradeOrder, OrderStatus, ExecutionResult, TradeLeg };

/**
 * ExecutionEngine handles order submission and tracking
 */
export class ExecutionEngine {
  private orderManager: OrderManager;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private logger = getLogger().child({ module: 'ExecutionEngine' });
  private apiClient: PolymarketClient | null = null;

  constructor(orderManager?: OrderManager, apiClient?: PolymarketClient) {
    this.orderManager = orderManager ?? new OrderManager();
    this.apiClient = apiClient ?? null;

    // Start automatic cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.orderManager.clearOldOrders(3600000); // Clean orders older than 1 hour
    }, 300000);
    this.cleanupInterval.unref();
  }

  /**
   * Set the API client for real order submission
   */
  setApiClient(client: PolymarketClient): void {
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
    if (partialFills.length > 0) {
      this.logger.warn(`Arbitrage ${arbitrageId} has partial fills`, { partialFills });
      await this.handlePartialFills(arbitrageId, result.orders);
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
    if (!order) {
      this.logger.warn(`Order ${orderId} not found or not pending`);
      return false;
    }

    try {
      // Simulate cancel (replace with actual API call)
      await this.submitCancel(orderId);

      const status: OrderStatus = {
        orderId,
        status: 'cancelled',
        filledSize: 0,
        remainingSize: order.size,
        avgPrice: 0,
        timestamp: Date.now(),
      };

      this.orderManager.updateStatus(status);
      this.orderManager.removePending(orderId);

      // Record cancellation metric
      TradingMetrics.ordersCancelled.inc({ order_id: orderId });

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
    // If API client is not configured, use simulation mode (for testing)
    if (!this.apiClient) {
      return this.simulateOrderSubmission(order);
    }

    try {
      const response = await this.apiClient.placeOrder({
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
        orderId: response.id,
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

  private async handlePartialFills(arbitrageId: string, orders: OrderStatus[]): Promise<void> {
    // Strategy: Cancel remaining orders and try to unwind filled positions
    this.logger.info(`Handling partial fills for ${arbitrageId}`);

    // Cancel any remaining pending orders
    for (const order of orders) {
      if (order.status === 'open' || order.status === 'pending') {
        await this.cancelOrder(order.orderId);
      }
    }
  }
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
