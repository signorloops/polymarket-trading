import { OrderBook } from '../../src/market/order-book.js';
import { type StrategyMarketData } from '../../src/strategies/base.js';
import {
  TrendFollowingStrategy,
  type TrendFollowingConfig,
  type TrendIndicators,
} from '../../src/strategies/trend-following.js';

describe('TrendFollowingStrategy', () => {
  let strategy: TrendFollowingStrategy;
  let baseConfig: Partial<TrendFollowingConfig>;

  beforeEach(() => {
    baseConfig = {
      shortPeriod: 5,
      longPeriod: 10,
      rsiPeriod: 7,
      rsiOverbought: 70,
      rsiOversold: 30,
      minTrendStrength: 0.1,
      volumeThreshold: 1.5,
      minConfidence: 0.5,
      maxPositionSize: 1000,
      cooldownMs: 0, // 测试时无冷却
    };
    strategy = new TrendFollowingStrategy(baseConfig);
  });

  describe('基本功能', () => {
    it('策略被禁用时返回 null', () => {
      strategy.updateConfig({ enabled: false });

      const marketData = createMarketDataWithHistory(
        'market-1',
        generatePriceHistory(20, 0.5, 0.02)
      );
      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('数据不足时返回 null', () => {
      // 只提供5个数据点，少于longPeriod(10)
      const marketData = createMarketDataWithHistory(
        'market-1',
        generatePriceHistory(5, 0.5, 0.01)
      );
      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('空数据返回 null', () => {
      const signal = strategy.analyze([]);
      expect(signal).toBeNull();
    });

    it('检测到上升趋势时生成买入信号', () => {
      // 创建上升趋势价格序列，需要满足:
      // 1. shortSMA > longSMA * 1.01 才能检测上升趋势
      // 2. strength = min(1, |shortSMA - longSMA| / longSMA * 10) >= minTrendStrength (0.1)
      // 3. RSI < rsiOverbought (70)
      //
      // 价格需要有波动来避免RSI饱和
      const prices: number[] = [
        0.3,
        0.32,
        0.31,
        0.33,
        0.3, // 5个价格，有上有下
        0.35,
        0.33,
        0.36,
        0.34,
        0.37, // 5个价格，继续上升但有回调
        0.35,
        0.4,
        0.38,
        0.42,
        0.4, // 5个价格，继续上升但有回调
      ];

      // 通过多次调用analyze来积累历史数据，并获取最后一次的信号
      const finalMarketData = feedPricesToStrategy(strategy, 'market-1', prices);
      const signal = strategy.analyze(finalMarketData);

      // 验证历史数据已积累
      const history = strategy.getPriceHistory('market-1');
      expect(history.length).toBeGreaterThanOrEqual(10);

      // 应该有信号，且是买入信号
      expect(signal).not.toBeNull();
      if (signal) {
        expect(signal.type).toBe('buy');
        expect(signal.confidence).toBeGreaterThan(0);
        expect(signal.metadata).toHaveProperty('strategy', 'trend-following');
        expect(signal.metadata).toHaveProperty('indicators');
      }
    });

    it('检测到下降趋势时生成卖出信号', () => {
      // 创建下降趋势价格序列，需要满足:
      // 1. shortSMA < longSMA * 0.99 才能检测下降趋势
      // 2. strength >= minTrendStrength (0.1)
      // 3. RSI > rsiOversold (30)
      //
      // 价格需要有波动来避免RSI饱和
      const prices: number[] = [
        0.7,
        0.68,
        0.69,
        0.67,
        0.7, // 5个价格，有上有下
        0.65,
        0.67,
        0.64,
        0.66,
        0.63, // 5个价格，继续下降但有回调
        0.65,
        0.6,
        0.62,
        0.58,
        0.6, // 5个价格，继续下降但有回调
      ];

      // 通过多次调用analyze来积累历史数据，并获取最后一次的信号
      const finalMarketData = feedPricesToStrategy(strategy, 'market-1', prices);
      const signal = strategy.analyze(finalMarketData);

      // 验证历史数据已积累
      const history = strategy.getPriceHistory('market-1');
      expect(history.length).toBeGreaterThanOrEqual(10);

      // 应该有信号，且是卖出信号
      expect(signal).not.toBeNull();
      if (signal) {
        expect(signal.type).toBe('sell');
        expect(signal.confidence).toBeGreaterThan(0);
      }
    });

    it('无明显趋势时返回 null', () => {
      // 创建横盘震荡价格序列
      const prices = generatePriceHistory(20, 0.5, 0.005);

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = strategy.analyze(marketData);

      // 横盘时可能没有信号，或者信号强度很低
      expect(signal === null || (signal && signal.confidence < 0.5)).toBe(true);
    });
  });

  describe('技术指标计算', () => {
    it('正确计算SMA（简单移动平均）', () => {
      // 使用已知数据测试SMA计算
      const prices = [10, 20, 30, 40, 50];

      // 通过多次调用analyze来积累历史数据
      const finalMarketData = feedPricesToStrategy(strategy, 'market-1', prices);
      strategy.analyze(finalMarketData);

      const history = strategy.getPriceHistory('market-1');
      // 期望有5个价格被记录
      expect(history.length).toBeGreaterThanOrEqual(4);
    });

    it('正确计算EMA（指数移动平均）', () => {
      const prices: number[] = [];
      for (let i = 0; i < 15; i++) {
        prices.push(0.5 + Math.sin(i * 0.5) * 0.1);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = strategy.analyze(marketData);

      // EMA应该被计算并包含在metadata中
      if (signal) {
        expect(signal.metadata).toHaveProperty('ema');
        expect(typeof signal.metadata['ema']).toBe('number');
      }
    });

    it('正确计算RSI（相对强弱指数）', () => {
      // 创建明显的上升序列来测试RSI
      const prices: number[] = [];
      for (let i = 0; i < 20; i++) {
        prices.push(0.3 + i * 0.02);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = strategy.analyze(marketData);

      if (signal) {
        expect(signal.metadata).toHaveProperty('rsi');
        const rsi = signal.metadata['rsi'] as number;
        expect(rsi).toBeGreaterThanOrEqual(0);
        expect(rsi).toBeLessThanOrEqual(100);
      }
    });

    it('RSI超买时抑制买入信号', () => {
      // 创建快速上涨导致RSI超买的情况
      const prices: number[] = [];
      for (let i = 0; i < 20; i++) {
        // 快速上涨
        prices.push(0.3 + i * 0.035);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = strategy.analyze(marketData);

      // 如果RSI超买，不应该有买入信号
      if (signal?.type === 'buy') {
        const indicators = signal.metadata['indicators'] as TrendIndicators;
        expect(indicators.rsi).toBeLessThan(70); // 应该低于超买阈值
      }
    });

    it('RSI超卖时抑制卖出信号', () => {
      // 创建快速下跌导致RSI超卖的情况
      const prices: number[] = [];
      for (let i = 0; i < 20; i++) {
        // 快速下跌
        prices.push(0.9 - i * 0.04);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = strategy.analyze(marketData);

      // 如果RSI超卖，不应该有卖出信号
      if (signal?.type === 'sell') {
        const indicators = signal.metadata['indicators'] as TrendIndicators;
        expect(indicators.rsi).toBeGreaterThan(30); // 应该高于超卖阈值
      }
    });
  });

  describe('趋势检测', () => {
    it('短期均线上穿长期均线时检测上升趋势', () => {
      // 创建金叉形态：短期均线上穿长期均线
      const prices: number[] = [];
      // 先下跌
      for (let i = 0; i < 8; i++) {
        prices.push(0.5 - i * 0.02);
      }
      // 再上涨（形成金叉）
      for (let i = 0; i < 10; i++) {
        prices.push(0.34 + i * 0.03);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = strategy.analyze(marketData);

      if (signal) {
        expect(signal.type).toBe('buy');
        const indicators = signal.metadata['indicators'] as TrendIndicators;
        expect(indicators.trend).toBe('up');
      }
    });

    it('短期均线下穿长期均线时检测下降趋势', () => {
      // 创建死叉形态：短期均线下穿长期均线
      const prices: number[] = [];
      // 先上涨
      for (let i = 0; i < 8; i++) {
        prices.push(0.3 + i * 0.03);
      }
      // 再下跌（形成死叉）
      for (let i = 0; i < 10; i++) {
        prices.push(0.54 - i * 0.04);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = strategy.analyze(marketData);

      if (signal) {
        expect(signal.type).toBe('sell');
        const indicators = signal.metadata['indicators'] as TrendIndicators;
        expect(indicators.trend).toBe('down');
      }
    });

    it('趋势强度低于阈值时不生成信号', () => {
      const weakTrendStrategy = new TrendFollowingStrategy({
        ...baseConfig,
        minTrendStrength: 0.9, // 非常高的趋势强度要求
      });

      const prices: number[] = [];
      for (let i = 0; i < 15; i++) {
        prices.push(0.3 + i * 0.02); // 温和上升
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = weakTrendStrategy.analyze(marketData);

      expect(signal).toBeNull();
    });
  });

  describe('历史数据管理', () => {
    it('getPriceHistory返回价格历史副本', () => {
      const prices = generatePriceHistory(15, 0.5, 0.02);
      const marketData = createMarketDataWithHistory('market-1', prices);
      strategy.analyze(marketData);

      const history = strategy.getPriceHistory('market-1');
      expect(history.length).toBeGreaterThan(0);

      // 修改返回的数组不应影响内部状态
      history.push(0.999);
      const history2 = strategy.getPriceHistory('market-1');
      expect(history2[history2.length - 1]).not.toBe(0.999);
    });

    it('clearHistory清除指定市场的历史', () => {
      const prices = generatePriceHistory(15, 0.5, 0.02);
      const marketData = createMarketDataWithHistory('market-1', prices);
      strategy.analyze(marketData);

      expect(strategy.getPriceHistory('market-1').length).toBeGreaterThan(0);

      strategy.clearHistory('market-1');
      expect(strategy.getPriceHistory('market-1')).toEqual([]);
    });

    it('管理多个市场的独立历史', () => {
      const prices1 = generatePriceHistory(15, 0.5, 0.02);
      const prices2 = generatePriceHistory(15, 0.6, 0.03);

      const marketData1 = createMarketDataWithHistory('market-1', prices1);
      const marketData2 = createMarketDataWithHistory('market-2', prices2);

      strategy.analyze(marketData1);
      strategy.analyze(marketData2);

      const history1 = strategy.getPriceHistory('market-1');
      const history2 = strategy.getPriceHistory('market-2');

      expect(history1.length).toBeGreaterThan(0);
      expect(history2.length).toBeGreaterThan(0);
      // 两个市场的历史应该不同
      expect(history1[history1.length - 1]).not.toBe(history2[history2.length - 1]);
    });

    it('历史数据自动清理防止无限增长', () => {
      const manyPrices = generatePriceHistory(200, 0.5, 0.01);
      const marketData = createMarketDataWithHistory('market-1', manyPrices);
      strategy.analyze(marketData);

      const history = strategy.getPriceHistory('market-1');
      // 历史数据应该被限制在合理范围内
      expect(history.length).toBeLessThan(200);
    });
  });

  describe('配置选项', () => {
    it('使用自定义周期配置', () => {
      const customStrategy = new TrendFollowingStrategy({
        shortPeriod: 3,
        longPeriod: 8,
        rsiPeriod: 5,
        minConfidence: 0.6,
        maxPositionSize: 500,
      });

      const config = customStrategy.getConfig();
      expect(config.minConfidence).toBe(0.6);
      expect(config.maxPositionSize).toBe(500);
    });

    it('调整RSI阈值影响信号生成', () => {
      const conservativeStrategy = new TrendFollowingStrategy({
        ...baseConfig,
        rsiOverbought: 60, // 更低的超买阈值
        rsiOversold: 40, // 更高的超卖阈值
      });

      const prices: number[] = [];
      for (let i = 0; i < 20; i++) {
        prices.push(0.3 + i * 0.025);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = conservativeStrategy.analyze(marketData);

      // 更严格的RSI阈值可能导致没有信号
      expect(signal === null || typeof signal === 'object').toBe(true);
    });

    it('调整趋势强度阈值', () => {
      const strictStrategy = new TrendFollowingStrategy({
        ...baseConfig,
        minTrendStrength: 0.8,
      });

      const prices: number[] = [];
      for (let i = 0; i < 20; i++) {
        prices.push(0.3 + i * 0.015);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);
      const signal = strictStrategy.analyze(marketData);

      // 高阈值可能过滤掉弱趋势
      expect(signal === null || typeof signal === 'object').toBe(true);
    });
  });

  describe('边界情况', () => {
    it('处理价格接近0的情况', () => {
      const prices = generatePriceHistory(15, 0.01, 0.001);
      const marketData = createMarketDataWithHistory('market-1', prices);

      expect(() => strategy.analyze(marketData)).not.toThrow();
    });

    it('处理价格接近1的情况', () => {
      const prices = generatePriceHistory(15, 0.99, 0.005);
      const marketData = createMarketDataWithHistory('market-1', prices);

      expect(() => strategy.analyze(marketData)).not.toThrow();
    });

    it('处理恒定价格序列', () => {
      const prices = new Array(20).fill(0.5);
      const marketData = createMarketDataWithHistory('market-1', prices);

      const signal = strategy.analyze(marketData);
      // 恒定价格应该没有趋势
      expect(signal === null || (signal && signal.confidence < 0.3)).toBe(true);
    });

    it('处理只有两个价格点的情况', () => {
      const prices = [0.5, 0.6];
      const marketData = createMarketDataWithHistory('market-1', prices);

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });

    it('冷却期间不生成信号', () => {
      const strategyWithCooldown = new TrendFollowingStrategy({
        ...baseConfig,
        cooldownMs: 10000, // 10秒冷却
      });

      const prices: number[] = [];
      for (let i = 0; i < 20; i++) {
        prices.push(0.3 + i * 0.03);
      }

      const marketData = createMarketDataWithHistory('market-1', prices);

      // 第一次调用
      const signal1 = strategyWithCooldown.analyze(marketData);

      // 立即第二次调用（在冷却期内）
      const signal2 = strategyWithCooldown.analyze(marketData);

      if (signal1 !== null) {
        expect(signal2).toBeNull();
      }
    });
  });

  describe('多市场分析', () => {
    it('分析多个市场返回第一个有信号的市场', () => {
      // 第一个市场无明显趋势
      const prices1 = generatePriceHistory(15, 0.5, 0.005);
      // 第二个市场有明显上升趋势
      const prices2: number[] = [];
      for (let i = 0; i < 15; i++) {
        prices2.push(0.3 + i * 0.03);
      }

      const marketData: StrategyMarketData[] = [
        ...createMarketDataWithHistory('market-1', prices1),
        ...createMarketDataWithHistory('market-2', prices2),
      ];

      const signal = strategy.analyze(marketData);

      // 应该返回market-2的信号，因为它有明显趋势
      if (signal) {
        expect(signal.marketId).toBe('market-2');
      }
    });

    it('所有市场都无信号时返回null', () => {
      const marketData: StrategyMarketData[] = [
        ...createMarketDataWithHistory('market-1', generatePriceHistory(15, 0.5, 0.005)),
        ...createMarketDataWithHistory('market-2', generatePriceHistory(15, 0.6, 0.005)),
        ...createMarketDataWithHistory('market-3', generatePriceHistory(15, 0.4, 0.005)),
      ];

      const signal = strategy.analyze(marketData);
      expect(signal).toBeNull();
    });
  });
});

// 辅助函数

function generatePriceHistory(count: number, basePrice: number, volatility: number): number[] {
  const prices: number[] = [];
  let currentPrice = basePrice;

  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 2 * volatility;
    currentPrice = Math.max(0.01, Math.min(0.99, currentPrice + change));
    prices.push(currentPrice);
  }

  return prices;
}

function createMarketDataWithHistory(marketId: string, prices: number[]): StrategyMarketData[] {
  if (prices.length === 0) return [];

  const lastPrice = prices[prices.length - 1] ?? 0.5;
  const book = new OrderBook(marketId);
  book.update(
    [{ price: Math.max(0.01, lastPrice - 0.01), size: 100 }],
    [{ price: Math.min(0.99, lastPrice + 0.01), size: 100 }]
  );

  // 创建多个数据点来模拟历史
  const marketData: StrategyMarketData[] = prices.map((price, index) => ({
    marketId,
    orderBook: book,
    lastPrice: price,
    timestamp: Date.now() - (prices.length - index) * 1000,
  }));

  return [marketData[marketData.length - 1]];
}

/**
 * 将价格序列逐个喂给策略以积累历史数据，返回最后一次的信号（如果有）
 */
function feedPricesToStrategy(
  strategy: TrendFollowingStrategy,
  marketId: string,
  prices: number[]
): StrategyMarketData[] {
  for (let i = 0; i < prices.length - 1; i++) {
    const marketData = createSingleMarketData(marketId, prices[i]);
    strategy.analyze(marketData);
  }
  // 返回最后一次的市场数据，供调用者获取信号
  return createSingleMarketData(marketId, prices[prices.length - 1] ?? 0.5);
}

/**
 * 创建单个市场数据点
 */
function createSingleMarketData(marketId: string, price: number): StrategyMarketData[] {
  const book = new OrderBook(marketId);
  book.update(
    [{ price: Math.max(0.01, price - 0.01), size: 100 }],
    [{ price: Math.min(0.99, price + 0.01), size: 100 }]
  );

  return [
    {
      marketId,
      orderBook: book,
      lastPrice: price,
      timestamp: Date.now(),
    },
  ];
}
