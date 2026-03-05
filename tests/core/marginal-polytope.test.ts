/**
 * Unit tests for marginal polytope
 */

import { MarginalPolytope, Event, Market } from '../../src/core/marginal-polytope.js';

describe('MarginalPolytope', () => {
  let polytope: MarginalPolytope;

  beforeEach(() => {
    polytope = new MarginalPolytope();
  });

  describe('addEvent', () => {
    it('should add an event with markets', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);

      expect(polytope.getMarkets()).toHaveLength(2);
      expect(polytope.getDimension()).toBe(2);
    });

    it('should add multiple events', () => {
      const event1: Event = {
        id: 'event-1',
        markets: [
          { id: 'm1-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'm1-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      const event2: Event = {
        id: 'event-2',
        markets: [
          { id: 'm2-yes', eventId: 'event-2', outcome: 'YES', price: 0.7 },
          { id: 'm2-no', eventId: 'event-2', outcome: 'NO', price: 0.3 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event1);
      polytope.addEvent(event2);

      expect(polytope.getMarkets()).toHaveLength(4);
      expect(polytope.getDimension()).toBe(4);
    });
  });

  describe('updatePrice', () => {
    it('should update market price', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);
      polytope.updateMarketPrice('market-yes', 0.7);

      const market = polytope.getMarket('market-yes');
      expect(market?.price).toBe(0.7);
    });

    it('should throw for non-existent market', () => {
      expect(() => polytope.updateMarketPrice('non-existent', 0.5)).toThrow(
        'Market non-existent not found'
      );
    });
  });

  describe('getPriceVector', () => {
    it('should return current price vector', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);
      const prices = polytope.getPriceVector();

      expect(prices).toHaveLength(2);
      expect(prices).toContain(0.6);
      expect(prices).toContain(0.4);
    });
  });

  describe('isFeasible', () => {
    it('should return true for valid probability distribution', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);

      // Valid distribution: YES + NO = 1
      expect(polytope.isFeasible([0.5, 0.5])).toBe(true);
      expect(polytope.isFeasible([0.7, 0.3])).toBe(true);
    });

    it('should return false for invalid distribution', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);

      // Invalid: doesn't sum to 1
      expect(polytope.isFeasible([0.5, 0.4])).toBe(false);

      // Invalid: negative probability
      expect(polytope.isFeasible([-0.1, 1.1])).toBe(false);

      // Invalid: exceeds 1
      expect(polytope.isFeasible([0.6, 0.6])).toBe(false);
    });

    it('should return false for wrong dimension', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);

      expect(polytope.isFeasible([0.5])).toBe(false);
      expect(polytope.isFeasible([0.5, 0.5, 0])).toBe(false);
    });
  });

  describe('project', () => {
    it('should project onto feasible region', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);

      // Project an infeasible point
      const projected = polytope.project([0.6, 0.6]);

      // Result should be feasible
      expect(polytope.isFeasible(projected)).toBe(true);

      // Should be close to [0.5, 0.5] for this simple case
      const sum = projected[0]! + projected[1]!;
      expect(sum).toBeCloseTo(1, 5);
    });
  });

  describe('detectSimpleArbitrage', () => {
    it('should detect arbitrage when YES + NO < 1', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.4 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);
      const opportunities = polytope.detectSimpleArbitrage();

      expect(opportunities).toHaveLength(1);
      expect(opportunities[0]!.deviation).toBeCloseTo(0.2, 5);
    });

    it('should detect arbitrage when YES + NO > 1', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.6 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);
      const opportunities = polytope.detectSimpleArbitrage();

      expect(opportunities).toHaveLength(1);
      expect(opportunities[0]!.deviation).toBeCloseTo(0.2, 5);
    });

    it('should not detect arbitrage when YES + NO = 1', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);
      const opportunities = polytope.detectSimpleArbitrage();

      expect(opportunities).toHaveLength(0);
    });

    it('should respect tolerance parameter', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.505 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.505 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);

      // With tolerance 0.02, should not detect (deviation is 0.01)
      expect(polytope.detectSimpleArbitrage(0.02)).toHaveLength(0);

      // With tolerance 0.005, should detect
      expect(polytope.detectSimpleArbitrage(0.005)).toHaveLength(1);
    });
  });

  describe('getBarycenter', () => {
    it('should return uniform distribution', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);
      const barycenter = polytope.getBarycenter();

      expect(barycenter).toEqual([0.5, 0.5]);
    });

    it('should handle multiple markets', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'm1', eventId: 'event-1', outcome: 'A', price: 0.3 },
          { id: 'm2', eventId: 'event-1', outcome: 'B', price: 0.3 },
          { id: 'm3', eventId: 'event-1', outcome: 'C', price: 0.4 },
        ],
        outcomes: ['A', 'B', 'C'],
      };

      polytope.addEvent(event);
      const barycenter = polytope.getBarycenter();

      expect(barycenter).toEqual([1 / 3, 1 / 3, 1 / 3]);
    });
  });

  describe('clear', () => {
    it('should clear all events and markets', () => {
      const event: Event = {
        id: 'event-1',
        markets: [
          { id: 'market-yes', eventId: 'event-1', outcome: 'YES', price: 0.6 },
          { id: 'market-no', eventId: 'event-1', outcome: 'NO', price: 0.4 },
        ],
        outcomes: ['YES', 'NO'],
      };

      polytope.addEvent(event);
      expect(polytope.getDimension()).toBe(2);

      polytope.clear();
      expect(polytope.getDimension()).toBe(0);
    });
  });
});
