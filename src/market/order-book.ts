/**
 * Order Book reconstruction and analysis
 *
 * Maintains real-time order book state for multiple markets.
 * Provides:
 * - Price level aggregation
 * - VWAP (Volume Weighted Average Price) calculation
 * - Liquidity analysis
 * - Slippage estimation
 */

import { getLogger } from '../utils/logger.js';
import { TRADING_CONFIG } from '../utils/config.js';
import { SkipList } from './skip-list.js';

// Re-export OrderBookManager so existing imports keep working
export { OrderBookManager, getOrderBookManager, resetOrderBookManager } from './order-book-manager.js';

export interface PriceLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  marketId: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number;
  sequence: number;
}

export interface VWAPResult {
  vwap: number;
  totalSize: number;
  executedSize: number;
  remainingSize: number;
}

export interface LiquidityMetrics {
  bidDepth: number;
  askDepth: number;
  spread: number;
  midPrice: number;
  imbalance: number;
}

/**
 * OrderBook maintains the current state of an order book for a single market
 */
export class OrderBook {
  private marketId: string;
  private bids: Map<number, number> = new Map();
  private asks: Map<number, number> = new Map();
  private bidLevels = new SkipList();
  private askLevels = new SkipList();
  private bidDepth = 0;
  private askDepth = 0;
  private lastUpdate = 0;
  private sequence = 0;
  private logger = getLogger().child({ module: 'OrderBook' });

  constructor(marketId: string) {
    this.marketId = marketId;
  }

  /**
   * Update the order book with new data
   */
  update(
    bids: { price: number; size: number }[],
    asks: { price: number; size: number }[],
    timestamp?: number
  ): void {
    // Update bids
    for (const { price, size } of bids) {
      const prevSize = this.bids.get(price) ?? 0;
      if (size <= 0) {
        if (this.bids.delete(price)) {
          this.bidLevels.delete(price);
          this.bidDepth -= prevSize;
        }
      } else {
        if (this.bids.has(price)) {
          this.bidDepth += size - prevSize;
        } else {
          this.bidDepth += size;
        }
        this.bids.set(price, size);
        this.bidLevels.insert(price, size);
      }
    }

    // Update asks
    for (const { price, size } of asks) {
      const prevSize = this.asks.get(price) ?? 0;
      if (size <= 0) {
        if (this.asks.delete(price)) {
          this.askLevels.delete(price);
          this.askDepth -= prevSize;
        }
      } else {
        if (this.asks.has(price)) {
          this.askDepth += size - prevSize;
        } else {
          this.askDepth += size;
        }
        this.asks.set(price, size);
        this.askLevels.insert(price, size);
      }
    }

    this.lastUpdate = timestamp ?? Date.now();
    this.sequence++;
  }

  /**
   * Get current snapshot of the order book
   */
  getSnapshot(): OrderBookSnapshot {
    const sortedBids = this.getSortedBids();
    const sortedAsks = this.getSortedAsks();

    return {
      marketId: this.marketId,
      bids: sortedBids,
      asks: sortedAsks,
      timestamp: this.lastUpdate,
      sequence: this.sequence,
    };
  }

  /**
   * Get best bid (highest price)
   */
  getBestBid(): PriceLevel | null {
    const best = this.bidLevels.getLast();
    return best ? { price: best.price, size: best.size } : null;
  }

  /**
   * Get best ask (lowest price)
   */
  getBestAsk(): PriceLevel | null {
    const best = this.askLevels.getFirst();
    return best ? { price: best.price, size: best.size } : null;
  }

  /**
   * Get mid price (average of best bid and ask)
   */
  getMidPrice(): number | null {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();

    if (!bestBid || !bestAsk) {
      return null;
    }

    return (bestBid.price + bestAsk.price) / 2;
  }

  /**
   * Get spread (difference between best ask and best bid)
   */
  getSpread(): number | null {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();

    if (!bestBid || !bestAsk) {
      return null;
    }

    return bestAsk.price - bestBid.price;
  }

  /**
   * Calculate VWAP for a given order size
   */
  calculateVWAP(size: number, side: 'buy' | 'sell'): VWAPResult {
    const levels = side === 'buy' ? this.getSortedAsks() : this.getSortedBids();
    let remainingSize = size;
    let totalValue = 0;
    let executedSize = 0;

    for (const level of levels) {
      if (remainingSize <= 0) break;

      const sizeAtLevel = Math.min(remainingSize, level.size);
      totalValue += sizeAtLevel * level.price;
      executedSize += sizeAtLevel;
      remainingSize -= sizeAtLevel;
    }

    const vwap = executedSize > 0 ? totalValue / executedSize : 0;

    return {
      vwap,
      totalSize: size,
      executedSize,
      remainingSize: Math.max(0, remainingSize),
    };
  }

  /**
   * Calculate slippage for a given order size
   * Slippage = (VWAP - mid price) / mid price
   */
  calculateSlippage(size: number, side: 'buy' | 'sell'): number {
    const midPrice = this.getMidPrice();
    if (!midPrice || midPrice <= 0) {
      return Infinity;
    }

    const vwapResult = this.calculateVWAP(size, side);
    if (vwapResult.executedSize < size) {
      return Infinity; // Not enough liquidity
    }

    const vwap = vwapResult.vwap;
    return side === 'buy'
      ? (vwap - midPrice) / midPrice
      : (midPrice - vwap) / midPrice;
  }

  /**
   * Get liquidity metrics
   */
  getLiquidityMetrics(): LiquidityMetrics | null {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();

    if (!bestBid || !bestAsk) {
      return null;
    }

    const bidDepth = this.calculateDepth('bid');
    const askDepth = this.calculateDepth('ask');
    const spread = bestAsk.price - bestBid.price;
    const midPrice = (bestBid.price + bestAsk.price) / 2;
    const imbalance = (askDepth - bidDepth) / (askDepth + bidDepth);

    return {
      bidDepth,
      askDepth,
      spread,
      midPrice,
      imbalance,
    };
  }

  /**
   * Check if there's sufficient liquidity for a trade
   */
  hasSufficientLiquidity(size: number, side: 'buy' | 'sell'): boolean {
    const vwapResult = this.calculateVWAP(size, side);

    // Check if we can execute the full size
    if (vwapResult.remainingSize > 0) {
      return false;
    }

    // Check slippage tolerance
    const slippage = this.calculateSlippage(size, side);
    return slippage <= TRADING_CONFIG.SLIPPAGE_TOLERANCE;
  }

  /**
   * Get maximum executable size within slippage tolerance
   */
  getMaxExecutableSize(side: 'buy' | 'sell'): number {
    const levels = side === 'buy' ? this.getSortedAsks() : this.getSortedBids();
    const midPrice = this.getMidPrice();

    if (!midPrice || levels.length === 0) {
      return 0;
    }

    let totalSize = 0;
    let totalValue = 0;

    for (const level of levels) {
      const newTotalSize = totalSize + level.size;
      const newTotalValue = totalValue + level.size * level.price;
      const vwap = newTotalValue / newTotalSize;

      const slippage =
        side === 'buy'
          ? (vwap - midPrice) / midPrice
          : (midPrice - vwap) / midPrice;

      if (slippage > TRADING_CONFIG.SLIPPAGE_TOLERANCE) {
        // Calculate partial fill that stays within tolerance
        const remainingSlippage = TRADING_CONFIG.SLIPPAGE_TOLERANCE -
          this.calculateSlippageForValue(totalValue, totalSize, midPrice, side);

        if (remainingSlippage <= 0) {
          return totalSize;
        }

        // Approximate additional size
        const priceDeviation = Math.abs(level.price - midPrice) / midPrice;
        const additionalSize = (remainingSlippage * totalSize) / Math.max(priceDeviation, 0.001);
        return totalSize + Math.min(additionalSize, level.size);
      }

      totalSize = newTotalSize;
      totalValue = newTotalValue;
    }

    return totalSize;
  }

  /**
   * Clear the order book
   */
  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.bidLevels = new SkipList();
    this.askLevels = new SkipList();
    this.bidDepth = 0;
    this.askDepth = 0;
    this.sequence = 0;
  }

  private getSortedBids(): PriceLevel[] {
    return this.bidLevels.toArrayDescending();
  }

  private getSortedAsks(): PriceLevel[] {
    return this.askLevels.toArray();
  }

  /**
   * Get total bid depth (sum of all bid sizes)
   */
  getBidDepth(): number {
    return this.calculateDepth('bid');
  }

  /**
   * Get total ask depth (sum of all ask sizes)
   */
  getAskDepth(): number {
    return this.calculateDepth('ask');
  }

  private calculateDepth(side: 'bid' | 'ask'): number {
    return side === 'bid' ? this.bidDepth : this.askDepth;
  }

  private calculateSlippageForValue(
    totalValue: number,
    totalSize: number,
    midPrice: number,
    side: 'buy' | 'sell'
  ): number {
    if (totalSize <= 0) return 0;
    const vwap = totalValue / totalSize;
    return side === 'buy'
      ? (vwap - midPrice) / midPrice
      : (midPrice - vwap) / midPrice;
  }
}

