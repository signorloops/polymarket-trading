/**
 * Market Making Strategy
 *
 * Provides liquidity by placing bid/ask orders around fair value
 * Captures spread while managing inventory risk
 */

import { BaseStrategy, type StrategyMarketData, type TradeSignal, type StrategyConfig } from './base.js';

export interface MarketMakingConfig extends StrategyConfig {
  /** Spread to capture (0-1, e.g., 0.01 = 1%) */
  targetSpread: number;
  /** Maximum inventory imbalance (number of contracts) */
  maxInventory: number;
  /** Inventory skew factor (0-1, how much to skew quotes based on inventory) */
  inventorySkew: number;
  /** Order size */
  orderSize: number;
  /** Number of quote levels */
  quoteLevels: number;
  /** Size increase per level */
  sizeIncrement: number;
}

export interface QuoteLevel {
  price: number;
  size: number;
  side: 'buy' | 'sell';
}

export class MarketMakingStrategy extends BaseStrategy {
  private mmConfig: MarketMakingConfig;
  private inventory: Map<string, number> = new Map();
  private fairValues: Map<string, number> = new Map();

  constructor(config: Partial<MarketMakingConfig> = {}) {
    super('MarketMaking', config);
    this.mmConfig = {
      targetSpread: 0.02,
      maxInventory: 100,
      inventorySkew: 0.5,
      orderSize: 10,
      quoteLevels: 3,
      sizeIncrement: 1.5,
      ...config,
    };
  }

  /**
   * Analyze market for market making opportunities
   */
  analyze(data: StrategyMarketData[]): TradeSignal | null {
    if (!this.canTrade()) return null;

    // Process each market independently
    for (const market of data) {
      const signal = this.analyzeMarket(market);
      if (signal) {
        this.recordTrade();
        return signal;
      }
    }

    return null;
  }

  /**
   * Analyze single market for market making
   */
  private analyzeMarket(market: StrategyMarketData): TradeSignal | null {
    const fairValue = this.calculateFairValue(market);
    const currentInventory = this.inventory.get(market.marketId) ?? 0;

    // Check if we should adjust position due to inventory
    if (Math.abs(currentInventory) >= this.mmConfig.maxInventory) {
      // Need to reduce inventory - send aggressive order
      const direction = currentInventory > 0 ? 'sell' : 'buy';
      const reduceSize = Math.min(Math.abs(currentInventory) * 0.5, this.config.maxPositionSize ?? 1000);

      return {
        type: direction,
        marketId: market.marketId,
        size: reduceSize,
        price: direction === 'sell'
          ? market.orderBook.getBestBid()?.price ?? fairValue * 0.99
          : market.orderBook.getBestAsk()?.price ?? fairValue * 1.01,
        confidence: 0.8,
        reason: `Inventory reduction: ${currentInventory.toString()} contracts`,
        metadata: {
          strategy: 'market-making-inventory',
          fairValue,
          currentInventory,
        },
      };
    }

    // Generate quotes around fair value
    const quotes = this.generateQuotes(fairValue, currentInventory);

    // Find best quote to execute
    const bestQuote = this.findBestQuote(market, quotes);
    if (!bestQuote) return null;

    return {
      type: bestQuote.side,
      marketId: market.marketId,
      size: bestQuote.size,
      price: bestQuote.price,
      confidence: this.calculateQuoteConfidence(bestQuote, fairValue),
      reason: `Market making: ${bestQuote.side} @ ${bestQuote.price.toFixed(4)}`,
      metadata: {
        strategy: 'market-making',
        fairValue,
        spread: this.mmConfig.targetSpread,
        inventory: currentInventory,
        quoteLevel: quotes.findIndex((q) => q.price === bestQuote.price) + 1,
      },
    };
  }

  /**
   * Calculate fair value using microprice
   */
  private calculateFairValue(market: StrategyMarketData): number {
    const bestBid = market.orderBook.getBestBid();
    const bestAsk = market.orderBook.getBestAsk();

    if (!bestBid || !bestAsk) {
      return this.fairValues.get(market.marketId) ?? market.lastPrice;
    }

    // Microprice: weighted by inverse size
    const bidWeight = 1 / bestBid.size;
    const askWeight = 1 / bestAsk.size;
    const totalWeight = bidWeight + askWeight;

    const microPrice = (bestBid.price * askWeight + bestAsk.price * bidWeight) / totalWeight;

    // Update stored fair value with smoothing
    const alpha = 0.3; // Smoothing factor
    const prevFairValue = this.fairValues.get(market.marketId) ?? microPrice;
    const fairValue = alpha * microPrice + (1 - alpha) * prevFairValue;

    this.fairValues.set(market.marketId, fairValue);
    return fairValue;
  }

  /**
   * Generate quote levels around fair value
   */
  private generateQuotes(fairValue: number, inventory: number): QuoteLevel[] {
    const quotes: QuoteLevel[] = [];
    const halfSpread = this.mmConfig.targetSpread / 2;

    // Skew based on inventory
    const skew = Math.max(-1, Math.min(1, inventory / this.mmConfig.maxInventory));
    const skewOffset = skew * this.mmConfig.inventorySkew * halfSpread;

    for (let i = 0; i < this.mmConfig.quoteLevels; i++) {
      const levelSpread = halfSpread * (1 + i * 0.5);
      const size = this.mmConfig.orderSize * Math.pow(this.mmConfig.sizeIncrement, i);

      // Bid quote (skew moves it closer/farther from fair value)
      const bidPrice = fairValue * (1 - levelSpread + skewOffset);
      quotes.push({
        price: Math.max(0.01, Math.min(0.99, bidPrice)),
        size,
        side: 'buy',
      });

      // Ask quote
      const askPrice = fairValue * (1 + levelSpread + skewOffset);
      quotes.push({
        price: Math.max(0.01, Math.min(0.99, askPrice)),
        size,
        side: 'sell',
      });
    }

    return quotes.sort((a, b) => a.price - b.price);
  }

  /**
   * Find best executable quote
   */
  private findBestQuote(market: StrategyMarketData, quotes: QuoteLevel[]): QuoteLevel | null {
    const bestBid = market.orderBook.getBestBid();
    const bestAsk = market.orderBook.getBestAsk();

    if (!bestBid || !bestAsk) return null;

    // Find best buy quote that crosses the spread
    for (const quote of quotes.filter((q) => q.side === 'buy')) {
      if (quote.price >= bestAsk.price * 0.999) {
        return { ...quote, price: bestAsk.price };
      }
    }

    // Find best sell quote that crosses the spread
    for (const quote of quotes.filter((q) => q.side === 'sell').reverse()) {
      if (quote.price <= bestBid.price * 1.001) {
        return { ...quote, price: bestBid.price };
      }
    }

    return null;
  }

  /**
   * Calculate confidence for a quote
   */
  private calculateQuoteConfidence(quote: QuoteLevel, fairValue: number): number {
    const distanceFromFair = Math.abs(quote.price - fairValue) / fairValue;
    const spreadCapture = this.mmConfig.targetSpread / 2;

    // Higher confidence if we're capturing good spread
    return Math.min(0.95, 0.5 + (spreadCapture - distanceFromFair) * 10);
  }

  /**
   * Update inventory after trade
   */
  updateInventory(marketId: string, fillSize: number, side: 'buy' | 'sell'): void {
    const current = this.inventory.get(marketId) ?? 0;
    const delta = side === 'buy' ? fillSize : -fillSize;
    this.inventory.set(marketId, current + delta);
  }

  /**
   * Get current inventory for a market
   */
  getInventory(marketId: string): number {
    return this.inventory.get(marketId) ?? 0;
  }

  /**
   * Get all inventory positions
   */
  getAllInventory(): Map<string, number> {
    return new Map(this.inventory);
  }
}
