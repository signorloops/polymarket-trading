/**
 * Base strategy interface for all trading strategies
 */

import type { OrderBook } from '../market/order-book.js';
import type { ArbitrageOpportunity } from '../market/arbitrage-detector.js';

export interface StrategyMarketData {
  marketId: string;
  orderBook: OrderBook;
  lastPrice: number;
  timestamp: number;
}

export interface TradeSignal {
  type: 'buy' | 'sell' | 'hold';
  marketId: string;
  size: number;
  price: number;
  confidence: number;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface StrategyConfig {
  enabled?: boolean;
  maxPositionSize?: number;
  minConfidence?: number;
  cooldownMs?: number;
}

export abstract class BaseStrategy {
  protected config: StrategyConfig;
  protected lastTradeTime: number = 0;
  protected name: string;

  constructor(name: string, config: Partial<StrategyConfig> = {}) {
    this.name = name;
    this.config = {
      enabled: true,
      maxPositionSize: 1000,
      minConfidence: 0.5,
      cooldownMs: 1000,
      ...config,
    };
  }

  /**
   * Analyze market data and generate trade signals
   */
  abstract analyze(data: StrategyMarketData[]): TradeSignal | null;

  /**
   * Check if strategy can trade (cooldown, enabled, etc.)
   */
  protected canTrade(): boolean {
    if (this.config.enabled === false) return false;

    const now = Date.now();
    const cooldown = this.config.cooldownMs ?? 1000;
    if (now - this.lastTradeTime < cooldown) return false;

    return true;
  }

  /**
   * Record a trade execution
   */
  protected recordTrade(): void {
    this.lastTradeTime = Date.now();
  }

  /**
   * Get strategy name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get strategy configuration
   */
  getConfig(): StrategyConfig {
    return { ...this.config };
  }

  /**
   * Update strategy configuration
   */
  updateConfig(config: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
