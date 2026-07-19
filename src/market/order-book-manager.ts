/**
 * OrderBookManager - manages multiple order books across markets.
 *
 * Snapshot/delta gating (MKT-1): after connect/reconnect, price_change deltas
 * must not refresh a stale book (or seed an empty one) until an authoritative
 * `book` snapshot arrives for that market.
 */

import { getLogger } from '../utils/logger.js';
import { createSingleton } from '../utils/singleton.js';
import { OrderBook } from './order-book.js';

/**
 * OrderBookManager manages multiple order books
 */
export class OrderBookManager {
  private books: Map<string, OrderBook> = new Map();
  /** Markets that have received at least one snapshot since the last invalidation. */
  private syncedMarkets: Set<string> = new Set();
  private logger = getLogger().child({ module: 'OrderBookManager' });

  getBook(marketId: string): OrderBook {
    let book = this.books.get(marketId);
    if (!book) {
      book = new OrderBook(marketId);
      this.books.set(marketId, book);
      this.logger.debug(`Created order book for ${marketId}`);
    }
    return book;
  }

  peekBook(marketId: string): OrderBook | undefined {
    if (!this.syncedMarkets.has(marketId)) {
      return undefined;
    }
    return this.books.get(marketId);
  }

  /** True once a snapshot has been applied since the last invalidateAll/remove. */
  isSynced(marketId: string): boolean {
    return this.syncedMarkets.has(marketId);
  }

  updateBook(
    marketId: string,
    bids: { price: number; size: number }[],
    asks: { price: number; size: number }[],
    timestamp?: number,
    kind: 'snapshot' | 'delta' = 'delta'
  ): void {
    if (kind === 'snapshot') {
      const book = this.getBook(marketId);
      book.replace(bids, asks, timestamp);
      this.syncedMarkets.add(marketId);
      return;
    }

    if (!this.syncedMarkets.has(marketId)) {
      this.logger.debug(`Ignoring order-book delta for ${marketId}: awaiting snapshot`);
      return;
    }

    const book = this.books.get(marketId);
    if (!book) {
      this.syncedMarkets.delete(marketId);
      this.logger.debug(`Ignoring order-book delta for ${marketId}: book missing after sync flag`);
      return;
    }
    book.update(bids, asks, timestamp);
  }

  /**
   * Drop all books and require fresh snapshots. Call on WebSocket disconnect so
   * post-reconnect deltas cannot mark pre-disconnect depth as fresh (MKT-1).
   */
  invalidateAll(reason = 'resync required'): void {
    const cleared = this.books.size;
    this.books.clear();
    this.syncedMarkets.clear();
    this.logger.warn('Order books invalidated; awaiting snapshots', { reason, cleared });
  }

  getAllBooks(): OrderBook[] {
    return Array.from(this.books.entries())
      .filter(([marketId]) => this.syncedMarkets.has(marketId))
      .map(([, book]) => book);
  }

  removeBook(marketId: string): void {
    this.books.delete(marketId);
    this.syncedMarkets.delete(marketId);
    this.logger.debug(`Removed order book for ${marketId}`);
  }

  clear(): void {
    this.invalidateAll('clear');
  }
}

// Global singleton
const orderBookManagerSingleton = createSingleton(() => new OrderBookManager());
export const getOrderBookManager = orderBookManagerSingleton.get;
export const resetOrderBookManager = orderBookManagerSingleton.reset;
