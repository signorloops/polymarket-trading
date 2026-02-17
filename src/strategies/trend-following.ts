/**
 * Trend Following Strategy
 *
 * Identifies and follows price trends using technical indicators
 * Suitable for prediction markets with momentum
 */

import { BaseStrategy, type StrategyMarketData, type TradeSignal, type StrategyConfig } from './base.js';

export interface TrendFollowingConfig extends StrategyConfig {
  /** Short moving average period */
  shortPeriod: number;
  /** Long moving average period */
  longPeriod: number;
  /** RSI period */
  rsiPeriod: number;
  /** RSI overbought threshold */
  rsiOverbought: number;
  /** RSI oversold threshold */
  rsiOversold: number;
  /** Minimum trend strength (0-1) */
  minTrendStrength: number;
  /** Volume threshold for confirmation */
  volumeThreshold: number;
}

export interface TrendIndicators {
  sma: number;
  ema: number;
  rsi: number;
  trend: 'up' | 'down' | 'neutral';
  strength: number;
  volumeSignal: 'high' | 'normal' | 'low';
}

export class TrendFollowingStrategy extends BaseStrategy {
  private trendConfig: TrendFollowingConfig;
  private priceHistory: Map<string, number[]> = new Map();
  private volumeHistory: Map<string, number[]> = new Map();

  constructor(config: Partial<TrendFollowingConfig> = {}) {
    super('TrendFollowing', config);
    this.trendConfig = {
      shortPeriod: 10,
      longPeriod: 30,
      rsiPeriod: 14,
      rsiOverbought: 70,
      rsiOversold: 30,
      minTrendStrength: 0.3,
      volumeThreshold: 1.5,
      ...config,
    };
  }

  /**
   * Analyze market data for trend signals
   */
  analyze(data: StrategyMarketData[]): TradeSignal | null {
    if (!this.canTrade()) return null;

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
   * Analyze single market for trend
   */
  private analyzeMarket(market: StrategyMarketData): TradeSignal | null {
    // Update price history
    this.updateHistory(market);

    const prices = this.priceHistory.get(market.marketId) ?? [];
    if (prices.length < this.trendConfig.longPeriod) {
      return null; // Not enough data
    }

    const indicators = this.calculateIndicators(prices, market);

    // Check trend strength
    if (indicators.strength < this.trendConfig.minTrendStrength) {
      return null;
    }

    // Generate signal based on trend and RSI
    let signal: TradeSignal | null = null;

    if (indicators.trend === 'up' && indicators.rsi < this.trendConfig.rsiOverbought) {
      signal = {
        type: 'buy',
        marketId: market.marketId,
        size: this.calculatePositionSize(indicators),
        price: market.lastPrice,
        confidence: indicators.strength,
        reason: `Trend following: ${indicators.trend} trend, RSI=${indicators.rsi.toFixed(1)}, strength=${indicators.strength.toFixed(2)}`,
        metadata: {
          strategy: 'trend-following',
          indicators,
          sma: indicators.sma,
          ema: indicators.ema,
          rsi: indicators.rsi,
        },
      };
    } else if (indicators.trend === 'down' && indicators.rsi > this.trendConfig.rsiOversold) {
      signal = {
        type: 'sell',
        marketId: market.marketId,
        size: this.calculatePositionSize(indicators),
        price: market.lastPrice,
        confidence: indicators.strength,
        reason: `Trend following: ${indicators.trend} trend, RSI=${indicators.rsi.toFixed(1)}, strength=${indicators.strength.toFixed(2)}`,
        metadata: {
          strategy: 'trend-following',
          indicators,
          sma: indicators.sma,
          ema: indicators.ema,
          rsi: indicators.rsi,
        },
      };
    }

    return signal;
  }

  /**
   * Update price and volume history
   */
  private updateHistory(market: StrategyMarketData): void {
    const prices = this.priceHistory.get(market.marketId) ?? [];
    prices.push(market.lastPrice);

    // Keep only necessary history
    const maxPeriod = Math.max(
      this.trendConfig.longPeriod,
      this.trendConfig.rsiPeriod * 2
    );
    if (prices.length > maxPeriod * 2) {
      prices.shift();
    }

    this.priceHistory.set(market.marketId, prices);

    // Update volume if available (use order book depth as proxy)
    const depth = market.orderBook.getBidDepth() + market.orderBook.getAskDepth();
    const volumes = this.volumeHistory.get(market.marketId) ?? [];
    volumes.push(depth);

    if (volumes.length > maxPeriod * 2) {
      volumes.shift();
    }

    this.volumeHistory.set(market.marketId, volumes);
  }

  /**
   * Calculate technical indicators
   */
  private calculateIndicators(prices: number[], market: StrategyMarketData): TrendIndicators {
    const shortSMA = this.calculateSMA(prices, this.trendConfig.shortPeriod);
    const longSMA = this.calculateSMA(prices, this.trendConfig.longPeriod);
    const ema = this.calculateEMA(prices, this.trendConfig.shortPeriod);
    const rsi = this.calculateRSI(prices, this.trendConfig.rsiPeriod);

    // Determine trend
    let trend: 'up' | 'down' | 'neutral' = 'neutral';
    if (shortSMA > longSMA * 1.01) {
      trend = 'up';
    } else if (shortSMA < longSMA * 0.99) {
      trend = 'down';
    }

    // Calculate trend strength
    const trendDiff = Math.abs(shortSMA - longSMA) / longSMA;
    const strength = Math.min(1, trendDiff * 10);

    // Volume signal
    const volumes = this.volumeHistory.get(market.marketId) ?? [];
    const avgVolume = this.calculateSMA(volumes.slice(-this.trendConfig.shortPeriod), this.trendConfig.shortPeriod);
    const currentVolume = volumes[volumes.length - 1] ?? 0;
    let volumeSignal: 'high' | 'normal' | 'low' = 'normal';
    if (currentVolume > avgVolume * this.trendConfig.volumeThreshold) {
      volumeSignal = 'high';
    } else if (currentVolume < avgVolume / this.trendConfig.volumeThreshold) {
      volumeSignal = 'low';
    }

    return {
      sma: shortSMA,
      ema,
      rsi,
      trend,
      strength,
      volumeSignal,
    };
  }

  /**
   * Calculate Simple Moving Average
   */
  private calculateSMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] ?? 0;

    const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  /**
   * Calculate Exponential Moving Average
   */
  private calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0;
    const firstPrice = prices[0];
    if (firstPrice === undefined) return 0;
    if (prices.length === 1) return firstPrice;

    const multiplier = 2 / (period + 1);
    let ema = firstPrice;

    for (let i = 1; i < prices.length; i++) {
      const price = prices[i];
      if (price === undefined) continue;
      ema = (price - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Calculate Relative Strength Index
   */
  private calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    // Calculate initial averages
    for (let i = 1; i <= period; i++) {
      const currentPrice = prices[prices.length - period + i - 1];
      const prevPrice = prices[prices.length - period + i - 2];
      if (currentPrice === undefined || prevPrice === undefined) continue;
      const change = currentPrice - prevPrice;
      if (change > 0) {
        gains += change;
      } else {
        losses -= change;
      }
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate position size based on trend strength
   */
  private calculatePositionSize(indicators: TrendIndicators): number {
    const maxPositionSize = this.config.maxPositionSize ?? 1000;
    const baseSize = maxPositionSize * 0.2;
    const sizeMultiplier = indicators.strength * (indicators.volumeSignal === 'high' ? 1.5 : 1);
    return Math.min(baseSize * sizeMultiplier, maxPositionSize);
  }

  /**
   * Get price history for a market
   */
  getPriceHistory(marketId: string): number[] {
    return [...(this.priceHistory.get(marketId) ?? [])];
  }

  /**
   * Clear history for a market
   */
  clearHistory(marketId: string): void {
    this.priceHistory.delete(marketId);
    this.volumeHistory.delete(marketId);
  }
}
