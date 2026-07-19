/**
 * Constraint matrix builder for the marginal polytope.
 *
 * Constructs LP/IP constraints from market dependency graph data:
 * - Probability sum constraints per event
 * - Mutually exclusive event constraints
 * - Implication constraints
 * - Conditional probability constraints
 * - Non-negativity constraints
 *
 * Cross-event relational constraints (ME / implies / conditional) never sum
 * every market on a binary event (YES+NO). That would make ME infeasible and
 * implies/conditional vacuous (MKT-2). Market-level edges constrain those
 * markets directly; event-level edges use affirmative (Yes) representatives.
 */

import type { MarketNode, EventNode, DependencyEdge } from './dependency-graph.js';

export interface ConstraintMatrix {
  coefficients: number[][];
  rhs: number[];
  types: ('equality' | 'inequality')[];
  descriptions: string[];
}

/**
 * Build the constraint matrix from graph components.
 */
export function buildConstraintMatrix(
  markets: Map<string, MarketNode>,
  events: Map<string, EventNode>,
  edges: DependencyEdge[]
): ConstraintMatrix {
  const coefficients: number[][] = [];
  const rhs: number[] = [];
  const types: ('equality' | 'inequality')[] = [];
  const descriptions: string[] = [];

  const marketList = Array.from(markets.keys());
  const n = marketList.length;
  const marketIndex = new Map<string, number>();
  for (let i = 0; i < marketList.length; i++) {
    const marketId = marketList[i];
    if (marketId !== undefined) marketIndex.set(marketId, i);
  }

  // 1. Probability sum constraints for each event
  for (const event of events.values()) {
    const constraint: number[] = new Array(n).fill(0) as number[];
    let presentMarketCount = 0;

    for (const marketId of event.markets) {
      const idx = marketIndex.get(marketId) ?? -1;
      if (idx >= 0) {
        constraint[idx] = 1;
        presentMarketCount++;
      }
    }

    if (presentMarketCount < 2 && !(n === 0 && event.markets.length > 0)) {
      continue;
    }

    coefficients.push(constraint);
    rhs.push(1);
    types.push('equality');
    descriptions.push(`Event ${event.id}: probability sum = 1`);
  }

  // 2. Mutually exclusive event constraints: P(A) + P(B) <= 1
  for (const edge of edges) {
    if (edge.type !== 'mutually_exclusive') continue;

    const sides = resolveRelationalMarketIds(edge.from, edge.to, events, markets);
    if (!sides) continue;

    const constraint: number[] = new Array(n).fill(0) as number[];
    let hasTerm = false;
    for (const marketId of [...sides.fromMarketIds, ...sides.toMarketIds]) {
      const idx = marketIndex.get(marketId) ?? -1;
      if (idx >= 0) {
        constraint[idx] = -1;
        hasTerm = true;
      }
    }
    if (!hasTerm) continue;

    coefficients.push(constraint);
    rhs.push(-1);
    types.push('inequality');
    descriptions.push(`Mutually exclusive: ${sides.fromLabel} + ${sides.toLabel} <= 1`);
  }

  // 3. Implication constraints: from => to → P(to) - P(from) >= 0
  for (const edge of edges) {
    if (edge.type !== 'implies') continue;

    const sides = resolveRelationalMarketIds(edge.from, edge.to, events, markets);
    if (!sides) continue;

    const constraint: number[] = new Array(n).fill(0) as number[];
    let hasTerm = false;

    for (const marketId of sides.toMarketIds) {
      const idx = marketIndex.get(marketId) ?? -1;
      if (idx >= 0) {
        constraint[idx] = 1;
        hasTerm = true;
      }
    }
    for (const marketId of sides.fromMarketIds) {
      const idx = marketIndex.get(marketId) ?? -1;
      if (idx >= 0) {
        constraint[idx] = -1;
        hasTerm = true;
      }
    }

    if (!hasTerm) continue;

    coefficients.push(constraint);
    rhs.push(0);
    types.push('inequality');
    descriptions.push(`Implication: ${sides.fromLabel} <= ${sides.toLabel}`);
  }

  // 4. Conditional probability constraints: P(child) <= P(parent)
  for (const event of events.values()) {
    if (!event.parentEvent) continue;
    const parent = events.get(event.parentEvent);
    if (!parent) continue;

    const childMarkets = eventProbabilityMarketIds(event, markets);
    const parentMarkets = eventProbabilityMarketIds(parent, markets);
    if (childMarkets.length === 0 || parentMarkets.length === 0) continue;

    const constraint: number[] = new Array(n).fill(0) as number[];
    for (const marketId of childMarkets) {
      const idx = marketIndex.get(marketId) ?? -1;
      if (idx >= 0) constraint[idx] = -1;
    }
    for (const marketId of parentMarkets) {
      const idx = marketIndex.get(marketId) ?? -1;
      if (idx >= 0) constraint[idx] = 1;
    }

    coefficients.push(constraint);
    rhs.push(0);
    types.push('inequality');
    descriptions.push(`Conditional: ${event.id} <= ${parent.id}`);
  }

  // 5. Non-negativity constraints
  for (let i = 0; i < n; i++) {
    const constraint: number[] = new Array(n).fill(0) as number[];
    constraint[i] = 1;
    coefficients.push(constraint);
    rhs.push(0);
    types.push('inequality');
    const marketId = marketList[i];
    descriptions.push(`Market ${marketId ?? 'unknown'}: non-negative`);
  }

  return { coefficients, rhs, types, descriptions };
}

function resolveEdgeEventId(
  id: string,
  events: Map<string, EventNode>,
  markets: Map<string, MarketNode>
): string | undefined {
  if (events.has(id)) return id;
  return markets.get(id)?.eventId;
}

/**
 * Resolve market IDs for a cross-event relational edge.
 *
 * Market→market edges constrain those markets directly. Event-level (or mixed)
 * edges pick affirmative outcome representatives per event (MKT-2).
 */
function resolveRelationalMarketIds(
  fromId: string,
  toId: string,
  events: Map<string, EventNode>,
  markets: Map<string, MarketNode>
): {
  fromMarketIds: string[];
  toMarketIds: string[];
  fromLabel: string;
  toLabel: string;
} | null {
  if (markets.has(fromId) && markets.has(toId)) {
    const fromEventId = markets.get(fromId)?.eventId;
    const toEventId = markets.get(toId)?.eventId;
    if (!fromEventId || !toEventId || fromEventId === toEventId) return null;
    return {
      fromMarketIds: [fromId],
      toMarketIds: [toId],
      fromLabel: fromEventId,
      toLabel: toEventId,
    };
  }

  const fromEventId = resolveEdgeEventId(fromId, events, markets);
  const toEventId = resolveEdgeEventId(toId, events, markets);
  if (!fromEventId || !toEventId || fromEventId === toEventId) return null;

  const fromEvent = events.get(fromEventId);
  const toEvent = events.get(toEventId);
  if (!fromEvent || !toEvent) return null;

  const fromMarketIds = eventProbabilityMarketIds(fromEvent, markets);
  const toMarketIds = eventProbabilityMarketIds(toEvent, markets);
  if (fromMarketIds.length === 0 || toMarketIds.length === 0) return null;

  return {
    fromMarketIds,
    toMarketIds,
    fromLabel: fromEventId,
    toLabel: toEventId,
  };
}

/**
 * Markets that represent P(event) for relational constraints.
 *
 * Prefers affirmative outcomes (Yes/Y/true/1). Falls back to the first
 * non-negative (non-No) market, then the first present market. Never returns
 * both YES and NO of a binary event.
 */
function eventProbabilityMarketIds(event: EventNode, markets: Map<string, MarketNode>): string[] {
  const present = event.markets.filter((id) => markets.has(id));
  if (present.length === 0) return [];

  const affirmative = present.filter((id) => isAffirmativeOutcome(markets.get(id)?.outcome));
  if (affirmative.length > 0) return affirmative;

  const nonNegative = present.filter((id) => !isNegativeOutcome(markets.get(id)?.outcome));
  const representative = nonNegative[0] ?? present[0];
  return representative === undefined ? [] : [representative];
}

function isAffirmativeOutcome(outcome: string | undefined): boolean {
  return /^(yes|y|true|1)$/i.test((outcome ?? '').trim());
}

function isNegativeOutcome(outcome: string | undefined): boolean {
  return /^(no|n|false|0)$/i.test((outcome ?? '').trim());
}
