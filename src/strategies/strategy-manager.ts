/**
 * Strategy Manager
 *
 * Coordinates multiple trading strategies and manages signal aggregation
 */

import { BaseStrategy, type StrategyMarketData, type TradeSignal } from './base.js';
import { SimpleArbitrageStrategy, type SimpleArbitrageConfig } from './simple-arbitrage.js';
import {
  CrossMarketArbitrageStrategy,
  type CrossMarketArbitrageConfig,
} from './cross-market-arbitrage.js';
import { MarketMakingStrategy, type MarketMakingConfig } from './market-making.js';
import { TrendFollowingStrategy, type TrendFollowingConfig } from './trend-following.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  aggregateSignals,
  type AggregationMode,
  type AggregatedSignal,
  type SignalWithStrategy,
} from './signal-aggregation.js';

export type { AggregatedSignal, AggregationMode };

export interface StrategyManagerConfig {
  /** Enable simple arbitrage */
  simpleArbitrage?: SimpleArbitrageConfig;
  /** Enable cross-market arbitrage */
  crossMarketArbitrage?: CrossMarketArbitrageConfig;
  /** Enable market making */
  marketMaking?: MarketMakingConfig;
  /** Enable trend following */
  trendFollowing?: TrendFollowingConfig;
  /** Signal aggregation mode */
  aggregationMode: AggregationMode;
  /** Minimum consensus for trade (0-1) */
  minConsensus: number;
}

export class StrategyManager {
  private strategies: Map<string, BaseStrategy> = new Map();
  private config: StrategyManagerConfig;
  private logger = getLogger().child({ module: 'StrategyManager' });
  private signalHistory: TradeSignal[] = [];
  private maxHistorySize = 100;

  constructor(config: Partial<StrategyManagerConfig> = {}) {
    this.config = {
      aggregationMode: 'priority',
      minConsensus: 0.5,
      ...config,
    };

    this.initializeStrategies();
  }

  /**
   * Initialize strategies based on configuration
   */
  private initializeStrategies(): void {
    if (this.config.simpleArbitrage) {
      this.strategies.set(
        'simple-arbitrage',
        new SimpleArbitrageStrategy(this.config.simpleArbitrage)
      );
      this.logger.info('Simple arbitrage strategy initialized');
    }

    if (this.config.crossMarketArbitrage) {
      this.strategies.set(
        'cross-market-arbitrage',
        new CrossMarketArbitrageStrategy(this.config.crossMarketArbitrage)
      );
      this.logger.info('Cross-market arbitrage strategy initialized');
    }

    if (this.config.marketMaking) {
      this.strategies.set('market-making', new MarketMakingStrategy(this.config.marketMaking));
      this.logger.info('Market making strategy initialized');
    }

    if (this.config.trendFollowing) {
      this.strategies.set(
        'trend-following',
        new TrendFollowingStrategy(this.config.trendFollowing)
      );
      this.logger.info('Trend following strategy initialized');
    }

    if (this.strategies.size === 0) {
      this.logger.warn('No strategies initialized');
    }
  }

  /**
   * Analyze market data with all strategies
   */
  analyze(data: StrategyMarketData[]): AggregatedSignal | null {
    const signals: { strategy: string; signal: TradeSignal }[] = [];

    // Collect signals from all strategies
    for (const [name, strategy] of this.strategies) {
      try {
        const signal = strategy.analyze(data);
        if (signal) {
          signals.push({ strategy: name, signal });
        }
      } catch (error) {
        this.logger.error(`Strategy ${name} failed`, {
          error: getErrorMessage(error),
        });
      }
    }

    if (signals.length === 0) return null;

    // Aggregate signals
    const aggregated = this.aggregateSignals(signals);

    if (aggregated) {
      this.recordSignal(aggregated.signal);
    }

    return aggregated;
  }

  /**
   * Aggregate signals based on configured mode
   */
  private aggregateSignals(signals: SignalWithStrategy[]): AggregatedSignal | null {
    return aggregateSignals(
      signals,
      this.config.aggregationMode,
      this.strategies.size,
      this.config.minConsensus
    );
  }

  /**
   * Record signal to history
   */
  private recordSignal(signal: TradeSignal): void {
    this.signalHistory.push(signal);
    if (this.signalHistory.length > this.maxHistorySize) {
      this.signalHistory.shift();
    }
  }

  /**
   * Get all strategies
   */
  getStrategies(): Map<string, BaseStrategy> {
    return new Map(this.strategies);
  }

  /**
   * Get specific strategy
   */
  getStrategy(name: string): BaseStrategy | undefined {
    return this.strategies.get(name);
  }

  /**
   * Enable/disable strategy
   */
  setStrategyEnabled(name: string, enabled: boolean): void {
    const strategy = this.strategies.get(name);
    if (strategy) {
      strategy.updateConfig({ enabled });
      this.logger.info(`Strategy ${name} ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  /**
   * Get signal history
   */
  getSignalHistory(): TradeSignal[] {
    return [...this.signalHistory];
  }

  /**
   * Clear signal history
   */
  clearHistory(): void {
    this.signalHistory = [];
  }
}
