import { jest } from '@jest/globals';
import {
  cancelAllCanaryOrders,
  type CanaryCancelableOrderRecord,
} from '../../src/execution/canary-cancel-all.js';
import type { TradingStatusClient } from '../../src/api/trading-client.js';

describe('cancelAllCanaryOrders', () => {
  function makeRecord(
    overrides: Partial<CanaryCancelableOrderRecord> = {}
  ): CanaryCancelableOrderRecord {
    return {
      runId: 'canary-1',
      orderId: '0xorder',
      status: 'open',
      updatedAt: 1_000,
      submitted: true,
      dryRun: false,
      tokenId: '1234567890',
      side: 'buy',
      size: 1,
      price: 0.01,
      notionalUsd: 0.01,
      requestedAt: 1_000,
      ...overrides,
    };
  }

  it('returns an empty no-op result without touching the trading client when there are no records', async () => {
    const saveRecord = jest.fn();
    const client = {
      cancelOrder: jest.fn(),
      getOrder: jest.fn(),
    } as unknown as TradingStatusClient;

    const result = await cancelAllCanaryOrders([], client, {
      saveRecord,
    });

    expect(result).toEqual({
      cancelled: [],
      failed: [],
      skipped: [],
    });
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(client.getOrder).not.toHaveBeenCalled();
    expect(saveRecord).not.toHaveBeenCalled();
  });

  it('cancels only non-terminal canary orders and confirms terminal status when possible', async () => {
    const records = [
      makeRecord({ runId: 'canary-open', orderId: '0xopen', status: 'open' }),
      makeRecord({ runId: 'canary-partial', orderId: '0xpartial', status: 'partial' }),
      makeRecord({ runId: 'canary-filled', orderId: '0xfilled', status: 'filled' }),
    ];
    const saveRecord = jest.fn();
    const client = {
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      getOrder: jest
        .fn()
        .mockResolvedValueOnce({
          id: '0xopen',
          marketId: '1234567890',
          side: 'buy',
          size: 1,
          price: 0.01,
          status: 'cancelled',
          filledSize: 0,
          remainingSize: 1,
          createdAt: '2026-04-24T00:00:00.000Z',
          updatedAt: '2026-04-24T00:00:01.000Z',
        })
        .mockResolvedValueOnce({
          id: '0xpartial',
          marketId: '1234567890',
          side: 'buy',
          size: 1,
          price: 0.01,
          status: 'cancelled',
          filledSize: 0.4,
          remainingSize: 0.6,
          createdAt: '2026-04-24T00:00:00.000Z',
          updatedAt: '2026-04-24T00:00:01.000Z',
        }),
    } as TradingStatusClient;

    const result = await cancelAllCanaryOrders(records, client, {
      saveRecord,
      sleep: async () => {},
      now: (() => {
        let current = 2_000;
        return () => ++current;
      })(),
      confirmPollIntervalMs: 1,
      confirmPollTimeoutMs: 10,
    });

    expect(client.cancelOrder).toHaveBeenCalledTimes(2);
    expect(client.cancelOrder).toHaveBeenNthCalledWith(1, '0xopen');
    expect(client.cancelOrder).toHaveBeenNthCalledWith(2, '0xpartial');
    expect(result.cancelled).toHaveLength(2);
    expect(result.skipped).toEqual([{ orderId: '0xfilled', reason: 'terminal-status:filled' }]);
    expect(saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: '0xopen',
        status: 'cancelled',
        cancelAttempted: true,
        cancelSucceeded: true,
        cancelConfirmed: true,
      })
    );
  });

  it('records a failure when cancel-all cannot cancel an open order', async () => {
    const saveRecord = jest.fn();
    const client = {
      cancelOrder: jest.fn().mockRejectedValue(new Error('network down')),
      getOrder: jest.fn(),
    } as unknown as TradingStatusClient;

    const result = await cancelAllCanaryOrders([makeRecord()], client, {
      saveRecord,
      now: () => 2_000,
    });

    expect(result.failed).toEqual([{ orderId: '0xorder', reason: 'network down' }]);
    expect(saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: '0xorder',
        cancelAttempted: true,
        cancelSucceeded: false,
        cancelError: 'network down',
      })
    );
  });
});
