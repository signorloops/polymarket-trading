/**
 * Trading Strategies
 *
 * Collection of trading strategies for prediction market arbitrage
 */

export {
  BaseStrategy,
  type StrategyMarketData,
  type TradeSignal,
  type StrategyConfig,
} from './base.js';

export {
  SimpleArbitrageStrategy,
  type SimpleArbitrageConfig,
  type SimpleArbitrageOpportunity,
} from './simple-arbitrage.js';

export {
  CrossMarketArbitrageStrategy,
  type CrossMarketArbitrageConfig,
  type CrossMarketOpportunity,
} from './cross-market-arbitrage.js';

export {
  MarketMakingStrategy,
  type MarketMakingConfig,
  type QuoteLevel,
} from './market-making.js';

export {
  TrendFollowingStrategy,
  type TrendFollowingConfig,
  type TrendIndicators,
} from './trend-following.js';

export {
  StrategyManager,
  type StrategyManagerConfig,
  type AggregatedSignal,
} from './strategy-manager.js';
