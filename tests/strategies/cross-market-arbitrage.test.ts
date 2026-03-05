import { OrderBook } from '../../src/market/order-book.js';
import { type StrategyMarketData } from '../../src/strategies/base.js';
import {
  CrossMarketArbitrageStrategy,
  type CrossMarketArbitrageConfig,
} from '../../src/strategies/cross-market-arbitrage.js';
import { resetDependencyGraph } from '../../src/market/dependency-graph.js';

describe('CrossMarketArbitrageStrategy', () => {
  let strategy: CrossMarketArbitrageStrategy;

  beforeEach(() => {
    resetDependencyGraph();
    strategy = new CrossMarketArbitrageStrategy({
      minProfitThreshold: 0.001,
      maxIterations: 50,
      alpha: 0.9,
      minConfidence: 0.5,
      maxPositionSize: 1000,
    });
  });

  afterEach(() => {
    resetDependencyGraph();
  });

  describe('基本功能', () => {
    it('当策略被禁用时返回 null', () => {
      strategy.updateConfig({ enabled: false });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.6, size: 100 }], [{ price: 0.61, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.3, size: 100 }], [{ price: 0.31, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.6,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.3,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('数据不足时返回 null', () => {
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.6, size: 100 }], [{ price: 0.61, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.6,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('空数据返回 null', () => {
      const signal = strategy.analyze([]);
      expect(signal).toBeNull();
    });

    it('检测到跨市场套利机会时返回交易信号', () => {
      // 创建价格有明显差异的市场对
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.7, size: 100 }], [{ price: 0.71, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.2, size: 100 }], [{ price: 0.21, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.7,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.2,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(signal?.type).toMatch(/^(buy|sell)$/);
      expect(signal?.confidence).toBeGreaterThanOrEqual(0);
      expect(signal?.confidence).toBeLessThanOrEqual(1);
      expect(signal?.metadata).toHaveProperty('arbitrageType', 'cross-market');
      expect(signal?.metadata).toHaveProperty('expectedProfit');
      expect(signal?.metadata).toHaveProperty('tradeVector');
    });

    it('交易信号包含正确的市场ID', () => {
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.8, size: 100 }], [{ price: 0.81, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.1, size: 100 }], [{ price: 0.11, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.8,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.1,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();
      expect(['event-yes', 'event-no']).toContain(signal?.marketId);
    });
  });

  describe('配置选项', () => {
    it('使用自定义配置初始化', () => {
      const customStrategy = new CrossMarketArbitrageStrategy({
        minProfitThreshold: 0.05,
        maxIterations: 200,
        alpha: 0.95,
        minConfidence: 0.7,
        maxPositionSize: 500,
      });

      const config = customStrategy.getConfig();
      expect(config.minConfidence).toBe(0.7);
      expect(config.maxPositionSize).toBe(500);
    });

    it('高利润阈值过滤低利润机会', () => {
      const highThresholdStrategy = new CrossMarketArbitrageStrategy({
        minProfitThreshold: 10.0, // 非常高的阈值
        maxIterations: 50,
        alpha: 0.9,
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.52, size: 100 }], [{ price: 0.53, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.48, size: 100 }], [{ price: 0.49, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.52,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.48,
          timestamp: Date.now(),
        },
      ];

      const signal = highThresholdStrategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('低置信度阈值过滤弱信号', () => {
      const highConfidenceStrategy = new CrossMarketArbitrageStrategy({
        minProfitThreshold: 0.01,
        maxIterations: 50,
        alpha: 0.1, // 很低的 alpha 会导致低置信度
        minConfidence: 0.99, // 非常高的置信度要求
      });

      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.6, size: 100 }], [{ price: 0.61, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.3, size: 100 }], [{ price: 0.31, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.6,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.3,
          timestamp: Date.now(),
        },
      ];

      const signal = highConfidenceStrategy.analyze(marketData);
      expect(signal).toBeNull();
    });
  });

  describe('addDependency', () => {
    it('添加互斥依赖关系', () => {
      expect(() => {
        strategy.addDependency('market-a', 'market-b', 'mutex');
      }).not.toThrow();
    });

    it('添加蕴含依赖关系', () => {
      expect(() => {
        strategy.addDependency('market-a', 'market-b', 'implies');
      }).not.toThrow();
    });

    it('多次添加依赖不抛出错误', () => {
      expect(() => {
        strategy.addDependency('market-a', 'market-b', 'mutex');
        strategy.addDependency('market-c', 'market-d', 'implies');
        strategy.addDependency('market-e', 'market-f', 'mutex');
      }).not.toThrow();
    });

    it('analyze 重建图后仍应重放已注册依赖', () => {
      const replayStrategy = new CrossMarketArbitrageStrategy({
        minProfitThreshold: 0.001,
        maxIterations: 50,
        alpha: 0.9,
        cooldownMs: 0,
      });
      replayStrategy.addDependency('event-a-yes', 'event-b-yes', 'implies');

      const aYesBook = new OrderBook('event-a-yes');
      aYesBook.update([{ price: 0.7, size: 100 }], [{ price: 0.71, size: 100 }]);
      const aNoBook = new OrderBook('event-a-no');
      aNoBook.update([{ price: 0.2, size: 100 }], [{ price: 0.21, size: 100 }]);
      const bYesBook = new OrderBook('event-b-yes');
      bYesBook.update([{ price: 0.65, size: 100 }], [{ price: 0.66, size: 100 }]);
      const bNoBook = new OrderBook('event-b-no');
      bNoBook.update([{ price: 0.25, size: 100 }], [{ price: 0.26, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        { marketId: 'event-a-yes', orderBook: aYesBook, lastPrice: 0.7, timestamp: Date.now() },
        { marketId: 'event-a-no', orderBook: aNoBook, lastPrice: 0.2, timestamp: Date.now() },
        { marketId: 'event-b-yes', orderBook: bYesBook, lastPrice: 0.65, timestamp: Date.now() },
        { marketId: 'event-b-no', orderBook: bNoBook, lastPrice: 0.25, timestamp: Date.now() },
      ];

      replayStrategy.analyze(marketData);
      let matrix = (replayStrategy as any).dependencyGraph.buildConstraintMatrix() as {
        descriptions: string[];
      };
      expect(matrix.descriptions.some((d) => d.includes('Implication'))).toBe(true);

      replayStrategy.analyze(marketData);
      matrix = (replayStrategy as any).dependencyGraph.buildConstraintMatrix() as {
        descriptions: string[];
      };
      expect(matrix.descriptions.some((d) => d.includes('Implication'))).toBe(true);
    });
  });

  describe('市场ID解析', () => {
    it('正确解析下划线格式的event ID', () => {
      const yesBook = new OrderBook('event_123_yes');
      yesBook.update([{ price: 0.7, size: 100 }], [{ price: 0.71, size: 100 }]);

      const noBook = new OrderBook('event_123_no');
      noBook.update([{ price: 0.2, size: 100 }], [{ price: 0.21, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event_123_yes',
          orderBook: yesBook,
          lastPrice: 0.7,
          timestamp: Date.now(),
        },
        {
          marketId: 'event_123_no',
          orderBook: noBook,
          lastPrice: 0.2,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      // 应该能正常处理，不抛出错误
      expect(signal === null || typeof signal === 'object').toBe(true);
    });

    it('处理没有标准后缀的市场ID', () => {
      const book1 = new OrderBook('market-a');
      book1.update([{ price: 0.6, size: 100 }], [{ price: 0.61, size: 100 }]);

      const book2 = new OrderBook('market-b');
      book2.update([{ price: 0.3, size: 100 }], [{ price: 0.31, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'market-a',
          orderBook: book1,
          lastPrice: 0.6,
          timestamp: Date.now(),
        },
        {
          marketId: 'market-b',
          orderBook: book2,
          lastPrice: 0.3,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      // 应该能正常处理，不抛出错误
      expect(signal === null || typeof signal === 'object').toBe(true);
    });

    it('不应错误截断非 yes/no 后缀市场ID 的事件名', () => {
      const eventId = (strategy as any).extractEventId('market-a');
      expect(eventId).toBe('market-a');
    });

    it('处理复杂事件ID格式', () => {
      const yesBook = new OrderBook('us-election-2024-winner-yes');
      yesBook.update([{ price: 0.65, size: 100 }], [{ price: 0.66, size: 100 }]);

      const noBook = new OrderBook('us-election-2024-winner-no');
      noBook.update([{ price: 0.35, size: 100 }], [{ price: 0.36, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'us-election-2024-winner-yes',
          orderBook: yesBook,
          lastPrice: 0.65,
          timestamp: Date.now(),
        },
        {
          marketId: 'us-election-2024-winner-no',
          orderBook: noBook,
          lastPrice: 0.35,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal === null || typeof signal === 'object').toBe(true);
    });
  });

  describe('单位一致性', () => {
    it('trade vector 应保持概率单位而非放大 100 倍', () => {
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.8, size: 100 }], [{ price: 0.81, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.1, size: 100 }], [{ price: 0.11, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.8,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.1,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).not.toBeNull();

      const tradeVector =
        (signal?.metadata as { tradeVector?: number[] } | undefined)?.tradeVector ?? [];
      const maxAbs = tradeVector.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
      expect(maxAbs).toBeLessThanOrEqual(1);
    });
  });

  describe('边界情况', () => {
    it('生成的解应满足每个事件的概率和约束', () => {
      const constraintAwareStrategy = new CrossMarketArbitrageStrategy({
        minProfitThreshold: 0,
        maxIterations: 80,
        alpha: 0.9,
        minConfidence: 0,
      });

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-a-yes',
          orderBook: createOrderBook('event-a-yes', 0.69),
          lastPrice: 0.7,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-a-no',
          orderBook: createOrderBook('event-a-no', 0.19),
          lastPrice: 0.2,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-b-yes',
          orderBook: createOrderBook('event-b-yes', 0.79),
          lastPrice: 0.8,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-b-no',
          orderBook: createOrderBook('event-b-no', 0.29),
          lastPrice: 0.3,
          timestamp: Date.now(),
        },
      ];

      const signal = constraintAwareStrategy.analyze(marketData);
      expect(signal).not.toBeNull();

      const tradeVector = signal?.metadata?.tradeVector as number[] | undefined;
      expect(Array.isArray(tradeVector)).toBe(true);
      expect(tradeVector).toHaveLength(marketData.length);

      const inferredMu = marketData.map((m, i) => m.lastPrice + (tradeVector?.[i] ?? 0));
      const eventASum = (inferredMu[0] ?? 0) + (inferredMu[1] ?? 0);
      const eventBSum = (inferredMu[2] ?? 0) + (inferredMu[3] ?? 0);

      expect(eventASum).toBeCloseTo(1, 3);
      expect(eventBSum).toBeCloseTo(1, 3);
    });

    it('处理价格总和不为1的市场', () => {
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.9, size: 100 }], [{ price: 0.91, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.3, size: 100 }], [{ price: 0.31, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.9,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.3,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      // 应该能处理价格异常，可能返回null或信号
      expect(signal === null || typeof signal === 'object').toBe(true);
    });

    it('处理零价格市场', () => {
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.001, size: 100 }], [{ price: 0.002, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.001, size: 100 }], [{ price: 0.002, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.001,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.001,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal === null || typeof signal === 'object').toBe(true);
    });

    it('处理多个市场（超过2个）', () => {
      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-outcome-a',
          orderBook: createOrderBook('event-outcome-a', 0.3),
          lastPrice: 0.3,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-outcome-b',
          orderBook: createOrderBook('event-outcome-b', 0.4),
          lastPrice: 0.4,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-outcome-c',
          orderBook: createOrderBook('event-outcome-c', 0.2),
          lastPrice: 0.2,
          timestamp: Date.now(),
        },
      ];

      const signal = strategy.analyze(marketData);
      expect(signal === null || typeof signal === 'object').toBe(true);
    });

    it('冷却期间不生成信号', () => {
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.8, size: 100 }], [{ price: 0.81, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.1, size: 100 }], [{ price: 0.11, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.8,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.1,
          timestamp: Date.now(),
        },
      ];

      // 第一次调用应该生成信号
      const signal1 = strategy.analyze(marketData);

      // 立即再次调用，应该在冷却期内
      const signal2 = strategy.analyze(marketData);

      // 如果第一次有信号，第二次应该在冷却期内返回null
      if (signal1 !== null) {
        expect(signal2).toBeNull();
      }
    });
  });

  describe('错误处理', () => {
    it('处理无效的市场数据', () => {
      const yesBook = new OrderBook('event-yes');
      // 不更新订单簿，保持为空

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.5, size: 100 }], [{ price: 0.51, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: NaN, // 无效价格
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.5,
          timestamp: Date.now(),
        },
      ];

      // 不应该抛出错误
      expect(() => strategy.analyze(marketData)).not.toThrow();
    });

    it('处理极端价格值', () => {
      const yesBook = new OrderBook('event-yes');
      yesBook.update([{ price: 0.99, size: 100 }], [{ price: 0.995, size: 100 }]);

      const noBook = new OrderBook('event-no');
      noBook.update([{ price: 0.99, size: 100 }], [{ price: 0.995, size: 100 }]);

      const marketData: StrategyMarketData[] = [
        {
          marketId: 'event-yes',
          orderBook: yesBook,
          lastPrice: 0.99,
          timestamp: Date.now(),
        },
        {
          marketId: 'event-no',
          orderBook: noBook,
          lastPrice: 0.99,
          timestamp: Date.now(),
        },
      ];

      expect(() => strategy.analyze(marketData)).not.toThrow();
    });
  });
});

// 辅助函数
function createOrderBook(marketId: string, price: number): OrderBook {
  const book = new OrderBook(marketId);
  book.update([{ price: price - 0.01, size: 100 }], [{ price: price + 0.01, size: 100 }]);
  return book;
}
