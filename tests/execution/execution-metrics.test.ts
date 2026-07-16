/**
 * Tests for execution-metrics helpers.
 */

import { jest } from '@jest/globals';

// Mocks
const mockObserveExecLatency = jest.fn();
const mockObserveExecutionLatency = jest.fn();
const mockRecordTrade = jest.fn();
const mockArbitrageExecuted = jest.fn();
const mockArbitrageFailed = jest.fn();
const mockSendAlert = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.unstable_mockModule('../../src/utils/metrics.js', () => ({
  TradingMetrics: {
    orderExecutionLatency: { observe: mockObserveExecLatency },
    arbitrageExecutionLatency: { observe: mockObserveExecutionLatency },
    arbitrageExecuted: { inc: mockArbitrageExecuted },
    arbitrageFailed: { inc: mockArbitrageFailed },
  },
  recordTrade: mockRecordTrade,
}));

jest.unstable_mockModule('../../src/alerts/index.js', () => ({
  sendAlert: mockSendAlert,
}));

const {
  recordOrderMetrics,
  recordArbitrageMetrics,
  alertPartialFills,
  legsToOrders,
  detectPartialFills,
} = await import('../../src/execution/execution-metrics.js');

import type {
  TradeOrder,
  OrderStatus,
  ExecutionResult,
  TradeLeg,
} from '../../src/execution/types.js';

describe('recordOrderMetrics', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should call recordTrade and observe latency', () => {
    const order: TradeOrder = {
      id: 'o1',
      marketId: 'mkt-1',
      side: 'buy',
      size: 100,
      price: 0.5,
      orderType: 'limit',
    };
    const status: OrderStatus = {
      orderId: 'o1',
      status: 'filled',
      filledSize: 100,
      remainingSize: 0,
      avgPrice: 0.51,
      timestamp: Date.now(),
    };

    recordOrderMetrics(order, status, 42);

    expect(mockRecordTrade).toHaveBeenCalledWith('mkt-1', 'buy', 100, 0.51, 42, true);
    expect(mockObserveExecLatency).toHaveBeenCalledWith({ market_id: 'mkt-1' }, 42);
  });

  it('should pass success=false when status is error', () => {
    const order: TradeOrder = {
      id: 'o2',
      marketId: 'mkt-2',
      side: 'sell',
      size: 50,
      price: 0.3,
      orderType: 'market',
    };
    const status: OrderStatus = {
      orderId: 'o2',
      status: 'error',
      filledSize: 0,
      remainingSize: 50,
      avgPrice: 0,
      timestamp: Date.now(),
    };

    recordOrderMetrics(order, status, 10);

    expect(mockRecordTrade).toHaveBeenCalledWith('mkt-2', 'sell', 0, 0, 10, false);
  });
});

describe('recordArbitrageMetrics', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should observe detection latency and record execution without fabricating profit', () => {
    const result: ExecutionResult = {
      success: true,
      orders: [],
      totalFilled: 200,
      totalCost: 100,
      errors: [],
      executionTime: 50,
    };

    recordArbitrageMetrics('arb-1', result, 15);

    expect(mockObserveExecutionLatency).toHaveBeenCalledWith({}, 15);
    expect(mockArbitrageExecuted).toHaveBeenCalledWith({ type: 'multi-leg' });
    expect(mockArbitrageFailed).not.toHaveBeenCalled();
  });

  it('should record profit=0 on failure', () => {
    const result: ExecutionResult = {
      success: false,
      orders: [],
      totalFilled: 0,
      totalCost: 0,
      errors: ['timeout'],
      executionTime: 100,
    };

    recordArbitrageMetrics('arb-2', result, 25);

    expect(mockObserveExecutionLatency).toHaveBeenCalledWith({}, 25);
    expect(mockArbitrageFailed).toHaveBeenCalledWith({ type: 'multi-leg' });
  });
});

describe('alertPartialFills', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should send critical alert with metadata', async () => {
    await alertPartialFills({
      arbitrageId: 'arb-99',
      partialFills: [{ orderId: 'o1', filled: 50, remaining: 50 }],
      totalFilled: 50,
    });

    expect(mockSendAlert).toHaveBeenCalledWith(
      'critical',
      'Arbitrage Partial Fill - Manual Intervention Required',
      expect.stringContaining('arb-99'),
      expect.objectContaining({
        arbitrageId: 'arb-99',
        totalFilled: 50,
      })
    );
  });
});

describe('legsToOrders', () => {
  it('should map TradeLeg[] to TradeOrder[]', () => {
    const legs: TradeLeg[] = [
      { marketId: 'mkt-1', side: 'buy', size: 100, expectedPrice: 0.5 },
      { marketId: 'mkt-2', side: 'sell', size: 200, expectedPrice: 0.6 },
    ];

    const orders = legsToOrders(legs, 'arb-1');

    expect(orders).toHaveLength(2);
    expect(orders[0]).toEqual({
      id: 'arb-1-0',
      marketId: 'mkt-1',
      side: 'buy',
      size: 100,
      price: 0.5,
      orderType: 'market',
      timeInForce: 'FOK',
    });
    expect(orders[1]!.id).toBe('arb-1-1');
  });

  it('should return empty array for empty legs', () => {
    expect(legsToOrders([], 'arb-0')).toEqual([]);
  });
});

describe('detectPartialFills', () => {
  it('should detect orders with status partial', () => {
    const result: ExecutionResult = {
      success: true,
      orders: [
        {
          orderId: 'o1',
          status: 'partial',
          filledSize: 50,
          remainingSize: 50,
          avgPrice: 0.5,
          timestamp: 1,
        },
        {
          orderId: 'o2',
          status: 'filled',
          filledSize: 100,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: 1,
        },
      ],
      totalFilled: 150,
      totalCost: 75,
      errors: [],
      executionTime: 10,
    };
    const orders: TradeOrder[] = [
      { id: 'o1', marketId: 'm1', side: 'buy', size: 100, price: 0.5, orderType: 'limit' },
      { id: 'o2', marketId: 'm2', side: 'sell', size: 100, price: 0.5, orderType: 'limit' },
    ];

    const partials = detectPartialFills(result, orders);

    expect(partials).toHaveLength(1);
    expect(partials[0]!.orderId).toBe('o1');
  });

  it('should detect filled orders with filledSize < expectedSize', () => {
    const result: ExecutionResult = {
      success: true,
      orders: [
        {
          orderId: 'o1',
          status: 'filled',
          filledSize: 80,
          remainingSize: 20,
          avgPrice: 0.5,
          timestamp: 1,
        },
      ],
      totalFilled: 80,
      totalCost: 40,
      errors: [],
      executionTime: 10,
    };
    const orders: TradeOrder[] = [
      { id: 'o1', marketId: 'm1', side: 'buy', size: 100, price: 0.5, orderType: 'limit' },
    ];

    const partials = detectPartialFills(result, orders);

    expect(partials).toHaveLength(1);
    expect(partials[0]!.filled).toBe(80);
    expect(partials[0]!.remaining).toBe(20);
  });

  it('should return empty array when no partial fills', () => {
    const result: ExecutionResult = {
      success: true,
      orders: [
        {
          orderId: 'o1',
          status: 'filled',
          filledSize: 100,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: 1,
        },
      ],
      totalFilled: 100,
      totalCost: 50,
      errors: [],
      executionTime: 10,
    };
    const orders: TradeOrder[] = [
      { id: 'o1', marketId: 'm1', side: 'buy', size: 100, price: 0.5, orderType: 'limit' },
    ];

    expect(detectPartialFills(result, orders)).toEqual([]);
  });
});
