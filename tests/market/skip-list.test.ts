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
  });
});
