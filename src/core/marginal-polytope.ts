/**
 * Marginal Polytope representation for arbitrage detection
 *
 * The marginal polytope M represents the convex hull of all valid payoff vectors
 * for a set of related prediction markets. Each vertex corresponds to a possible
 * outcome of the underlying events.
 */

import { getLogger } from '../utils/logger.js';

export interface Market {
  id: string;
  eventId: string;
  outcome: string; // 'YES' or 'NO'
  price: number; // Current price [0, 1]
}

export interface Event {
  id: string;
  markets: Market[];
  outcomes: string[]; // Possible outcomes for this event
}

export interface PolytopeConstraint {
  type: 'equality' | 'inequality';
  coefficients: number[];
  rhs: number;
  description: string;
}

/**
 * MarginalPolytope represents the feasible region for arbitrage trades
 *
 * For a set of related markets, the polytope encodes:
 * 1. Probability constraints (sum to 1)
 * 2. Market price consistency
 * 3. Event outcome exclusivity
 */
export class MarginalPolytope {
  private events: Map<string, Event>;
  private markets: Map<string, Market>;
  private constraints: PolytopeConstraint[];
  private logger = getLogger().child({ module: 'MarginalPolytope' });

  constructor() {
    this.events = new Map();
    this.markets = new Map();
    this.constraints = [];
  }

  /**
   * Add an event with its associated markets
   */
  addEvent(event: Event): void {
    this.events.set(event.id, event);
    for (const market of event.markets) {
      this.markets.set(market.id, market);
    }
    this.rebuildConstraints();
    this.logger.debug(`Added event ${event.id} with ${event.markets.length} markets`);
  }

  /**
   * Update market price
   */
  updateMarketPrice(marketId: string, price: number): void {
    const market = this.markets.get(marketId);
    if (!market) {
      throw new Error(`Market ${marketId} not found`);
    }
    market.price = price;
    this.logger.debug(`Updated market ${marketId} price to ${price}`);
  }

  /**
   * Get all markets
   */
  getMarkets(): Market[] {
    return Array.from(this.markets.values());
  }

  /**
   * Get market by ID
   */
  getMarket(marketId: string): Market | undefined {
    return this.markets.get(marketId);
  }

  /**
   * Get number of dimensions (markets)
   */
  getDimension(): number {
    return this.markets.size;
  }

  /**
   * Get all constraints defining the polytope
   */
  getConstraints(): PolytopeConstraint[] {
    return [...this.constraints];
  }

  /**
   * Rebuild all constraints based on current events and markets
   *
   * Constraints include:
   * 1. For each event: sum of outcome probabilities = 1
   * 2. For each market: price consistency with event probabilities
   * 3. Non-negativity: all probabilities >= 0
   */
  private rebuildConstraints(): void {
    this.constraints = [];
    const marketList = this.getMarkets();
    const n = marketList.length;

    // Probability sum constraints for each event
    for (const event of this.events.values()) {
      const coefficients = new Array(n).fill(0);

      for (const market of event.markets) {
        const idx = marketList.findIndex(m => m.id === market.id);
        if (idx >= 0) {
          coefficients[idx] = 1;
        }
      }

      this.constraints.push({
        type: 'equality',
        coefficients,
        rhs: 1,
        description: `Event ${event.id}: probability sum = 1`,
      });
    }

    // Non-negativity constraints
    for (let i = 0; i < n; i++) {
      const coefficients = new Array(n).fill(0);
      coefficients[i] = 1;

      this.constraints.push({
        type: 'inequality',
        coefficients,
        rhs: 0,
        description: `Market ${marketList[i]!.id}: non-negative`,
      });
    }

    // Upper bound constraints (probabilities <= 1)
    for (let i = 0; i < n; i++) {
      const coefficients = new Array(n).fill(0);
      coefficients[i] = -1;

      this.constraints.push({
        type: 'inequality',
        coefficients,
        rhs: -1,
        description: `Market ${marketList[i]!.id}: upper bound`,
      });
    }

    this.logger.debug(`Rebuilt ${this.constraints.length} constraints for ${n} markets`);
  }

  /**
   * Check if a point is inside the polytope (feasible)
   */
  isFeasible(point: number[], tolerance: number = 1e-10): boolean {
    if (point.length !== this.getDimension()) {
      return false;
    }

    for (const constraint of this.constraints) {
      const value = constraint.coefficients.reduce((sum, c, i) => sum + c * point[i]!, 0);

      if (constraint.type === 'equality') {
        if (Math.abs(value - constraint.rhs) > tolerance) {
          return false;
        }
      } else {
        // inequality: coefficients · x >= rhs
        if (value < constraint.rhs - tolerance) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Project a point onto the polytope using Bregman projection
   * This is a simplified version; full implementation uses iterative methods
   */
  project(point: number[]): number[] {
    // Simple projection: normalize to satisfy sum constraints
    const result = [...point];
    const marketList = this.getMarkets();

    // Group by event and normalize
    for (const event of this.events.values()) {
      let sum = 0;
      const indices: number[] = [];

      for (const market of event.markets) {
        const idx = marketList.findIndex(m => m.id === market.id);
        if (idx >= 0) {
          sum += result[idx]!;
          indices.push(idx);
        }
      }

      if (sum > 0) {
        for (const idx of indices) {
          result[idx]! /= sum;
        }
      }
    }

    // Clip to [0, 1]
    return result.map(x => Math.max(0, Math.min(1, x)));
  }

  /**
   * Get the current price vector
   */
  getPriceVector(): number[] {
    return this.getMarkets().map(m => m.price);
  }

  /**
   * Compute the barycenter (center of mass) of the polytope
   * For a simplex, this is the uniform distribution
   */
  getBarycenter(): number[] {
    const n = this.getDimension();
    return new Array(n).fill(1 / n);
  }

  /**
   * Check for simple arbitrage opportunities
   * Returns true if YES + NO prices != 1 (within tolerance)
   */
  detectSimpleArbitrage(tolerance: number = 0.01): Array<{ eventId: string; deviation: number }> {
    const opportunities: Array<{ eventId: string; deviation: number }> = [];

    for (const event of this.events.values()) {
      if (event.markets.length === 2) {
        const yesMarket = event.markets.find(m => m.outcome === 'YES');
        const noMarket = event.markets.find(m => m.outcome === 'NO');

        if (yesMarket && noMarket) {
          const sum = yesMarket.price + noMarket.price;
          const deviation = Math.abs(sum - 1);

          if (deviation > tolerance) {
            opportunities.push({ eventId: event.id, deviation });
            this.logger.info(`Arbitrage detected for event ${event.id}: YES+NO=${sum.toFixed(4)}`);
          }
        }
      }
    }

    return opportunities;
  }

  /**
   * Clear all events and markets
   */
  clear(): void {
    this.events.clear();
    this.markets.clear();
    this.constraints = [];
    this.logger.debug('Cleared all events and markets');
  }
}
