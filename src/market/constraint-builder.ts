/**
 * Constraint matrix builder for the marginal polytope.
 *
 * Constructs LP/IP constraints from market dependency graph data:
 * - Probability sum constraints per event
 * - Mutually exclusive event constraints
 * - Implication constraints
 * - Conditional probability constraints
 * - Non-negativity constraints
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

  // 2. Mutually exclusive event constraints
  for (const edge of edges) {
    if (edge.type === 'mutually_exclusive') {
      const fromEventId = resolveEdgeEventId(edge.from, events, markets);
      const toEventId = resolveEdgeEventId(edge.to, events, markets);
      if (!fromEventId || !toEventId || fromEventId === toEventId) continue;

      const event1 = events.get(fromEventId);
      const event2 = events.get(toEventId);

      if (event1 && event2) {
        const constraint: number[] = new Array(n).fill(0) as number[];
        for (const marketId of event1.markets) {
          const idx = marketIndex.get(marketId) ?? -1;
          if (idx >= 0) constraint[idx] = -1;
        }
        for (const marketId of event2.markets) {
          const idx = marketIndex.get(marketId) ?? -1;
          if (idx >= 0) constraint[idx] = -1;
        }

        coefficients.push(constraint);
        rhs.push(-1);
        types.push('inequality');
        descriptions.push(`Mutually exclusive: ${fromEventId} + ${toEventId} <= 1`);
      }
    }
  }

  // 3. Implication constraints: from => to → P(to) - P(from) >= 0
  for (const edge of edges) {
    if (edge.type !== 'implies') continue;

    const fromEventId = resolveEdgeEventId(edge.from, events, markets);
    const toEventId = resolveEdgeEventId(edge.to, events, markets);
    if (!fromEventId || !toEventId || fromEventId === toEventId) continue;

    const fromEvent = events.get(fromEventId);
    const toEvent = events.get(toEventId);
    if (!fromEvent || !toEvent) continue;

    const constraint: number[] = new Array(n).fill(0) as number[];
    let hasTerm = false;

    for (const marketId of toEvent.markets) {
      const idx = marketIndex.get(marketId) ?? -1;
      if (idx >= 0) { constraint[idx] = 1; hasTerm = true; }
    }
    for (const marketId of fromEvent.markets) {
      const idx = marketIndex.get(marketId) ?? -1;
      if (idx >= 0) { constraint[idx] = -1; hasTerm = true; }
    }

    if (!hasTerm) continue;

    coefficients.push(constraint);
    rhs.push(0);
    types.push('inequality');
    descriptions.push(`Implication: ${fromEventId} <= ${toEventId}`);
  }

  // 4. Conditional probability constraints: P(child) <= P(parent)
  for (const event of events.values()) {
    if (event.parentEvent) {
      const parent = events.get(event.parentEvent);
      if (parent) {
        const constraint: number[] = new Array(n).fill(0) as number[];
        for (const marketId of event.markets) {
          const idx = marketIndex.get(marketId) ?? -1;
          if (idx >= 0) constraint[idx] = -1;
        }
        for (const marketId of parent.markets) {
          const idx = marketIndex.get(marketId) ?? -1;
          if (idx >= 0) constraint[idx] = 1;
        }

        coefficients.push(constraint);
        rhs.push(0);
        types.push('inequality');
        descriptions.push(`Conditional: ${event.id} <= ${parent.id}`);
      }
    }
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
