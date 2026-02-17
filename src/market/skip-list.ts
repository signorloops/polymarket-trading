/**
 * High-performance Skip List implementation
 *
 * Provides O(log n) insertion, deletion, and lookup operations
 * compared to O(n log n) for sorted arrays.
 */

interface SkipListNode {
  price: number;
  size: number;
  next: Array<SkipListNode | null>;
  prev: Array<SkipListNode | null>;
}

export class SkipList {
  private head: SkipListNode;
  private maxLevel: number;
  private level: number;
  private size: number;
  private p: number;

  constructor(maxLevel = 16, p = 0.5) {
    this.maxLevel = maxLevel;
    this.p = p;
    this.level = 0;
    this.size = 0;
    this.head = {
      price: -Infinity,
      size: 0,
      next: new Array(maxLevel).fill(null),
      prev: new Array(maxLevel).fill(null),
    };
  }

  private randomLevel(): number {
    let level = 0;
    while (Math.random() < this.p && level < this.maxLevel - 1) {
      level++;
    }
    return level;
  }

  insert(price: number, size: number): void {
    const update: Array<SkipListNode | null> = new Array(this.maxLevel).fill(null);
    let current: SkipListNode = this.head;

    for (let i = this.level; i >= 0; i--) {
      let nextNode = current.next[i];
      while (nextNode && nextNode.price < price) {
        current = nextNode;
        nextNode = current.next[i];
      }
      update[i] = current;
    }

    const nextAtZero = current.next[0];
    if (nextAtZero && nextAtZero.price === price) {
      nextAtZero.size = size;
    } else {
      const newLevel = this.randomLevel();
      if (newLevel > this.level) {
        for (let i = this.level + 1; i <= newLevel; i++) {
          update[i] = this.head;
        }
        this.level = newLevel;
      }

      const newNode: SkipListNode = {
        price,
        size,
        next: new Array(newLevel + 1).fill(null),
        prev: new Array(newLevel + 1).fill(null),
      };

      for (let i = 0; i <= newLevel; i++) {
        const updateNode = update[i];
        if (updateNode) {
          const nextAtLevel = updateNode.next[i];
          newNode.next[i] = nextAtLevel ?? null;
          if (nextAtLevel) {
            nextAtLevel.prev[i] = newNode;
          }
          updateNode.next[i] = newNode;
          newNode.prev[i] = updateNode;
        }
      }
      this.size++;
    }
  }

  delete(price: number): boolean {
    const update: Array<SkipListNode | null> = new Array(this.maxLevel).fill(null);
    let current: SkipListNode = this.head;

    for (let i = this.level; i >= 0; i--) {
      let nextNode = current.next[i];
      while (nextNode && nextNode.price < price) {
        current = nextNode;
        nextNode = current.next[i];
      }
      update[i] = current;
    }

    const target = current.next[0];
    if (target && target.price === price) {
      for (let i = 0; i <= this.level; i++) {
        const updateNode = update[i];
        if (updateNode && updateNode.next[i] === target) {
          const targetNext = target.next[i];
          updateNode.next[i] = targetNext ?? null;
          if (targetNext) {
            targetNext.prev[i] = updateNode;
          }
        }
      }

      while (this.level > 0 && !this.head.next[this.level]) {
        this.level--;
      }

      this.size--;
      return true;
    }

    return false;
  }

  find(price: number): SkipListNode | null {
    let current: SkipListNode = this.head;

    for (let i = this.level; i >= 0; i--) {
      let nextNode = current.next[i];
      while (nextNode && nextNode.price < price) {
        current = nextNode;
        nextNode = current.next[i];
      }
    }

    const result = current.next[0];
    if (result && result.price === price) {
      return result;
    }

    return null;
  }

  getFirst(): SkipListNode | null {
    return this.head.next[0] ?? null;
  }

  getLast(): SkipListNode | null {
    let current: SkipListNode = this.head;
    let nextNode = current.next[0];
    while (nextNode) {
      current = nextNode;
      nextNode = current.next[0];
    }
    return current === this.head ? null : current;
  }

  toArray(): Array<{ price: number; size: number }> {
    const result: Array<{ price: number; size: number }> = [];
    let current = this.head.next[0];

    while (current) {
      result.push({ price: current.price, size: current.size });
      current = current.next[0];
    }

    return result;
  }

  getSize(): number {
    return this.size;
  }
}
