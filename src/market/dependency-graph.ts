/**
 * Market Dependency Graph
 *
 * Models relationships between prediction markets based on:
 * 1. Event relationships (mutually exclusive, conditional)
 * 2. Temporal dependencies (before/after)
 * 3. Combinatorial constraints (election scenarios, tournament brackets)
 *
 * This graph is used to construct the marginal polytope constraints
 * for cross-market arbitrage detection.
 */

import { getLogger } from '../utils/logger.js';
import { createSingleton } from '../utils/singleton.js';
import {
  buildConstraintMatrix as buildConstraintMatrixImpl,
  type ConstraintMatrix,
} from './constraint-builder.js';

export interface MarketNode {
  id: string;
  eventId: string;
  outcome: string;
  price: number;
  metadata: Record<string, unknown>;
}

export interface EventNode {
  id: string;
  type: 'binary' | 'categorical' | 'conditional';
  outcomes: string[];
  markets: string[];
  parentEvent?: string;
  condition?: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'mutually_exclusive' | 'conditional' | 'temporal' | 'implies';
  weight: number;
}

export interface ArbitrageCycle {
  markets: string[];
  expectedReturn: number;
  constraint: string;
}

/**
 * MarketDependencyGraph manages the relationships between markets
 */
export class MarketDependencyGraph {
  private markets: Map<string, MarketNode> = new Map();
  private events: Map<string, EventNode> = new Map();
  private edges: DependencyEdge[] = [];
  private adjacencyList: Map<string, Set<string>> = new Map();
  private logger = getLogger().child({ module: 'MarketDependencyGraph' });

  /**
   * Add a market node
   */
  addMarket(market: MarketNode): void {
    this.markets.set(market.id, market);

    // Auto-materialize event nodes so callers that only add markets still
    // get valid event-level constraints in buildConstraintMatrix().
    const existingEvent = this.events.get(market.eventId);
    if (existingEvent) {
      if (!existingEvent.markets.includes(market.id)) {
        existingEvent.markets.push(market.id);
      }
      if (!existingEvent.outcomes.includes(market.outcome)) {
        existingEvent.outcomes.push(market.outcome);
      }
      if (existingEvent.type === 'binary' && existingEvent.outcomes.length > 2) {
        existingEvent.type = 'categorical';
      }
    } else {
      this.events.set(market.eventId, {
        id: market.eventId,
        type: 'binary',
        outcomes: [market.outcome],
        markets: [market.id],
      });
    }

    if (!this.adjacencyList.has(market.id)) {
      this.adjacencyList.set(market.id, new Set());
    }

    this.logger.debug(`Added market ${market.id}`);
  }

  /**
   * Add an event node
   */
  addEvent(event: EventNode): void {
    this.events.set(event.id, event);
    this.logger.debug(`Added event ${event.id} with ${String(event.outcomes.length)} outcomes`);
  }

  /**
   * Add a dependency edge
   */
  addEdge(edge: DependencyEdge): void {
    this.edges.push(edge);

    // Update adjacency list
    if (!this.adjacencyList.has(edge.from)) {
      this.adjacencyList.set(edge.from, new Set());
    }
    const adjSet = this.adjacencyList.get(edge.from);
    if (adjSet) {
      adjSet.add(edge.to);
    }

    this.logger.debug(`Added ${edge.type} edge: ${edge.from} -> ${edge.to}`);
  }

  /**
   * Get markets for an event
   */
  getMarketsForEvent(eventId: string): MarketNode[] {
    const event = this.events.get(eventId);
    if (!event) return [];

    return event.markets
      .map((id) => this.markets.get(id))
      .filter((m): m is MarketNode => m !== undefined);
  }

  /**
   * Get events that are mutually exclusive
   */
  getMutuallyExclusiveEvents(eventId: string): string[] {
    const result: string[] = [];

    for (const edge of this.edges) {
      if (edge.type === 'mutually_exclusive') {
        if (edge.from === eventId) {
          result.push(edge.to);
        } else if (edge.to === eventId) {
          result.push(edge.from);
        }
      }
    }

    return result;
  }

  /**
   * Get conditional events (events that depend on another)
   */
  getConditionalEvents(parentEventId: string): EventNode[] {
    const result: EventNode[] = [];

    for (const event of this.events.values()) {
      if (event.parentEvent === parentEventId) {
        result.push(event);
      }
    }

    return result;
  }

  /**
   * Find cycles in the dependency graph (diagnostic / non-production).
   *
   * `expectedReturn` is a price-diff heuristic with no financial meaning (MKT-6);
   * DFS with a global visited set also misses some cycles. Prefer payoff-model USD
   * detection for trading decisions.
   */
  findArbitrageCycles(): ArbitrageCycle[] {
    const cycles: ArbitrageCycle[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (nodeId: string, path: string[]): void => {
      visited.add(nodeId);
      recursionStack.add(nodeId);

      const neighbors = this.adjacencyList.get(nodeId) ?? new Set();

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, [...path, neighbor]);
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          const cycle = path.slice(cycleStart);
          cycles.push(this.analyzeCycle(cycle));
        }
      }

      recursionStack.delete(nodeId);
    };

    for (const marketId of this.markets.keys()) {
      if (!visited.has(marketId)) {
        dfs(marketId, [marketId]);
      }
    }

    return cycles;
  }

  /**
   * Build constraint matrix for the marginal polytope
   */
  buildConstraintMatrix(): ConstraintMatrix {
    return buildConstraintMatrixImpl(this.markets, this.events, this.edges);
  }

  /**
   * Get connected components (groups of related markets)
   */
  getConnectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    const dfs = (startId: string, component: string[]): void => {
      visited.add(startId);
      component.push(startId);

      const neighbors = this.adjacencyList.get(startId) ?? new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, component);
        }
      }
    };

    for (const marketId of this.markets.keys()) {
      if (!visited.has(marketId)) {
        const component: string[] = [];
        dfs(marketId, component);
        components.push(component);
      }
    }

    return components;
  }

  /**
   * Update market price
   */
  updatePrice(marketId: string, price: number): void {
    const market = this.markets.get(marketId);
    if (market) {
      market.price = price;
    }
  }

  /**
   * Get all markets in a component
   */
  getComponentMarkets(marketId: string): MarketNode[] {
    const visited = new Set<string>();
    const result: MarketNode[] = [];

    const dfs = (id: string): void => {
      visited.add(id);
      const market = this.markets.get(id);
      if (market) {
        result.push(market);
      }

      const neighbors = this.adjacencyList.get(id) ?? new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        }
      }
    };

    dfs(marketId);
    return result;
  }

  /**
   * Clear the graph
   */
  clear(): void {
    this.markets.clear();
    this.events.clear();
    this.edges = [];
    this.adjacencyList.clear();
    this.logger.debug('Cleared dependency graph');
  }

  private analyzeCycle(marketIds: string[]): ArbitrageCycle {
    const markets = marketIds
      .map((id) => this.markets.get(id))
      .filter((m): m is MarketNode => m !== undefined);

    // Calculate expected return based on price inconsistencies
    let expectedReturn = 0;
    for (let i = 0; i < markets.length; i++) {
      const current = markets[i];
      const next = markets[(i + 1) % markets.length];
      if (!current || !next) continue;
      expectedReturn += Math.abs(current.price - next.price);
    }

    return {
      markets: marketIds,
      expectedReturn,
      constraint: `Cycle: ${marketIds.join(' -> ')}`,
    };
  }
}

/**
 * Global dependency graph instance
 */
const dependencyGraphSingleton = createSingleton(() => new MarketDependencyGraph());

export const getDependencyGraph = dependencyGraphSingleton.get;
export const resetDependencyGraph = dependencyGraphSingleton.reset;
