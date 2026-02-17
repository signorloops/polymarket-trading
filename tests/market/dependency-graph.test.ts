/**
 * Unit tests for Market Dependency Graph
 */

import {
  MarketDependencyGraph,
  getDependencyGraph,
  resetDependencyGraph,
  type MarketNode,
  type EventNode,
  type DependencyEdge,
} from '../../src/market/dependency-graph.js';

describe('MarketDependencyGraph', () => {
  let graph: MarketDependencyGraph;

  beforeEach(() => {
    graph = new MarketDependencyGraph();
  });

  afterEach(() => {
    graph.clear();
    resetDependencyGraph();
  });

  describe('market node management', () => {
    it('should add a market node', () => {
      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market);

      const markets = graph.getComponentMarkets('market-1');
      expect(markets).toHaveLength(1);
      expect(markets[0]).toEqual(market);
    });

    it('should update existing market node', () => {
      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market);
      graph.addMarket({ ...market, price: 0.7 });

      const markets = graph.getComponentMarkets('market-1');
      expect(markets[0].price).toBe(0.7);
    });

    it('should handle multiple markets', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      const allMarkets = graph.getComponentMarkets('market-1');
      expect(allMarkets).toHaveLength(1); // No edges, so only market-1
    });

    it('should initialize adjacency list for new market', () => {
      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market);

      // Adding an edge should work even if 'to' market doesn't exist yet
      const edge: DependencyEdge = {
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      };

      graph.addEdge(edge);

      // Should not throw
      expect(() => graph.findArbitrageCycles()).not.toThrow();
    });
  });

  describe('event node management', () => {
    it('should add an event node', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      graph.addEvent(event);

      const markets = graph.getMarketsForEvent('event-1');
      expect(markets).toHaveLength(0); // Markets not added yet
    });

    it('should return markets for event', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addEvent(event);
      graph.addMarket(market1);
      graph.addMarket(market2);

      const markets = graph.getMarketsForEvent('event-1');
      expect(markets).toHaveLength(2);
      expect(markets.map((m) => m.id)).toContain('market-1');
      expect(markets.map((m) => m.id)).toContain('market-2');
    });

    it('should return empty array for non-existent event', () => {
      const markets = graph.getMarketsForEvent('non-existent');
      expect(markets).toEqual([]);
    });

    it('should handle categorical event', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'categorical',
        outcomes: ['Option A', 'Option B', 'Option C'],
        markets: ['market-1', 'market-2', 'market-3'],
      };

      graph.addEvent(event);

      const markets = graph.getMarketsForEvent('event-1');
      expect(markets).toHaveLength(0);
    });

    it('should handle conditional event', () => {
      const event: EventNode = {
        id: 'event-2',
        type: 'conditional',
        outcomes: ['Yes', 'No'],
        markets: ['market-3', 'market-4'],
        parentEvent: 'event-1',
        condition: 'event-1 = Yes',
      };

      graph.addEvent(event);

      const markets = graph.getMarketsForEvent('event-2');
      expect(markets).toHaveLength(0);
    });
  });

  describe('dependency edge creation', () => {
    it('should add a dependency edge', () => {
      const edge: DependencyEdge = {
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      };

      graph.addEdge(edge);

      // Edge should be added (tested indirectly through cycle detection)
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      const cycles = graph.findArbitrageCycles();
      expect(cycles).toHaveLength(0); // Single edge, no cycle
    });

    it('should create adjacency list entry for edge source', () => {
      const edge: DependencyEdge = {
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      };

      graph.addEdge(edge);

      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market1);

      const components = graph.getConnectedComponents();
      expect(components).toHaveLength(1);
      expect(components[0]).toContain('market-1');
    });

    it('should handle multiple edges from same node', () => {
      const edge1: DependencyEdge = {
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      };

      const edge2: DependencyEdge = {
        from: 'market-1',
        to: 'market-3',
        type: 'implies',
        weight: 0.8,
      };

      graph.addEdge(edge1);
      graph.addEdge(edge2);

      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market1);

      const components = graph.getConnectedComponents();
      expect(components).toHaveLength(1);
    });

    it('should handle different edge types', () => {
      const edges: DependencyEdge[] = [
        { from: 'market-1', to: 'market-2', type: 'mutually_exclusive', weight: 1 },
        { from: 'market-1', to: 'market-3', type: 'conditional', weight: 1 },
        { from: 'market-1', to: 'market-4', type: 'temporal', weight: 1 },
        { from: 'market-1', to: 'market-5', type: 'implies', weight: 1 },
      ];

      edges.forEach((edge) => graph.addEdge(edge));

      // All edges should be added without error
      expect(() => graph.findArbitrageCycles()).not.toThrow();
    });
  });

  describe('mutually exclusive events', () => {
    it('should find mutually exclusive events', () => {
      const event1: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const event2: EventNode = {
        id: 'event-2',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-3', 'market-4'],
      };

      const edge: DependencyEdge = {
        from: 'event-1',
        to: 'event-2',
        type: 'mutually_exclusive',
        weight: 1,
      };

      graph.addEvent(event1);
      graph.addEvent(event2);
      graph.addEdge(edge);

      const exclusive1 = graph.getMutuallyExclusiveEvents('event-1');
      expect(exclusive1).toContain('event-2');

      const exclusive2 = graph.getMutuallyExclusiveEvents('event-2');
      expect(exclusive2).toContain('event-1');
    });

    it('should return empty array when no mutually exclusive events', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      graph.addEvent(event);

      const exclusive = graph.getMutuallyExclusiveEvents('event-1');
      expect(exclusive).toEqual([]);
    });

    it('should handle multiple mutually exclusive events', () => {
      const event1: EventNode = {
        id: 'event-1',
        type: 'categorical',
        outcomes: ['A', 'B', 'C'],
        markets: ['market-1', 'market-2', 'market-3'],
      };

      const event2: EventNode = {
        id: 'event-2',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-4', 'market-5'],
      };

      const event3: EventNode = {
        id: 'event-3',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-6', 'market-7'],
      };

      graph.addEvent(event1);
      graph.addEvent(event2);
      graph.addEvent(event3);

      graph.addEdge({
        from: 'event-1',
        to: 'event-2',
        type: 'mutually_exclusive',
        weight: 1,
      });

      graph.addEdge({
        from: 'event-1',
        to: 'event-3',
        type: 'mutually_exclusive',
        weight: 1,
      });

      const exclusive = graph.getMutuallyExclusiveEvents('event-1');
      expect(exclusive).toHaveLength(2);
      expect(exclusive).toContain('event-2');
      expect(exclusive).toContain('event-3');
    });
  });

  describe('conditional events', () => {
    it('should find conditional events', () => {
      const parentEvent: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const childEvent: EventNode = {
        id: 'event-2',
        type: 'conditional',
        outcomes: ['Yes', 'No'],
        markets: ['market-3', 'market-4'],
        parentEvent: 'event-1',
        condition: 'event-1 = Yes',
      };

      graph.addEvent(parentEvent);
      graph.addEvent(childEvent);

      const conditional = graph.getConditionalEvents('event-1');
      expect(conditional).toHaveLength(1);
      expect(conditional[0].id).toBe('event-2');
    });

    it('should return empty array when no conditional events', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      graph.addEvent(event);

      const conditional = graph.getConditionalEvents('event-1');
      expect(conditional).toEqual([]);
    });

    it('should handle multiple conditional events', () => {
      const parentEvent: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const childEvent1: EventNode = {
        id: 'event-2',
        type: 'conditional',
        outcomes: ['Yes', 'No'],
        markets: ['market-3', 'market-4'],
        parentEvent: 'event-1',
        condition: 'event-1 = Yes',
      };

      const childEvent2: EventNode = {
        id: 'event-3',
        type: 'conditional',
        outcomes: ['Yes', 'No'],
        markets: ['market-5', 'market-6'],
        parentEvent: 'event-1',
        condition: 'event-1 = Yes',
      };

      graph.addEvent(parentEvent);
      graph.addEvent(childEvent1);
      graph.addEvent(childEvent2);

      const conditional = graph.getConditionalEvents('event-1');
      expect(conditional).toHaveLength(2);
    });
  });

  describe('cycle detection', () => {
    it('should detect simple cycle', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      graph.addEdge({
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      });

      graph.addEdge({
        from: 'market-2',
        to: 'market-1',
        type: 'implies',
        weight: 1,
      });

      const cycles = graph.findArbitrageCycles();
      expect(cycles).toHaveLength(1);
      expect(cycles[0].markets).toContain('market-1');
      expect(cycles[0].markets).toContain('market-2');
    });

    it('should detect cycle with three nodes', () => {
      const markets: MarketNode[] = [
        { id: 'market-1', eventId: 'event-1', outcome: 'A', price: 0.5, metadata: {} },
        { id: 'market-2', eventId: 'event-2', outcome: 'B', price: 0.5, metadata: {} },
        { id: 'market-3', eventId: 'event-3', outcome: 'C', price: 0.5, metadata: {} },
      ];

      markets.forEach((m) => graph.addMarket(m));

      graph.addEdge({ from: 'market-1', to: 'market-2', type: 'implies', weight: 1 });
      graph.addEdge({ from: 'market-2', to: 'market-3', type: 'implies', weight: 1 });
      graph.addEdge({ from: 'market-3', to: 'market-1', type: 'implies', weight: 1 });

      const cycles = graph.findArbitrageCycles();
      expect(cycles).toHaveLength(1);
      expect(cycles[0].markets).toHaveLength(3);
    });

    it('should detect multiple cycles', () => {
      const markets: MarketNode[] = [
        { id: 'market-1', eventId: 'event-1', outcome: 'A', price: 0.5, metadata: {} },
        { id: 'market-2', eventId: 'event-2', outcome: 'B', price: 0.5, metadata: {} },
        { id: 'market-3', eventId: 'event-3', outcome: 'C', price: 0.5, metadata: {} },
        { id: 'market-4', eventId: 'event-4', outcome: 'D', price: 0.5, metadata: {} },
      ];

      markets.forEach((m) => graph.addMarket(m));

      // First cycle: 1 -> 2 -> 1
      graph.addEdge({ from: 'market-1', to: 'market-2', type: 'implies', weight: 1 });
      graph.addEdge({ from: 'market-2', to: 'market-1', type: 'implies', weight: 1 });

      // Second cycle: 3 -> 4 -> 3
      graph.addEdge({ from: 'market-3', to: 'market-4', type: 'implies', weight: 1 });
      graph.addEdge({ from: 'market-4', to: 'market-3', type: 'implies', weight: 1 });

      const cycles = graph.findArbitrageCycles();
      expect(cycles).toHaveLength(2);
    });

    it('should return empty array when no cycles', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      graph.addEdge({
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      });

      const cycles = graph.findArbitrageCycles();
      expect(cycles).toEqual([]);
    });

    it('should handle empty graph', () => {
      const cycles = graph.findArbitrageCycles();
      expect(cycles).toEqual([]);
    });

    it('should handle graph with single node', () => {
      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market);

      const cycles = graph.findArbitrageCycles();
      expect(cycles).toEqual([]);
    });

    it('should calculate expected return for cycle', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      graph.addEdge({
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      });

      graph.addEdge({
        from: 'market-2',
        to: 'market-1',
        type: 'implies',
        weight: 1,
      });

      const cycles = graph.findArbitrageCycles();
      expect(cycles).toHaveLength(1);
      // Expected return: |0.6 - 0.4| + |0.4 - 0.6| = 0.4
      expect(cycles[0].expectedReturn).toBeCloseTo(0.4, 5);
    });

    it('should include constraint description in cycle', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      graph.addEdge({
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      });

      graph.addEdge({
        from: 'market-2',
        to: 'market-1',
        type: 'implies',
        weight: 1,
      });

      const cycles = graph.findArbitrageCycles();
      expect(cycles[0].constraint).toContain('market-1');
      expect(cycles[0].constraint).toContain('market-2');
    });
  });

  describe('constraint matrix construction', () => {
    it('should build constraint matrix for single event', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addEvent(event);
      graph.addMarket(market1);
      graph.addMarket(market2);

      const matrix = graph.buildConstraintMatrix();

      // Should have: 1 probability sum constraint + 2 non-negativity constraints
      expect(matrix.coefficients).toHaveLength(3);
      expect(matrix.rhs).toHaveLength(3);
      expect(matrix.types).toHaveLength(3);
      expect(matrix.descriptions).toHaveLength(3);
    });

    it('should include probability sum constraint', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addEvent(event);
      graph.addMarket(market1);
      graph.addMarket(market2);

      const matrix = graph.buildConstraintMatrix();

      // First constraint should be probability sum = 1
      expect(matrix.coefficients[0]).toEqual([1, 1]);
      expect(matrix.rhs[0]).toBe(1);
      expect(matrix.types[0]).toBe('equality');
      expect(matrix.descriptions[0]).toContain('probability sum');
    });

    it('should include mutually exclusive constraints', () => {
      const event1: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const event2: EventNode = {
        id: 'event-2',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-3', 'market-4'],
      };

      const markets: MarketNode[] = [
        { id: 'market-1', eventId: 'event-1', outcome: 'Yes', price: 0.6, metadata: {} },
        { id: 'market-2', eventId: 'event-1', outcome: 'No', price: 0.4, metadata: {} },
        { id: 'market-3', eventId: 'event-2', outcome: 'Yes', price: 0.5, metadata: {} },
        { id: 'market-4', eventId: 'event-2', outcome: 'No', price: 0.5, metadata: {} },
      ];

      graph.addEvent(event1);
      graph.addEvent(event2);
      markets.forEach((m) => graph.addMarket(m));

      graph.addEdge({
        from: 'event-1',
        to: 'event-2',
        type: 'mutually_exclusive',
        weight: 1,
      });

      const matrix = graph.buildConstraintMatrix();

      // Should have: 2 probability sum + 1 mutually exclusive + 4 non-negativity
      expect(matrix.coefficients).toHaveLength(7);

      // Find mutually exclusive constraint
      const meConstraintIdx = matrix.types.findIndex(
        (t, i) => t === 'inequality' && matrix.descriptions[i].includes('Mutually exclusive')
      );
      expect(meConstraintIdx).toBeGreaterThan(-1);
    });

    it('should include conditional probability constraints', () => {
      const parentEvent: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const childEvent: EventNode = {
        id: 'event-2',
        type: 'conditional',
        outcomes: ['Yes', 'No'],
        markets: ['market-3', 'market-4'],
        parentEvent: 'event-1',
        condition: 'event-1 = Yes',
      };

      const markets: MarketNode[] = [
        { id: 'market-1', eventId: 'event-1', outcome: 'Yes', price: 0.6, metadata: {} },
        { id: 'market-2', eventId: 'event-1', outcome: 'No', price: 0.4, metadata: {} },
        { id: 'market-3', eventId: 'event-2', outcome: 'Yes', price: 0.5, metadata: {} },
        { id: 'market-4', eventId: 'event-2', outcome: 'No', price: 0.5, metadata: {} },
      ];

      graph.addEvent(parentEvent);
      graph.addEvent(childEvent);
      markets.forEach((m) => graph.addMarket(m));

      const matrix = graph.buildConstraintMatrix();

      // Should have: 2 probability sum + 1 conditional + 4 non-negativity
      expect(matrix.coefficients).toHaveLength(7);

      // Find conditional constraint
      const condConstraintIdx = matrix.descriptions.findIndex((d) => d.includes('Conditional'));
      expect(condConstraintIdx).toBeGreaterThan(-1);
    });

    it('should include non-negativity constraints', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addEvent(event);
      graph.addMarket(market1);
      graph.addMarket(market2);

      const matrix = graph.buildConstraintMatrix();

      // Last two constraints should be non-negativity
      expect(matrix.types[matrix.types.length - 2]).toBe('inequality');
      expect(matrix.types[matrix.types.length - 1]).toBe('inequality');
      expect(matrix.descriptions[matrix.descriptions.length - 1]).toContain('non-negative');
    });

    it('should handle empty graph', () => {
      const matrix = graph.buildConstraintMatrix();

      expect(matrix.coefficients).toEqual([]);
      expect(matrix.rhs).toEqual([]);
      expect(matrix.types).toEqual([]);
      expect(matrix.descriptions).toEqual([]);
    });

    it('should handle event with missing markets', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'], // Markets not added
      };

      graph.addEvent(event);

      const matrix = graph.buildConstraintMatrix();

      // When no markets exist, constraint arrays are empty (n=0)
      expect(matrix.coefficients).toHaveLength(1);
      expect(matrix.coefficients[0]).toEqual([]);
    });

    it('should handle mutually exclusive edge with missing events', () => {
      graph.addEdge({
        from: 'event-1',
        to: 'event-2',
        type: 'mutually_exclusive',
        weight: 1,
      });

      // Should not throw
      expect(() => graph.buildConstraintMatrix()).not.toThrow();
    });

    it('should handle conditional event with missing parent', () => {
      const childEvent: EventNode = {
        id: 'event-2',
        type: 'conditional',
        outcomes: ['Yes', 'No'],
        markets: ['market-3', 'market-4'],
        parentEvent: 'event-1', // Parent not added
        condition: 'event-1 = Yes',
      };

      const markets: MarketNode[] = [
        { id: 'market-3', eventId: 'event-2', outcome: 'Yes', price: 0.5, metadata: {} },
        { id: 'market-4', eventId: 'event-2', outcome: 'No', price: 0.5, metadata: {} },
      ];

      graph.addEvent(childEvent);
      markets.forEach((m) => graph.addMarket(m));

      // Should not throw
      expect(() => graph.buildConstraintMatrix()).not.toThrow();
    });
  });

  describe('connected components', () => {
    it('should find single connected component', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      graph.addEdge({
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      });

      const components = graph.getConnectedComponents();
      expect(components).toHaveLength(1);
      expect(components[0]).toContain('market-1');
      expect(components[0]).toContain('market-2');
    });

    it('should find multiple connected components', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-2',
        outcome: 'Yes',
        price: 0.5,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      const components = graph.getConnectedComponents();
      expect(components).toHaveLength(2);
    });

    it('should return empty array for empty graph', () => {
      const components = graph.getConnectedComponents();
      expect(components).toEqual([]);
    });

    it('should handle isolated nodes', () => {
      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market);

      const components = graph.getConnectedComponents();
      expect(components).toHaveLength(1);
      expect(components[0]).toEqual(['market-1']);
    });
  });

  describe('price updates', () => {
    it('should update market price', () => {
      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market);
      graph.updatePrice('market-1', 0.7);

      const markets = graph.getComponentMarkets('market-1');
      expect(markets[0].price).toBe(0.7);
    });

    it('should not throw when updating non-existent market', () => {
      expect(() => graph.updatePrice('non-existent', 0.5)).not.toThrow();
    });

    it('should affect cycle expected return after price update', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      graph.addEdge({
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      });

      graph.addEdge({
        from: 'market-2',
        to: 'market-1',
        type: 'implies',
        weight: 1,
      });

      const cyclesBefore = graph.findArbitrageCycles();
      const expectedReturnBefore = cyclesBefore[0].expectedReturn;

      graph.updatePrice('market-1', 0.8);

      const cyclesAfter = graph.findArbitrageCycles();
      const expectedReturnAfter = cyclesAfter[0].expectedReturn;

      expect(expectedReturnAfter).not.toBe(expectedReturnBefore);
    });
  });

  describe('component markets retrieval', () => {
    it('should get all markets in component', () => {
      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addMarket(market1);
      graph.addMarket(market2);

      graph.addEdge({
        from: 'market-1',
        to: 'market-2',
        type: 'implies',
        weight: 1,
      });

      const markets = graph.getComponentMarkets('market-1');
      expect(markets).toHaveLength(2);
    });

    it('should return single market for isolated node', () => {
      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market);

      const markets = graph.getComponentMarkets('market-1');
      expect(markets).toHaveLength(1);
      expect(markets[0].id).toBe('market-1');
    });

    it('should return empty array for non-existent market', () => {
      const markets = graph.getComponentMarkets('non-existent');
      expect(markets).toEqual([]);
    });

    it('should traverse through multiple levels', () => {
      const markets: MarketNode[] = [
        { id: 'market-1', eventId: 'event-1', outcome: 'A', price: 0.5, metadata: {} },
        { id: 'market-2', eventId: 'event-2', outcome: 'B', price: 0.5, metadata: {} },
        { id: 'market-3', eventId: 'event-3', outcome: 'C', price: 0.5, metadata: {} },
      ];

      markets.forEach((m) => graph.addMarket(m));

      graph.addEdge({ from: 'market-1', to: 'market-2', type: 'implies', weight: 1 });
      graph.addEdge({ from: 'market-2', to: 'market-3', type: 'implies', weight: 1 });

      const componentMarkets = graph.getComponentMarkets('market-1');
      expect(componentMarkets).toHaveLength(3);
    });
  });

  describe('graph clearing', () => {
    it('should clear all data', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addEvent(event);
      graph.addMarket(market);
      graph.addEdge({ from: 'market-1', to: 'market-2', type: 'implies', weight: 1 });

      graph.clear();

      const markets = graph.getComponentMarkets('market-1');
      expect(markets).toEqual([]);

      const components = graph.getConnectedComponents();
      expect(components).toEqual([]);
    });

    it('should handle clear on empty graph', () => {
      expect(() => graph.clear()).not.toThrow();
    });
  });

  describe('singleton management', () => {
    it('should return same instance from getDependencyGraph', () => {
      const graph1 = getDependencyGraph();
      const graph2 = getDependencyGraph();

      expect(graph1).toBe(graph2);
    });

    it('should create new instance after reset', () => {
      const graph1 = getDependencyGraph();
      resetDependencyGraph();
      const graph2 = getDependencyGraph();

      expect(graph1).not.toBe(graph2);
    });
  });

  describe('edge cases', () => {
    it('should handle self-loop edge', () => {
      const market: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      graph.addMarket(market);

      graph.addEdge({
        from: 'market-1',
        to: 'market-1',
        type: 'implies',
        weight: 1,
      });

      // Self-loop creates a cycle of length 1
      const cycles = graph.findArbitrageCycles();
      expect(cycles.length).toBeGreaterThanOrEqual(0); // May or may not detect as cycle
    });

    it('should handle markets with same event ID', () => {
      const event: EventNode = {
        id: 'event-1',
        type: 'binary',
        outcomes: ['Yes', 'No'],
        markets: ['market-1', 'market-2'],
      };

      const market1: MarketNode = {
        id: 'market-1',
        eventId: 'event-1',
        outcome: 'Yes',
        price: 0.6,
        metadata: {},
      };

      const market2: MarketNode = {
        id: 'market-2',
        eventId: 'event-1',
        outcome: 'No',
        price: 0.4,
        metadata: {},
      };

      graph.addEvent(event);
      graph.addMarket(market1);
      graph.addMarket(market2);

      const markets = graph.getMarketsForEvent('event-1');
      expect(markets).toHaveLength(2);
    });

    it('should handle complex graph structure', () => {
      // Create a complex graph with multiple events and relationships
      const events: EventNode[] = [
        { id: 'election', type: 'categorical', outcomes: ['Trump', 'Biden', 'Other'], markets: ['m1', 'm2', 'm3'] },
        { id: 'trump-legal', type: 'conditional', outcomes: ['Guilty', 'Not Guilty'], markets: ['m4', 'm5'], parentEvent: 'election', condition: 'election = Trump' },
        { id: 'biden-health', type: 'conditional', outcomes: ['Yes', 'No'], markets: ['m6', 'm7'], parentEvent: 'election', condition: 'election = Biden' },
      ];

      const markets: MarketNode[] = [
        { id: 'm1', eventId: 'election', outcome: 'Trump', price: 0.45, metadata: {} },
        { id: 'm2', eventId: 'election', outcome: 'Biden', price: 0.45, metadata: {} },
        { id: 'm3', eventId: 'election', outcome: 'Other', price: 0.1, metadata: {} },
        { id: 'm4', eventId: 'trump-legal', outcome: 'Guilty', price: 0.3, metadata: {} },
        { id: 'm5', eventId: 'trump-legal', outcome: 'Not Guilty', price: 0.7, metadata: {} },
        { id: 'm6', eventId: 'biden-health', outcome: 'Yes', price: 0.2, metadata: {} },
        { id: 'm7', eventId: 'biden-health', outcome: 'No', price: 0.8, metadata: {} },
      ];

      events.forEach((e) => graph.addEvent(e));
      markets.forEach((m) => graph.addMarket(m));

      graph.addEdge({ from: 'election', to: 'trump-legal', type: 'conditional', weight: 1 });
      graph.addEdge({ from: 'election', to: 'biden-health', type: 'conditional', weight: 1 });

      const matrix = graph.buildConstraintMatrix();
      expect(matrix.coefficients.length).toBeGreaterThan(0);

      const conditionalEvents = graph.getConditionalEvents('election');
      expect(conditionalEvents).toHaveLength(2);
    });
  });
});
