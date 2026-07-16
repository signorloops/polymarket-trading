import { jest } from '@jest/globals';
import type { OrderResponse } from '../../src/api/polymarket-client.js';
import type { TradingClient } from '../../src/api/trading-client.js';
import {
  handlePartialOrderFill,
  handleTimedOutOrder,
  pollOrderUntilTerminal,
  type ManagedOrderRecord,
} from '../../src/execution/order-lifecycle.js';

type LifecycleStatus = 'submitted' | 'open' | 'partial' | 'filled' | 'cancelled' | 'timed_out';

interface LifecycleRecord extends ManagedOrderRecord<LifecycleStatus> {
  id: string;
}

function makeOrder(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    id: 'order-1',
    marketId: 'token-1',
    side: 'buy',
    size: 2,
    price: 0.4,
    status: 'open',
    filledSize: 0,
    remainingSize: 2,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<LifecycleRecord> = {}): LifecycleRecord {
  return {
    id: 'record-1',
    updatedAt: 1_000,
    status: 'open',
    ...overrides,
  };
}

function createStatusClient(
  orders: OrderResponse[],
  cancelError?: Error
): TradingClient & { getOrder: jest.Mock } {
  return {
    placeOrder: jest.fn(),
    getOrder: jest.fn().mockImplementation(async () => {
      const next = orders.shift();
      return next ?? makeOrder({ status: 'open' });
    }),
    cancelOrder: cancelError
      ? jest.fn().mockRejectedValue(cancelError)
      : jest.fn().mockResolvedValue(undefined),
  };
}

describe('pollOrderUntilTerminal', () => {
  it('polls until the order reaches a non-open terminal state', async () => {
    const client = createStatusClient([
      makeOrder({ status: 'open', updatedAt: '2026-04-26T00:00:01.000Z' }),
      makeOrder({
        status: 'filled',
        filledSize: 2,
        remainingSize: 0,
        updatedAt: '2026-04-26T00:00:02.000Z',
      }),
    ]);
    const updates: LifecycleStatus[] = [];

    const result = await pollOrderUntilTerminal({
      tradingClient: client,
      orderId: 'order-1',
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
      sleep: async () => {},
      now: (() => {
        let current = 1_000;
        return () => {
          current += 1_000;
          return current;
        };
      })(),
      mapStatus: (status) => (status === 'filled' ? 'filled' : 'open'),
      openStatuses: new Set<LifecycleStatus>(['open', 'submitted']),
      onUpdate: (_order, status) => {
        updates.push(status);
      },
    });

    expect(client.getOrder).toHaveBeenCalledTimes(2);
    expect(result?.status).toBe('filled');
    expect(updates).toEqual(['open', 'filled']);
  });
});

describe('handlePartialOrderFill', () => {
  it('cancels the remainder and marks manual intervention on partial fill', async () => {
    const client = createStatusClient([]);
    const saved: LifecycleRecord[] = [];

    const result = await handlePartialOrderFill({
      tradingClient: client,
      order: makeOrder({ status: 'partial', filledSize: 0.5, remainingSize: 1.5 }),
      record: makeRecord(),
      saveRecord: (record) => {
        saved.push(record);
      },
      now: () => 2_000,
      partialStatus: 'partial',
      buildPartialInterventionReason: (order) =>
        `partial fill: ${String(order.filledSize)} filled, ${String(order.remainingSize)} remaining`,
    });

    expect(client.cancelOrder).toHaveBeenCalledWith('order-1');
    expect(result).toEqual(
      expect.objectContaining({
        updatedAt: 2_000,
        status: 'partial',
        cancelAttempted: true,
        cancelSucceeded: true,
        manualInterventionRequired: true,
      })
    );
    expect(saved).toHaveLength(1);
  });
});

describe('handleTimedOutOrder', () => {
  it('confirms cancellation and clears manual intervention when the order becomes cancelled', async () => {
    const client = createStatusClient([
      makeOrder({ status: 'cancelled', updatedAt: '2026-04-26T00:00:02.000Z' }),
    ]);
    const saved: LifecycleRecord[] = [];

    const result = await handleTimedOutOrder({
      tradingClient: client,
      order: makeOrder(),
      record: makeRecord({
        status: 'timed_out',
        manualInterventionRequired: true,
      }),
      saveRecord: (record) => {
        saved.push(record);
      },
      now: (() => {
        let current = 1_000;
        return () => {
          current += 1;
          return current;
        };
      })(),
      sleep: async () => {},
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
      timedOutStatus: 'timed_out',
      mapStatus: (status) => (status === 'cancelled' ? 'cancelled' : 'open'),
      openStatuses: new Set<LifecycleStatus>(['open', 'submitted']),
      shouldRequireManualIntervention: (status) => status !== 'cancelled',
      buildTransitionPatch: () => ({}),
      cancelUnconfirmedReason: 'cancel requested but not confirmed',
      buildCancelFailureReason: (message) => `cancel failed: ${message}`,
    });

    expect(client.cancelOrder).toHaveBeenCalledWith('order-1');
    expect(client.getOrder).toHaveBeenCalledWith('order-1');
    expect(result.record).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        cancelAttempted: true,
        cancelSucceeded: true,
        cancelConfirmed: true,
        manualInterventionRequired: false,
      })
    );
    expect(saved.at(-1)).toEqual(result.record);
  });

  it('marks manual intervention when timeout cancellation fails', async () => {
    const client = createStatusClient([], new Error('cancel timeout'));
    const saved: LifecycleRecord[] = [];

    const result = await handleTimedOutOrder({
      tradingClient: client,
      order: makeOrder(),
      record: makeRecord({
        status: 'timed_out',
        manualInterventionRequired: true,
      }),
      saveRecord: (record) => {
        saved.push(record);
      },
      now: () => 5_000,
      sleep: async () => {},
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
      timedOutStatus: 'timed_out',
      mapStatus: () => 'open',
      openStatuses: new Set<LifecycleStatus>(['open', 'submitted']),
      buildTransitionPatch: () => ({}),
      cancelUnconfirmedReason: 'cancel requested but not confirmed',
      buildCancelFailureReason: (message) => `cancel failed: ${message}`,
    });

    expect(result.record).toEqual(
      expect.objectContaining({
        status: 'timed_out',
        cancelAttempted: true,
        cancelSucceeded: false,
        cancelConfirmed: false,
        cancelError: 'cancel timeout',
        manualInterventionRequired: true,
        manualInterventionReason: 'cancel failed: cancel timeout',
      })
    );
    expect(saved.at(-1)).toEqual(result.record);
  });
});
