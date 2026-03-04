/**
 * OrderBookManager - manages multiple order books across markets.
 */

import { getLogger } from '../utils/logger.js';
import { createSingleton } from '../utils/singleton.js';
import { OrderBook } from './order-book.js';

/**
 * OrderBookManager manages multiple order books
 */
export class OrderBookManager {
  private books: Map<string, OrderBook> = new Map();
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
    return this.books.get(marketId);
  }

  updateBook(
    marketId: string,
    bids: { price: number; size: number }[],
    asks: { price: number; size: number }[],
    timestamp?: number
  ): void {
    const book = this.getBook(marketId);
    book.update(bids, asks, timestamp);
  }

  getAllBooks(): OrderBook[] {
    return Array.from(this.books.values());
  }

  removeBook(marketId: string): void {
    this.books.delete(marketId);
    this.logger.debug(`Removed order book for ${marketId}`);
  }

  clear(): void {
    this.books.clear();
    this.logger.debug('Cleared all order books');
  }
}

// Global singleton
const orderBookManagerSingleton = createSingleton(() => new OrderBookManager());
export const getOrderBookManager = orderBookManagerSingleton.get;
export const resetOrderBookManager = orderBookManagerSingleton.reset;
