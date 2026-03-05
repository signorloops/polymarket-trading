/**
 * Unit tests for order book
 */

import {
  OrderBook,
  OrderBookManager,
  getOrderBookManager,
  resetOrderBookManager,
} from '../../src/market/order-book.js';

describe('OrderBook', () => {
  let book: OrderBook;

  beforeEach(() => {
    book = new OrderBook('market-1');
  });

  describe('update', () => {
    it('should update bids and asks', () => {
      book.update(
        [
          { price: 0.6, size: 100 },
          { price: 0.55, size: 200 },
        ],
        [
          { price: 0.65, size: 150 },
          { price: 0.7, size: 100 },
        ]
      );

      const snapshot = book.getSnapshot();
      expect(snapshot.bids).toHaveLength(2);
      expect(snapshot.asks).toHaveLength(2);
    });

    it('should remove zero-size levels', () => {
      book.update([{ price: 0.6, size: 100 }], [{ price: 0.65, size: 150 }]);

      book.update([{ price: 0.6, size: 0 }], [{ price: 0.65, size: 150 }]);

      const snapshot = book.getSnapshot();
      expect(snapshot.bids).toHaveLength(0);
    });
  });

  describe('getBestBid/Ask', () => {
    it('should return best bid (highest price)', () => {
      book.update(
        [
          { price: 0.6, size: 100 },
          { price: 0.65, size: 200 },
        ],
        [{ price: 0.7, size: 150 }]
      );

      const bestBid = book.getBestBid();
      expect(bestBid).toEqual({ price: 0.65, size: 200 });
    });

    it('should return best ask (lowest price)', () => {
      book.update(
        [{ price: 0.6, size: 100 }],
        [
          { price: 0.7, size: 150 },
          { price: 0.68, size: 200 },
        ]
      );

      const bestAsk = book.getBestAsk();
      expect(bestAsk).toEqual({ price: 0.68, size: 200 });
    });

    it('should return null for empty book', () => {
      expect(book.getBestBid()).toBeNull();
      expect(book.getBestAsk()).toBeNull();
    });
  });

  describe('getMidPrice', () => {
    it('should calculate mid price', () => {
      book.update([{ price: 0.6, size: 100 }], [{ price: 0.7, size: 150 }]);

      expect(book.getMidPrice()).toBeCloseTo(0.65, 10);
    });

    it('should return null for empty book', () => {
      expect(book.getMidPrice()).toBeNull();
    });
  });

  describe('getSpread', () => {
    it('should calculate spread', () => {
      book.update([{ price: 0.6, size: 100 }], [{ price: 0.7, size: 150 }]);

      expect(book.getSpread()).toBeCloseTo(0.1, 10);
    });
  });

  describe('calculateVWAP', () => {
    it('should calculate VWAP for buy order', () => {
      book.update(
        [{ price: 0.6, size: 100 }],
        [
          { price: 0.7, size: 100 },
          { price: 0.75, size: 100 },
        ]
      );

      const vwap = book.calculateVWAP(150, 'buy');

      // (100 * 0.7 + 50 * 0.75) / 150 = 0.7167
      expect(vwap.vwap).toBeCloseTo(0.7167, 3);
      expect(vwap.executedSize).toBe(150);
      expect(vwap.remainingSize).toBe(0);
    });

    it('should handle insufficient liquidity', () => {
      book.update([{ price: 0.6, size: 100 }], [{ price: 0.7, size: 50 }]);

      const vwap = book.calculateVWAP(100, 'buy');

      expect(vwap.executedSize).toBe(50);
      expect(vwap.remainingSize).toBe(50);
    });
  });

  describe('calculateSlippage', () => {
    it('should calculate slippage', () => {
      book.update(
        [{ price: 0.6, size: 100 }],
        [
          { price: 0.7, size: 100 },
          { price: 0.72, size: 100 },
        ]
      );

      const slippage = book.calculateSlippage(150, 'buy');

      // VWAP > mid price for buy
      expect(slippage).toBeGreaterThan(0);
    });

    it('should return Infinity for insufficient liquidity', () => {
      book.update([{ price: 0.6, size: 100 }], [{ price: 0.7, size: 50 }]);

      const slippage = book.calculateSlippage(100, 'buy');
      expect(slippage).toBe(Infinity);
    });
  });
});

describe('OrderBookManager', () => {
  beforeEach(() => {
    resetOrderBookManager();
  });

  describe('getBook', () => {
    it('should create book if not exists', () => {
      const manager = getOrderBookManager();
      const book = manager.getBook('market-1');

      expect(book).toBeInstanceOf(OrderBook);
    });

    it('should return existing book', () => {
      const manager = getOrderBookManager();
      const book1 = manager.getBook('market-1');
      const book2 = manager.getBook('market-1');

      expect(book1).toBe(book2);
    });
  });

  describe('updateBook', () => {
    it('should update existing book', () => {
      const manager = getOrderBookManager();

      manager.updateBook('market-1', [{ price: 0.6, size: 100 }], [{ price: 0.7, size: 150 }]);

      const book = manager.getBook('market-1');
      expect(book.getBestBid()).toEqual({ price: 0.6, size: 100 });
    });
  });

  describe('getAllBooks', () => {
    it('should return all books', () => {
      const manager = getOrderBookManager();

      manager.getBook('market-1');
      manager.getBook('market-2');

      expect(manager.getAllBooks()).toHaveLength(2);
    });
  });
});
