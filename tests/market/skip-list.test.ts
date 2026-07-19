/**
 * Skip List Tests
 */

import { SkipList } from '../../src/market/skip-list.js';

describe('SkipList', () => {
  let list: SkipList;

  beforeEach(() => {
    list = new SkipList();
  });

  describe('insert', () => {
    it('should insert items in order', () => {
      list.insert(5, 100);
      list.insert(3, 200);
      list.insert(7, 300);

      const items = list.toArray();
      expect(items).toHaveLength(3);
      expect(items[0]!.price).toBe(3);
      expect(items[1]!.price).toBe(5);
      expect(items[2]!.price).toBe(7);
    });

    it('should update existing price', () => {
      list.insert(5, 100);
      list.insert(5, 200);

      const items = list.toArray();
      expect(items).toHaveLength(1);
      expect(items[0]!.size).toBe(200);
    });

    it('should maintain size count', () => {
      list.insert(1, 100);
      list.insert(2, 200);
      list.insert(3, 300);

      expect(list.getSize()).toBe(3);
    });
  });

  describe('delete', () => {
    it('should delete existing item', () => {
      list.insert(5, 100);
      list.insert(3, 200);

      expect(list.delete(3)).toBe(true);
      expect(list.toArray()).toHaveLength(1);
      expect(list.getSize()).toBe(1);
    });

    it('should return false for non-existent item', () => {
      list.insert(5, 100);

      expect(list.delete(3)).toBe(false);
      expect(list.toArray()).toHaveLength(1);
    });
  });

  describe('find', () => {
    it('should find existing item', () => {
      list.insert(5, 100);

      const found = list.find(5);
      expect(found).not.toBeNull();
      expect(found!.price).toBe(5);
      expect(found!.size).toBe(100);
    });

    it('should return null for non-existent item', () => {
      list.insert(5, 100);

      expect(list.find(3)).toBeNull();
    });
  });

  describe('getFirst', () => {
    it('should return first item', () => {
      list.insert(5, 100);
      list.insert(3, 200);
      list.insert(7, 300);

      const first = list.getFirst();
      expect(first).not.toBeNull();
      expect(first!.price).toBe(3);
    });

    it('should return null for empty list', () => {
      expect(list.getFirst()).toBeNull();
    });
  });

  describe('getLast', () => {
    it('should return last item', () => {
      list.insert(5, 100);
      list.insert(3, 200);
      list.insert(7, 300);

      const last = list.getLast();
      expect(last).not.toBeNull();
      expect(last!.price).toBe(7);
    });

    it('should return null for empty list', () => {
      expect(list.getLast()).toBeNull();
    });
  });

  describe('toArray', () => {
    it('should return sorted array', () => {
      const items = [
        { price: 10, size: 100 },
        { price: 5, size: 200 },
        { price: 15, size: 300 },
      ];

      items.forEach((i) => list.insert(i.price, i.size));

      const result = list.toArray();
      expect(result.map((r) => r.price)).toEqual([5, 10, 15]);
    });

    it('should return empty array for empty list', () => {
      expect(list.toArray()).toEqual([]);
    });

    it('should return descending array', () => {
      list.insert(10, 100);
      list.insert(5, 200);
      list.insert(15, 300);

      const result = list.toArrayDescending();
      expect(result.map((r) => r.price)).toEqual([15, 10, 5]);
    });

    it('should reject NaN, Infinity, and negative prices (would corrupt sorted invariant)', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01]) {
        expect(() => list.insert(bad, 100)).toThrow(/invalid price/);
      }
      // None of the rejected prices were inserted.
      expect(list.getSize()).toBe(0);
    });
  });

  describe('getSize', () => {
    it('should track size correctly', () => {
      expect(list.getSize()).toBe(0);

      list.insert(1, 100);
      expect(list.getSize()).toBe(1);

      list.insert(2, 200);
      expect(list.getSize()).toBe(2);

      list.delete(1);
      expect(list.getSize()).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should handle duplicate insertions', () => {
      list.insert(5, 100);
      list.insert(5, 200);
      list.insert(5, 300);

      expect(list.getSize()).toBe(1);
      expect(list.find(5)!.size).toBe(300);
    });

    it('should handle many insertions', () => {
      for (let i = 0; i < 100; i++) {
        list.insert(Math.random(), i);
      }

      const items = list.toArray();
      expect(items.length).toBe(100);

      // Check sorted
      for (let i = 1; i < items.length; i++) {
        expect(items[i]!.price).toBeGreaterThanOrEqual(items[i - 1]!.price);
      }
    });

    it('matches a naive sorted map under random insert/delete (MKT-9)', () => {
      // Deterministic PRNG so CI failures are reproducible.
      let state = 0x12345678;
      const rand = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
      };

      const naive = new Map<number, number>();
      const steps = 8_000;

      for (let i = 0; i < steps; i++) {
        const price = Math.floor(rand() * 200) / 100; // [0, 1.99] in 0.01 steps
        const size = Math.floor(rand() * 1000) + 1;
        if (rand() < 0.65 || naive.size === 0) {
          list.insert(price, size);
          naive.set(price, size);
        } else {
          const keys = [...naive.keys()];
          const victim = keys[Math.floor(rand() * keys.length)];
          if (victim === undefined) continue;
          list.delete(victim);
          naive.delete(victim);
        }

        if (i % 500 === 499 || i === steps - 1) {
          const expected = [...naive.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([price, size]) => ({ price, size }));
          expect(list.toArray()).toEqual(expected);
          expect(list.getSize()).toBe(naive.size);
          const first = list.getFirst();
          const last = list.getLast();
          if (expected.length > 0) {
            expect(first?.price).toBe(expected[0]?.price);
            expect(first?.size).toBe(expected[0]?.size);
            expect(last?.price).toBe(expected[expected.length - 1]?.price);
            expect(last?.size).toBe(expected[expected.length - 1]?.size);
          } else {
            expect(first).toBeNull();
            expect(last).toBeNull();
          }
        }
      }
    });
  });
});
