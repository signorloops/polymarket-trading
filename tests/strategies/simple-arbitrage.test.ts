import { OrderBook } from '../../src/market/order-book.js';
import { type StrategyMarketData } from '../../src/strategies/base.js';
import { SimpleArbitrageStrategy } from '../../src/strategies/simple-arbitrage.js';

describe('SimpleArbitrageStrategy', () => {
  it('should emit a paired trade plan for YES/NO mispricing', () => {
    const strategy = new SimpleArbitrageStrategy({
      minProfitThreshold: 0.02,
      maxSlippage: 0.01,
      minConfidence: 0.1,
    });

    const yesBook = new OrderBook('event-yes');
    yesBook.update([{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]);

    const noBook = new OrderBook('event-no');
    noBook.update([{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]);

    const marketData: StrategyMarketData[] = [
      {
        marketId: 'event-yes',
        orderBook: yesBook,
        lastPrice: 0.56,
        timestamp: Date.now(),
      },
      {
        marketId: 'event-no',
        orderBook: noBook,
        lastPrice: 0.41,
        timestamp: Date.now(),
      },
    ];

    const signal = strategy.analyze(marketData);
    expect(signal).not.toBeNull();

    const pairedLegs = signal?.metadata?.['pairedLegs'] as
      | Array<{ marketId: string; side: 'buy' | 'sell'; size: number; price: number }>
      | undefined;

    expect(pairedLegs).toBeDefined();
    expect(pairedLegs).toHaveLength(2);
    expect(pairedLegs?.map((l) => l.marketId).sort()).toEqual(['event-no', 'event-yes']);
    expect(new Set(pairedLegs?.map((l) => l.side))).toEqual(new Set(['buy']));
  });
});
