/**
 * Order Manager
 *
 * Handles order storage, retrieval, and lifecycle management.
 * Separates order state management from execution logic.
 */

import { getLogger } from '../utils/logger.js';
import type { TradeOrder, OrderStatus } from './types.js';

export class OrderManager {
  private pendingOrders: Map<string, TradeOrder> = new Map();
  private orderStatuses: Map<string, OrderStatus> = new Map();
  private logger = getLogger().child({ module: 'OrderManager' });

  /**
   * Add a pending order
   */
  addPending(order: TradeOrder): void {
    this.pendingOrders.set(order.id, order);
  }

  /**
   * Remove a pending order
   */
  removePending(orderId: string): void {
    this.pendingOrders.delete(orderId);
  }

  /**
   * Get a pending order
   */
  getPending(orderId: string): TradeOrder | undefined {
    return this.pendingOrders.get(orderId);
  }

  /**
   * Get all pending orders
   */
  getAllPending(): TradeOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  /**
   * Update order status
   */
  updateStatus(status: OrderStatus): void {
    this.orderStatuses.set(status.orderId, status);
  }

  /**
   * Get order status
   */
  getStatus(orderId: string): OrderStatus | undefined {
    return this.orderStatuses.get(orderId);
  }

  /**
   * Get all order statuses
   */
  getAllStatuses(): OrderStatus[] {
    return Array.from(this.orderStatuses.values());
  }

  /**
   * Clear completed orders older than specified time
   */
  clearOldOrders(maxAgeMs = 3600000) {
    const cutoff = Date.now() - maxAgeMs;
    let cleared = 0;

    for (const [orderId, status] of this.orderStatuses.entries()) {
      // Keep partial fills — the engine may still cancel the remainder (EXEC-11).
      if (
        status.timestamp < cutoff &&
        status.status !== 'pending' &&
        status.status !== 'open' &&
        status.status !== 'partial'
      ) {
        this.orderStatuses.delete(orderId);
        cleared++;
      }
    }

    if (cleared > 0) {
      this.logger.debug(`Cleared ${String(cleared)} old orders`);
    }
  }

  /**
   * Check if an order exists (pending or completed)
   */
  hasOrder(orderId: string): boolean {
    return this.pendingOrders.has(orderId) || this.orderStatuses.has(orderId);
  }

  /**
   * Get count of pending orders
   */
  getPendingCount(): number {
    return this.pendingOrders.size;
  }

  /**
   * Get count of tracked orders
   */
  getStatusCount(): number {
    return this.orderStatuses.size;
  }

  /**
   * Clear all orders (emergency use)
   */
  clearAll(): void {
    this.pendingOrders.clear();
    this.orderStatuses.clear();
    this.logger.warn('All orders cleared');
  }
}
