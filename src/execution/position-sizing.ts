/**
 * Position Sizing using Modified Kelly Criterion
 *
 * Calculates optimal position sizes based on:
 * - Edge (probability of winning)
 * - Odds (payoff ratio)
 * - Order book depth (liquidity constraints)
 * - Risk limits
 *
 * Modified Kelly formula: f = (b*p - q) / b * sqrt(p)
 * where:
 * - f = fraction of capital to bet
 * - b = odds (net profit per unit bet)
 * - p = probability of winning
 * - q = probability of losing = 1 - p
 */

import { getLogger } from '../utils/logger.js';
import { TRADING_CONFIG, KELLY_CONFIG, RISK_CONFIG } from '../utils/config.js';
import { OrderBook } from '../market/order-book.js';

export interface PositionSizingInput {
  /** Probability of winning (edge) */
  probability: number;
  /** Current market price (odds) */
  price: number;
  /** Available capital */
  capital: number;
  /** Order book for liquidity analysis */
  orderBook: OrderBook;
  /** Side of the trade */
  side: 'buy' | 'sell';
}

export interface PositionSizingResult {
  /** Recommended position size */
  size: number;
  /** Fraction of capital to use */
  fraction: number;
  /** Expected value */
  expectedValue: number;
  /** Risk-adjusted return */
  riskAdjustedReturn: number;
  /** Constraint applied */
  constraint: 'kelly' | 'liquidity' | 'risk' | 'max_bet';
}

export interface MultiLegPositionSizing {
  /** Position sizes for each leg */
  sizes: number[];
  /** Total capital required */
  totalCapital: number;
  /** Risk metrics */
  riskMetrics: {
    maxLoss: number;
    expectedProfit: number;
    sharpeRatio: number;
  };
}

const logger = getLogger().child({ module: 'PositionSizing' });

/**
 * Calculate position size using modified Kelly criterion
 *
 * @param input Position sizing parameters
 * @returns Position sizing result
 */
export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
  const { probability, price, capital, orderBook, side } = input;

  // Validate inputs
  if (probability <= 0 || probability >= 1) {
    throw new Error('Probability must be between 0 and 1');
  }
  if (price <= 0 || price >= 1) {
    throw new Error('Price must be between 0 and 1');
  }

  // Calculate Kelly fraction
  const b = side === 'buy' ? (1 - price) / price : price / (1 - price);
  const p = probability;
  const q = 1 - p;

  // Standard Kelly: f = (b*p - q) / b
  const kellyFraction = (b * p - q) / b;

  // Modified Kelly: multiply by sqrt(p) for conservative sizing
  const modifiedKellyFraction = kellyFraction * Math.sqrt(p);

  // Apply Kelly fraction multiplier (conservative)
  const adjustedFraction = modifiedKellyFraction * KELLY_CONFIG.KELLY_FRACTION;

  logger.debug('Kelly calculation', {
    probability: p,
    price,
    odds: b,
    kellyFraction,
    modifiedKellyFraction,
    adjustedFraction,
  });

  // Check if Kelly suggests betting
  if (adjustedFraction <= 0) {
    return {
      size: 0,
      fraction: 0,
      expectedValue: 0,
      riskAdjustedReturn: 0,
      constraint: 'kelly',
    };
  }

  // Calculate raw position size
  let size = adjustedFraction * capital;
  let constraint: PositionSizingResult['constraint'] = 'kelly';

  // Apply maximum bet fraction limit
  const maxBetSize = KELLY_CONFIG.MAX_BET_FRACTION * capital;
  if (size > maxBetSize) {
    size = maxBetSize;
    constraint = 'max_bet';
  }

  // Check liquidity constraints
  const maxLiquiditySize = orderBook.getMaxExecutableSize(side);
  const liquidityLimit = maxLiquiditySize * TRADING_CONFIG.MAX_POSITION_PCT;

  if (size > liquidityLimit) {
    size = liquidityLimit;
    constraint = 'liquidity';
  }

  // Check risk limits
  const maxRiskSize = RISK_CONFIG.MAX_EXPOSURE * TRADING_CONFIG.MAX_POSITION_PCT;
  if (size > maxRiskSize) {
    size = maxRiskSize;
    constraint = 'risk';
  }

  // Calculate expected value
  const expectedValue = side === 'buy'
    ? size * (probability * (1 - price) - (1 - probability) * price)
    : size * ((1 - probability) * price - probability * (1 - price));

  // Calculate risk-adjusted return (simplified Sharpe-like ratio)
  const variance = probability * (1 - probability);
  const riskAdjustedReturn = variance > 0 ? expectedValue / (size * Math.sqrt(variance)) : 0;

  return {
    size,
    fraction: size / capital,
    expectedValue,
    riskAdjustedReturn,
    constraint,
  };
}

/**
 * Calculate position sizes for multi-legged arbitrage
 *
 * @param probabilities Probabilities for each outcome
 * @param prices Current market prices
 * @param capital Available capital
 * @param orderBooks Order books for each market
 * @returns Multi-leg position sizing result
 */
export function calculateMultiLegPositionSize(
  probabilities: number[],
  prices: number[],
  capital: number,
  orderBooks: OrderBook[]
): MultiLegPositionSizing {
  if (probabilities.length !== prices.length || prices.length !== orderBooks.length) {
    throw new Error('Input arrays must have the same length');
  }

  const n = probabilities.length;
  const sizes: number[] = new Array(n).fill(0);

  // Calculate individual position sizes
  for (let i = 0; i < n; i++) {
    const result = calculatePositionSize({
      probability: probabilities[i]!,
      price: prices[i]!,
      capital: capital / n, // Split capital equally
      orderBook: orderBooks[i]!,
      side: probabilities[i]! > prices[i]! ? 'buy' : 'sell',
    });

    sizes[i] = result.size;
  }

  // Normalize sizes to ensure balanced exposure
  const totalSize = sizes.reduce((sum, s) => sum + s, 0);
  const normalizedSizes = sizes.map((s) => (totalSize > 0 ? (s / totalSize) * capital * KELLY_CONFIG.MAX_BET_FRACTION : 0));

  // Calculate risk metrics
  let maxLoss = 0;
  let expectedProfit = 0;

  for (let i = 0; i < n; i++) {
    const p = probabilities[i]!;
    const price = prices[i]!;
    const size = normalizedSizes[i]!;

    // Maximum loss is the full position size
    maxLoss += size;

    // Expected profit
    const profit = p > price
      ? size * (p * (1 - price) - (1 - p) * price)
      : size * ((1 - p) * price - p * (1 - price));
    expectedProfit += profit;
  }

  // Simplified Sharpe ratio
  const sharpeRatio = maxLoss > 0 ? expectedProfit / maxLoss : 0;

  return {
    sizes: normalizedSizes,
    totalCapital: normalizedSizes.reduce((sum, s) => sum + s, 0),
    riskMetrics: {
      maxLoss,
      expectedProfit,
      sharpeRatio,
    },
  };
}

/**
 * Calculate position size for single-market arbitrage (YES/NO)
 *
 * @param yesPrice Price of YES token
 * @param noPrice Price of NO token
 * @param capital Available capital
 * @param yesOrderBook Order book for YES market
 * @param noOrderBook Order book for NO market
 * @returns Position sizes for YES and NO
 */
export function calculateSingleMarketArbitrageSize(
  yesPrice: number,
  noPrice: number,
  capital: number,
  yesOrderBook: OrderBook,
  noOrderBook: OrderBook
): { yesSize: number; noSize: number; expectedProfit: number } {
  const sum = yesPrice + noPrice;

  if (sum >= 1) {
    // No arbitrage opportunity
    return { yesSize: 0, noSize: 0, expectedProfit: 0 };
  }

  // Arbitrage: buy both YES and NO
  const profitPerUnit = 1 - sum;

  // Calculate max size based on liquidity
  const yesLiquidity = yesOrderBook.getMaxExecutableSize('buy');
  const noLiquidity = noOrderBook.getMaxExecutableSize('buy');

  // Size is limited by the smaller liquidity
  const maxSize = Math.min(yesLiquidity, noLiquidity) * TRADING_CONFIG.MAX_POSITION_PCT;

  // Also limited by capital
  const capitalConstrainedSize = capital * KELLY_CONFIG.MAX_BET_FRACTION / (yesPrice + noPrice);

  const size = Math.min(maxSize, capitalConstrainedSize);

  return {
    yesSize: size,
    noSize: size,
    expectedProfit: size * profitPerUnit,
  };
}

/**
 * Validate position size against risk limits
 *
 * @param size Position size
 * @param capital Available capital
 * @param currentExposure Current exposure
 * @returns Whether the position is within risk limits
 */
export function validateRiskLimits(
  size: number,
  capital: number,
  currentExposure: number
): { valid: boolean; reason?: string } {
  // Check max exposure
  if (currentExposure + size > RISK_CONFIG.MAX_EXPOSURE) {
    return {
      valid: false,
      reason: `Position would exceed max exposure: ${currentExposure + size} > ${RISK_CONFIG.MAX_EXPOSURE}`,
    };
  }

  // Check max bet fraction
  if (size > capital * KELLY_CONFIG.MAX_BET_FRACTION) {
    return {
      valid: false,
      reason: `Position exceeds max bet fraction: ${size} > ${capital * KELLY_CONFIG.MAX_BET_FRACTION}`,
    };
  }

  return { valid: true };
}

/**
 * Adjust position size for slippage
 *
 * @param size Original position size
 * @param expectedSlippage Expected slippage percentage
 * @returns Adjusted position size
 */
export function adjustForSlippage(size: number, expectedSlippage: number): number {
  // Reduce size if slippage is high
  if (expectedSlippage > TRADING_CONFIG.SLIPPAGE_TOLERANCE) {
    const slippageFactor = TRADING_CONFIG.SLIPPAGE_TOLERANCE / expectedSlippage;
    return size * slippageFactor;
  }
  return size;
}
