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
import { TRADING_CONFIG, NETWORK_CONFIG } from '../utils/config.js';

export interface TradeOrder {
  id: string;
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  orderType: 'limit' | 'market';
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface OrderStatus {
  orderId: string;
  status: 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'error';
  filledSize: number;
  remainingSize: number;
  avgPrice: number;
  timestamp: number;
  error?: string;
}

export interface ExecutionResult {
  success: boolean;
  orders: OrderStatus[];
  totalFilled: number;
  totalCost: number;
  errors: string[];
  executionTime: number;
}

export interface TradeLeg {
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  expectedPrice: number;
}

/**
 * ExecutionEngine handles order submission and tracking
 */
export class ExecutionEngine {
  private pendingOrders: Map<string, TradeOrder> = new Map();
  private orderStatuses: Map<string, OrderStatus> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private logger = getLogger().child({ module: 'ExecutionEngine' });

  constructor() {
    // Start automatic cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.clearOldOrders(3600000); // Clean orders older than 1 hour
    }, 300000);
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
    this.logger.info(`Executing order ${order.id}`, {
      marketId: order.marketId,
      side: order.side,
      size: order.size,
      price: order.price,
    });

    this.pendingOrders.set(order.id, order);

    try {
      // Simulate order submission (replace with actual API call)
      const status = await this.submitOrder(order);
      this.orderStatuses.set(order.id, status);
      this.pendingOrders.delete(order.id);

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

      this.orderStatuses.set(order.id, errorStatus);
      this.pendingOrders.delete(order.id);

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
    this.logger.info(`Executing ${orders.length} orders in parallel`);

    // Check if we exceed max concurrent trades
    if (orders.length > TRADING_CONFIG.MAX_CONCURRENT_TRADES) {
      return {
        success: false,
        orders: [],
        totalFilled: 0,
        totalCost: 0,
        errors: [`Too many concurrent trades: ${orders.length}`],
        executionTime: 0,
      };
    }

    // Execute all orders in parallel
    const results = await Promise.all(
      orders.map((order) => this.executeOrder(order).catch((error): OrderStatus => ({
        orderId: order.id,
        status: 'error',
        filledSize: 0,
        remainingSize: order.size,
        avgPrice: 0,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      })))
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
  async executeArbitrage(
    legs: TradeLeg[],
    arbitrageId: string
  ): Promise<ExecutionResult> {
    this.logger.info(`Executing arbitrage ${arbitrageId} with ${legs.length} legs`);

    // Convert legs to orders
    const orders: TradeOrder[] = legs.map((leg, index) => ({
      id: `${arbitrageId}-${index}`,
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
      (o) => o.status === 'partial' || (o.status === 'filled' && o.filledSize < (orders.find(oo => oo.id === o.orderId)?.size || 0))
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
      await this.handlePartialFills(arbitrageId, result.orders);
    }

    return result;
  }

  /**
   * Cancel a pending order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    this.logger.info(`Cancelling order ${orderId}`);

    const order = this.pendingOrders.get(orderId);
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

      this.orderStatuses.set(orderId, status);
      this.pendingOrders.delete(orderId);

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
    return this.orderStatuses.get(orderId);
  }

  /**
   * Get all pending orders
   */
  getPendingOrders(): TradeOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  /**
   * Get all order statuses
   */
  getAllOrderStatuses(): OrderStatus[] {
    return Array.from(this.orderStatuses.values());
  }

  /**
   * Clear completed orders older than specified time
   */
  clearOldOrders(maxAgeMs: number = 3600000): void {
    const cutoff = Date.now() - maxAgeMs;

    for (const [orderId, status] of this.orderStatuses.entries()) {
      if (status.timestamp < cutoff && status.status !== 'pending' && status.status !== 'open') {
        this.orderStatuses.delete(orderId);
      }
    }
  }

  private async submitOrder(order: TradeOrder): Promise<OrderStatus> {
    // TODO: Replace with actual Polymarket API call
    // This is a simulation for now

    await this.simulateNetworkDelay();

    // Simulate 95% fill rate
    const fillRate = Math.random();
    const filledSize = fillRate > 0.05 ? order.size : order.size * 0.5;
    const status: OrderStatus = {
      orderId: order.id,
      status: filledSize >= order.size ? 'filled' : 'partial',
      filledSize,
      remainingSize: order.size - filledSize,
      avgPrice: order.price * (0.995 + Math.random() * 0.01), // Small price variance
      timestamp: Date.now(),
    };

    return status;
  }

  private async submitCancel(orderId: string): Promise<void> {
    // TODO: Replace with actual Polymarket API call
    await this.simulateNetworkDelay();
  }

  private async handlePartialFills(
    arbitrageId: string,
    orders: OrderStatus[]
  ): Promise<void> {
    // Strategy: Cancel remaining orders and try to unwind filled positions
    this.logger.info(`Handling partial fills for ${arbitrageId}`);

    // Cancel any remaining pending orders
    for (const order of orders) {
      if (order.status === 'open' || order.status === 'pending') {
        await this.cancelOrder(order.orderId);
      }
    }
  }

  private async simulateNetworkDelay(): Promise<void> {
    // Simulate 15-50ms network delay
    const delay = 15 + Math.random() * 35;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Global execution engine instance
 */
let globalEngine: ExecutionEngine | null = null;

export function getExecutionEngine(): ExecutionEngine {
  if (!globalEngine) {
    globalEngine = new ExecutionEngine();
  }
  return globalEngine;
}

/**
 * Reset the global engine (for testing)
 */
export function resetExecutionEngine(): void {
  globalEngine = null;
}
