/**
 * Simple Arbitrage Strategy
 *
 * Detects and executes single-market arbitrage opportunities
 * where YES + NO prices don't sum to $1
 */

import { BaseStrategy, type StrategyMarketData, type TradeSignal, type StrategyConfig } from './base.js';

export interface SimpleArbitrageConfig extends StrategyConfig {
  /** Minimum profit threshold ($) */
  minProfitThreshold: number;
  /** Maximum slippage tolerance (0-1) */
  maxSlippage: number;
}

/**
 * Simple arbitrage opportunity between YES/NO tokens
 */
export interface SimpleArbitrageOpportunity {
  yesMarketId: string;
  noMarketId: string;
  yesPrice: number;
  noPrice: number;
  impliedProbability: number;
  profit: number;
  tradeDirection: 'buy_pair' | 'sell_pair';
}

export class SimpleArbitrageStrategy extends BaseStrategy {
  private arbitrageConfig: SimpleArbitrageConfig;

  constructor(config: Partial<SimpleArbitrageConfig> = {}) {
    super('SimpleArbitrage', config);
    this.arbitrageConfig = {
      minProfitThreshold: 0.02,
      maxSlippage: 0.01,
      ...config,
    };
  }

  /**
   * Analyze YES/NO pair for arbitrage opportunity
   */
  analyze(data: StrategyMarketData[]): TradeSignal | null {
    if (!this.canTrade()) return null;

    const opportunity = this.findArbitrageOpportunity(data);
    if (!opportunity || opportunity.profit < this.arbitrageConfig.minProfitThreshold) {
      return null;
    }

    const confidence = Math.min(opportunity.profit * 10, 1.0);
    if (confidence < (this.config.minConfidence ?? 0.5)) return null;

    this.recordTrade();

    const size = this.calculatePositionSize(opportunity);
    const isBuyPair = opportunity.tradeDirection === 'buy_pair';
    const marketId = isBuyPair
      ? (opportunity.yesPrice <= opportunity.noPrice ? opportunity.yesMarketId : opportunity.noMarketId)
      : (opportunity.yesPrice >= opportunity.noPrice ? opportunity.yesMarketId : opportunity.noMarketId);

    const pairedLegs = [
      {
        marketId: opportunity.yesMarketId,
        side: isBuyPair ? 'buy' as const : 'sell' as const,
        size,
        price: opportunity.yesPrice,
      },
      {
        marketId: opportunity.noMarketId,
        side: isBuyPair ? 'buy' as const : 'sell' as const,
        size,
        price: opportunity.noPrice,
      },
    ];

    return {
      type: isBuyPair ? 'buy' : 'sell',
      marketId,
      size,
      price: marketId === opportunity.yesMarketId ? opportunity.yesPrice : opportunity.noPrice,
      confidence,
      reason: `Simple arbitrage: ${opportunity.tradeDirection}, profit=${opportunity.profit.toFixed(4)}`,
      metadata: {
        arbitrageType: 'simple',
        yesPrice: opportunity.yesPrice,
        noPrice: opportunity.noPrice,
        impliedProbability: opportunity.impliedProbability,
        expectedProfit: opportunity.profit,
        pairedLegs,
      },
    };
  }

  /**
   * Find arbitrage opportunity between YES/NO markets
   */
  private findArbitrageOpportunity(data: StrategyMarketData[]): SimpleArbitrageOpportunity | null {
    // Group markets by event (assuming YES/NO naming convention)
    const pairs = this.groupByEvent(data);

    for (const [, markets] of pairs) {
      if (markets.yes && markets.no) {
        const yesPrice = this.getBestAsk(markets.yes);
        const noPrice = this.getBestAsk(markets.no);

        if (yesPrice === null || noPrice === null) continue;

        const sum = yesPrice + noPrice;

        // If sum < 1, we can buy both and guarantee profit
        if (sum < 1 - this.arbitrageConfig.minProfitThreshold) {
          return {
            yesMarketId: markets.yes.marketId,
            noMarketId: markets.no.marketId,
            yesPrice,
            noPrice,
            impliedProbability: yesPrice / sum,
            profit: 1 - sum,
            tradeDirection: 'buy_pair',
          };
        }

        // Check if we can sell both (implied by bid prices)
        const yesBid = this.getBestBid(markets.yes);
        const noBid = this.getBestBid(markets.no);

        if (yesBid !== null && noBid !== null) {
          const bidSum = yesBid + noBid;
          if (bidSum > 1 + this.arbitrageConfig.minProfitThreshold) {
            return {
              yesMarketId: markets.yes.marketId,
              noMarketId: markets.no.marketId,
              yesPrice: yesBid,
              noPrice: noBid,
              impliedProbability: yesBid / bidSum,
              profit: bidSum - 1,
              tradeDirection: 'sell_pair',
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Group markets by event ID
   */
  private groupByEvent(data: StrategyMarketData[]): Map<string, { yes?: StrategyMarketData; no?: StrategyMarketData }> {
    const pairs = new Map<string, { yes?: StrategyMarketData; no?: StrategyMarketData }>();

    for (const market of data) {
      // Parse event ID from market ID (assumes format: event-yes or event-no)
      const marketId = market.marketId.toLowerCase();

      if (marketId.includes('-yes') || marketId.includes('_yes')) {
        const eventId = marketId.replace(/-yes$/, '').replace(/_yes$/, '');
        const current = pairs.get(eventId) ?? {};
        current.yes = market;
        pairs.set(eventId, current);
      } else if (marketId.includes('-no') || marketId.includes('_no')) {
        const eventId = marketId.replace(/-no$/, '').replace(/_no$/, '');
        const current = pairs.get(eventId) ?? {};
        current.no = market;
        pairs.set(eventId, current);
      }
    }

    return pairs;
  }

  /**
   * Get best ask price from order book
   */
  private getBestBid(market: StrategyMarketData): number | null {
    const bestBid = market.orderBook.getBestBid();
    return bestBid?.price ?? null;
  }

  /**
   * Get best ask price from order book
   */
  private getBestAsk(market: StrategyMarketData): number | null {
    const bestAsk = market.orderBook.getBestAsk();
    return bestAsk?.price ?? null;
  }

  /**
   * Calculate position size based on opportunity
   */
  private calculatePositionSize(opportunity: SimpleArbitrageOpportunity): number {
    // Simple sizing: scale with profit
    const baseSize = 100;
    const profitMultiplier = Math.min(opportunity.profit * 10, 5);
    return Math.min(baseSize * profitMultiplier, this.config.maxPositionSize ?? 1000);
  }

  /**
   * Update arbitrage-specific configuration
   */
  updateArbitrageConfig(config: Partial<SimpleArbitrageConfig>): void {
    this.arbitrageConfig = { ...this.arbitrageConfig, ...config };
  }
}
