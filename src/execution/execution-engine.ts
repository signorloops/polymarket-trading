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
import { getRiskManager } from './risk-manager.js';
import type { LifecycleComponent, ComponentStatus } from '../lifecycle/shutdown.js';

export type { TradeOrder, OrderStatus, ExecutionResult, TradeLeg };

/**
 * ExecutionEngine handles order submission and tracking
 */
export class ExecutionEngine implements LifecycleComponent {
  id = 'execution-engine';
  priority = 50;

  private orderManager: OrderManager;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private logger = getLogger().child({ module: 'ExecutionEngine' });
  private apiClient: PolymarketClient | null = null;
  private paused = false;
  private lastActivity = Date.now();

  constructor(orderManager?: OrderManager, apiClient?: PolymarketClient) {
    this.orderManager = orderManager ?? new OrderManager();
    this.apiClient = apiClient ?? null;

    // Start automatic cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.orderManager.clearOldOrders(3600000); // Clean orders older than 1 hour
    }, 300000);
    this.cleanupInterval.unref(); // Allow process to exit if this is the only active handle
  }

  /**
   * Set the API client for real order submission
   */
  setApiClient(client: PolymarketClient): void {
    this.apiClient = client;
  }

  /**
   * Pause accepting new orders
   */
  pause(): void {
    this.paused = true;
    this.logger.info('ExecutionEngine paused - no new orders accepted');
  }

  /**
   * Resume accepting orders
   */
  resume(): void {
    this.paused = false;
    this.logger.info('ExecutionEngine resumed');
  }

  /**
   * Check if engine is paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Cancel all pending orders
   */
  async cancelAllPending(timeoutMs = 10000): Promise<void> {
    const pending = this.orderManager.getAllPending();
    if (pending.length === 0) return;

    this.logger.info(`Cancelling ${String(pending.length)} pending orders...`);

    const startTime = Date.now();
    const results = await Promise.all(
      pending.map((order) =>
        Promise.race([
          this.cancelOrder(order.id),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => {
              reject(new Error('Cancel timeout'));
            }, timeoutMs)
          ),
        ]).catch(() => false)
      )
    );

    const cancelled = results.filter((r) => r).length;
    this.logger.info(`Cancelled ${String(cancelled)}/${String(pending.length)} orders`, {
      durationMs: Date.now() - startTime,
    });
  }

  /**
   * Lifecycle: Stop the execution engine and cleanup resources
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.logger.info('ExecutionEngine stopped');
  }

  /**
   * Lifecycle: Destroy the engine
   */
  async destroy(): Promise<void> {
    this.logger.info('Destroying ExecutionEngine...');

    // Pause first
    this.pause();

    // Cancel pending orders
    await this.cancelAllPending(5000);

    // Stop cleanup interval
    this.stop();

    // Clear all orders
    this.orderManager.clearAll();

    this.logger.info('ExecutionEngine destroyed');
  }

  /**
   * Lifecycle: Get component status
   */
  getStatus(): ComponentStatus {
    return {
      id: this.id,
      healthy: !this.paused,
      pendingOperations: this.orderManager.getAllPending().length,
      lastActivity: this.lastActivity,
    };
  }

  /**
   * Execute a single order
   */
  async executeOrder(order: TradeOrder): Promise<OrderStatus> {
    this.lastActivity = Date.now();

    if (this.paused) {
      return {
        orderId: order.id,
        status: 'error',
        filledSize: 0,
        remainingSize: order.size,
        avgPrice: 0,
        timestamp: Date.now(),
        error: 'ExecutionEngine is paused',
      };
    }

    this.logger.info(`Executing order ${order.id}`, {
      marketId: order.marketId,
      side: order.side,
      size: order.size,
      price: order.price,
    });

    this.orderManager.addPending(order);

    try {
      // Simulate order submission (replace with actual API call)
      const status = await this.submitOrder(order);
      this.orderManager.updateStatus(status);
      this.orderManager.removePending(order.id);

      return status;
    } catch (error) {
      const errorStatus: OrderStatus = {
        orderId: order.id,
        status: 'error',
        filledSize: 0,
        remainingSize: order.size,
        avgPrice: 0,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };

      this.orderManager.updateStatus(errorStatus);
      this.orderManager.removePending(order.id);

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
            error: error instanceof Error ? error.message : String(error),
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
    this.logger.info(`Executing arbitrage ${arbitrageId} with ${String(legs.length)} legs`);

    // Convert legs to orders
    const orders: TradeOrder[] = legs.map((leg, index) => ({
      id: `${arbitrageId}-${String(index)}`,
      marketId: leg.marketId,
      side: leg.side,
      size: leg.size,
      price: leg.expectedPrice,
      orderType: 'limit',
      timeInForce: 'IOC', // Immediate or cancel for arbitrage
    }));

    // Execute in parallel
    const result = await this.executeParallel(orders);

    // Check for partial fills
    const partialFills = result.orders.filter(
      (o) =>
        o.status === 'partial' ||
        (o.status === 'filled' &&
          o.filledSize < (orders.find((oo) => oo.id === o.orderId)?.size ?? 0))
    );

    if (partialFills.length > 0) {
      this.logger.warn(`Arbitrage ${arbitrageId} has partial fills`, {
        partialFills: partialFills.map((o) => ({
          orderId: o.orderId,
          filled: o.filledSize,
          remaining: o.remainingSize,
        })),
      });

      // Handle partial fills - may need to unwind or adjust
      await this.handlePartialFills(arbitrageId, result.orders, legs);
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

      return true;
    } catch (error) {
      this.logger.error(`Failed to cancel order ${orderId}`, {
        error: error instanceof Error ? error.message : String(error),
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

  private async handlePartialFills(
    arbitrageId: string,
    orders: OrderStatus[],
    originalLegs: TradeLeg[]
  ): Promise<void> {
    // Strategy: Cancel remaining orders and try to unwind filled positions
    this.logger.info(`Handling partial fills for ${arbitrageId}`);

    // Cancel any remaining pending orders
    for (const order of orders) {
      if (order.status === 'open' || order.status === 'pending') {
        await this.cancelOrder(order.orderId);
      }
    }

    // Get filled and failed orders
    const filledOrders = orders.filter((o) => o.status === 'filled' || o.status === 'partial');
    const failedOrderIds = orders
      .filter((o) => o.status === 'error' || o.status === 'cancelled')
      .map((o) => o.orderId);

    if (filledOrders.length === 0) {
      this.logger.info(`No filled orders to handle for ${arbitrageId}`);
      return;
    }

    // Consult risk manager for action
    const riskManager = getRiskManager();
    const decision = riskManager.handlePartialFill(filledOrders, failedOrderIds, arbitrageId);

    this.logger.info(`Partial fill decision for ${arbitrageId}`, {
      action: decision.action,
      reason: decision.reason,
    });

    switch (decision.action) {
      case 'unwind':
        await this.unwindPartialFill(arbitrageId, filledOrders, originalLegs);
        break;
      case 'hedge':
        await this.edgePartialFill(arbitrageId, filledOrders, originalLegs, failedOrderIds);
        break;
      case 'hold':
      default:
        // Just log and monitor - positions already updated in risk manager
        this.logger.info(`Holding partial fill positions for ${arbitrageId}`);
        break;
    }
  }

  /**
   * Unwind partial fill by closing filled positions
   */
  private async unwindPartialFill(
    arbitrageId: string,
    filledOrders: OrderStatus[],
    originalLegs: TradeLeg[]
  ): Promise<void> {
    this.logger.info(`Unwinding partial fill for ${arbitrageId}`);

    const unwindOrders: TradeOrder[] = [];

    for (const order of filledOrders) {
      // Find original leg to determine the opposite side
      const leg = originalLegs.find((l) => {
        // Match by constructing expected order ID
        const expectedOrderId = `${arbitrageId}-${String(originalLegs.indexOf(l))}`;
        return order.orderId === expectedOrderId;
      });

      if (!leg) {
        this.logger.warn(`Cannot find original leg for order ${order.orderId}`);
        continue;
      }

      // Create unwind order (opposite side)
      const unwindOrder: TradeOrder = {
        id: `${order.orderId}-unwind`,
        marketId: leg.marketId,
        side: leg.side === 'buy' ? 'sell' : 'buy',
        size: order.filledSize,
        price: 0, // Market order for quick unwind
        orderType: 'market',
        timeInForce: 'IOC', // Immediate or cancel
      };

      unwindOrders.push(unwindOrder);
    }

    if (unwindOrders.length === 0) {
      this.logger.warn(`No unwind orders created for ${arbitrageId}`);
      return;
    }

    // Execute unwind orders in parallel
    this.logger.info(`Executing ${String(unwindOrders.length)} unwind orders for ${arbitrageId}`);
    const result = await this.executeParallel(unwindOrders);

    if (result.success) {
      this.logger.info(`Successfully unwound partial fill for ${arbitrageId}`);
    } else {
      this.logger.error(`Failed to unwind partial fill for ${arbitrageId}`, {
        errors: result.errors,
      });
      // Alert for manual intervention
      this.alertManualIntervention(arbitrageId, 'unwind-failed', result.errors);
    }
  }

  /**
   * Hedge partial fill by taking offsetting positions
   */
  private async edgePartialFill(
    arbitrageId: string,
    filledOrders: OrderStatus[],
    originalLegs: TradeLeg[],
    failedOrderIds: string[]
  ): Promise<void> {
    this.logger.info(`Hedging partial fill for ${arbitrageId}`);

    // Find failed legs
    const failedLegs = originalLegs.filter((leg) => {
      const expectedOrderId = `${arbitrageId}-${String(originalLegs.indexOf(leg))}`;
      return failedOrderIds.includes(expectedOrderId);
    });

    if (failedLegs.length === 0) {
      this.logger.warn(`No failed legs found for hedging ${arbitrageId}`);
      return;
    }

    // Try to execute failed legs as hedge
    const hedgeOrders: TradeOrder[] = failedLegs.map((leg) => ({
      id: `${arbitrageId}-hedge-${leg.marketId}`,
      marketId: leg.marketId,
      side: leg.side,
      size: leg.size,
      price: leg.expectedPrice * 0.99, // Slightly worse price for quick fill
      orderType: 'limit',
      timeInForce: 'IOC',
    }));

    this.logger.info(`Executing ${String(hedgeOrders.length)} hedge orders for ${arbitrageId}`);
    const result = await this.executeParallel(hedgeOrders);

    if (result.success) {
      this.logger.info(`Successfully hedged partial fill for ${arbitrageId}`);
    } else {
      this.logger.warn(`Partial hedge execution for ${arbitrageId}`, {
        errors: result.errors,
      });
      // If hedge fails, try to unwind the filled positions
      await this.unwindPartialFill(arbitrageId, filledOrders, originalLegs);
    }
  }

  /**
   * Alert for manual intervention
   */
  private alertManualIntervention(arbitrageId: string, reason: string, details: string[]): void {
    this.logger.error(`MANUAL INTERVENTION REQUIRED for ${arbitrageId}`, {
      reason,
      details,
      timestamp: new Date().toISOString(),
    });

    // TODO: Implement actual alerting (email, Slack, PagerDuty, etc.)
    // For now, just log prominently
  }
}

/**
 * Global execution engine instance
 */
let globalEngine: ExecutionEngine | null = null;

export function getExecutionEngine(): ExecutionEngine {
  globalEngine ??= new ExecutionEngine();
  return globalEngine;
}

/**
 * Reset the global engine (for testing)
 */
export async function resetExecutionEngine(): Promise<void> {
  if (globalEngine) {
    await globalEngine.destroy();
  }
  globalEngine = null;
}
