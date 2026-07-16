import { solveLP } from '../optimization/lp-solver.js';

const NUMERICAL_TOLERANCE = 1e-8;

/**
 * An explicit exhaustive terminal state for a group of related markets.
 * `payouts[i]` is the dollar redemption value of `marketIds[i]` in this state.
 */
export interface PayoffScenario {
  id: string;
  payouts: number[];
}

/**
 * Cross-market relationships cannot be inferred from quoted probabilities.
 * This model makes the relationship auditable by enumerating every feasible
 * terminal state and each outcome token's redemption value in that state.
 */
export interface CrossMarketPayoffModel {
  id: string;
  marketIds: string[];
  scenarios: PayoffScenario[];
  /** Conservative fee buffer applied to ask notional. */
  feeBufferBps: number;
  /** Normalize the covering portfolio to at least this payout in every state. */
  targetPayoutUsd?: number;
  /** Ignore smaller opportunities after fees. */
  minGuaranteedProfitUsd?: number;
}

export interface ExecutableAskQuote {
  marketId: string;
  askPrice: number;
  availableSize: number;
}

export interface DollarPayoffOpportunity {
  modelId: string;
  marketIds: string[];
  quantities: number[];
  askPrices: number[];
  grossCostUsd: number;
  feeBufferUsd: number;
  totalCostUsd: number;
  guaranteedPayoutUsd: number;
  guaranteedProfitUsd: number;
  returnOnCost: number;
  scenarioProfitsUsd: { scenarioId: string; profitUsd: number }[];
}

/**
 * Find the cheapest long-only portfolio whose terminal payout is at least the
 * target in every explicitly feasible state. The result is denominated in USD:
 *
 *   minimize sum(effectiveAsk[j] * quantity[j])
 *   s.t.     sum(payoff[state][j] * quantity[j]) >= target, for every state
 *            0 <= quantity[j] <= displayed best-ask size[j]
 *
 * A profitable solution is an executable complete-cover arbitrage at the
 * displayed top of book. It deliberately does not model short selling.
 */
export function findDollarPayoffArbitrage(
  model: CrossMarketPayoffModel,
  quotes: readonly ExecutableAskQuote[]
): DollarPayoffOpportunity | null {
  validatePayoffModel(model);

  const quoteByMarket = new Map(quotes.map((quote) => [quote.marketId, quote]));
  const orderedQuotes = model.marketIds.map((marketId) => quoteByMarket.get(marketId));
  if (orderedQuotes.some((quote) => quote === undefined)) {
    return null;
  }

  const concreteQuotes = orderedQuotes as ExecutableAskQuote[];
  for (const quote of concreteQuotes) {
    if (
      !Number.isFinite(quote.askPrice) ||
      quote.askPrice <= 0 ||
      quote.askPrice >= 1 ||
      !Number.isFinite(quote.availableSize) ||
      quote.availableSize <= 0
    ) {
      return null;
    }
  }

  const targetPayoutUsd = model.targetPayoutUsd ?? 1;
  const feeMultiplier = 1 + model.feeBufferBps / 10_000;
  const effectiveCosts = concreteQuotes.map((quote) => quote.askPrice * feeMultiplier);
  const solution = solveLP({
    objective: effectiveCosts,
    inequalityMatrix: model.scenarios.map((scenario) => scenario.payouts.map((value) => -value)),
    inequalityRhs: model.scenarios.map(() => -targetPayoutUsd),
    lowerBounds: model.marketIds.map(() => 0),
    upperBounds: concreteQuotes.map((quote) => quote.availableSize),
  });

  if (solution.status !== 'optimal') {
    return null;
  }

  const quantities = solution.solution.map((quantity) =>
    Math.abs(quantity) <= NUMERICAL_TOLERANCE ? 0 : quantity
  );
  if (quantities.filter((quantity) => quantity > NUMERICAL_TOLERANCE).length < 2) {
    return null;
  }

  const grossCostUsd = dot(
    concreteQuotes.map((quote) => quote.askPrice),
    quantities
  );
  const totalCostUsd = dot(effectiveCosts, quantities);
  const feeBufferUsd = totalCostUsd - grossCostUsd;
  const scenarioProfitsUsd = model.scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    profitUsd: dot(scenario.payouts, quantities) - totalCostUsd,
  }));
  const guaranteedProfitUsd = Math.min(...scenarioProfitsUsd.map((scenario) => scenario.profitUsd));
  const guaranteedPayoutUsd = guaranteedProfitUsd + totalCostUsd;
  const minProfit = model.minGuaranteedProfitUsd ?? 0;

  if (guaranteedProfitUsd <= minProfit + NUMERICAL_TOLERANCE || totalCostUsd <= 0) {
    return null;
  }

  return {
    modelId: model.id,
    marketIds: [...model.marketIds],
    quantities,
    askPrices: concreteQuotes.map((quote) => quote.askPrice),
    grossCostUsd,
    feeBufferUsd,
    totalCostUsd,
    guaranteedPayoutUsd,
    guaranteedProfitUsd,
    returnOnCost: guaranteedProfitUsd / totalCostUsd,
    scenarioProfitsUsd,
  };
}

export function validatePayoffModel(model: CrossMarketPayoffModel): void {
  if (model.id.trim() === '') {
    throw new Error('Payoff model id is required');
  }
  if (model.marketIds.length < 2 || new Set(model.marketIds).size !== model.marketIds.length) {
    throw new Error(`Payoff model ${model.id} must contain at least two unique market ids`);
  }
  if (model.scenarios.length < 2) {
    throw new Error(`Payoff model ${model.id} must enumerate at least two feasible scenarios`);
  }
  if (!Number.isFinite(model.feeBufferBps) || model.feeBufferBps < 0) {
    throw new Error(`Payoff model ${model.id} has an invalid fee buffer`);
  }

  const scenarioIds = new Set<string>();
  for (const scenario of model.scenarios) {
    if (scenario.id.trim() === '' || scenarioIds.has(scenario.id)) {
      throw new Error(`Payoff model ${model.id} has a missing or duplicate scenario id`);
    }
    scenarioIds.add(scenario.id);
    if (scenario.payouts.length !== model.marketIds.length) {
      throw new Error(`Payoff model ${model.id} scenario ${scenario.id} has the wrong dimension`);
    }
    if (scenario.payouts.some((payout) => !Number.isFinite(payout) || payout < 0)) {
      throw new Error(`Payoff model ${model.id} scenario ${scenario.id} has an invalid payout`);
    }
  }

  const target = model.targetPayoutUsd ?? 1;
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error(`Payoff model ${model.id} has an invalid target payout`);
  }
  const minProfit = model.minGuaranteedProfitUsd ?? 0;
  if (!Number.isFinite(minProfit) || minProfit < 0) {
    throw new Error(`Payoff model ${model.id} has an invalid minimum profit`);
  }
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}
