import type { OrderResponse } from '../api/polymarket-client.js';
import type { TradingStatusClient } from '../api/trading-client.js';
import type { CanaryTradeRecord } from './canary-trade-persistence.js';
import { getErrorMessage } from '../utils/errors.js';

export type CanaryCancelableOrderRecord = CanaryTradeRecord;

export interface CancelAllCanaryDependencies {
  saveRecord?: (record: CanaryCancelableOrderRecord) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  confirmPollIntervalMs?: number;
  confirmPollTimeoutMs?: number;
}

export interface CancelAllCanaryResult {
  cancelled: CanaryCancelableOrderRecord[];
  failed: { orderId: string; reason: string }[];
  skipped: { orderId?: string; reason: string }[];
}

const TERMINAL_STATUSES = new Set<CanaryTradeRecord['status']>([
  'dry-run',
  'filled',
  'cancelled',
  'rejected',
  'failed',
]);

export async function cancelAllCanaryOrders(
  records: CanaryCancelableOrderRecord[],
  tradingClient: TradingStatusClient,
  dependencies: CancelAllCanaryDependencies = {}
): Promise<CancelAllCanaryResult> {
  const saveRecord = dependencies.saveRecord ?? noopSaveRecord;
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.now ?? Date.now;
  const confirmPollIntervalMs = dependencies.confirmPollIntervalMs ?? 2_000;
  const confirmPollTimeoutMs = dependencies.confirmPollTimeoutMs ?? 30_000;

  const cancelled: CanaryCancelableOrderRecord[] = [];
  const failed: { orderId: string; reason: string }[] = [];
  const skipped: { orderId?: string; reason: string }[] = [];

  for (const record of records) {
    if (!record.orderId) {
      skipped.push({ reason: 'missing-order-id' });
      continue;
    }

    if (TERMINAL_STATUSES.has(record.status)) {
      skipped.push({
        orderId: record.orderId,
        reason: `terminal-status:${record.status}`,
      });
      continue;
    }

    try {
      await tradingClient.cancelOrder(record.orderId);

      let nextRecord: CanaryCancelableOrderRecord = {
        ...record,
        updatedAt: now(),
        cancelAttempted: true,
        cancelSucceeded: true,
      };

      const confirmedOrder = await pollForCancellationConfirmation(
        tradingClient,
        record.orderId,
        confirmPollIntervalMs,
        confirmPollTimeoutMs,
        sleep,
        now
      );

      if (confirmedOrder) {
        nextRecord = {
          ...nextRecord,
          updatedAt: now(),
          status: mapOrderStatusToRecordStatus(confirmedOrder),
          cancelConfirmed: true,
        };
      } else {
        nextRecord = {
          ...nextRecord,
          updatedAt: now(),
          cancelConfirmed: false,
          manualInterventionRequired: true,
          manualInterventionReason:
            'Cancel-all submitted a cancellation but final status could not be confirmed',
        };
      }

      saveRecord(nextRecord);
      cancelled.push(nextRecord);
    } catch (error) {
      const message = getErrorMessage(error);
      const failedRecord: CanaryCancelableOrderRecord = {
        ...record,
        updatedAt: now(),
        cancelAttempted: true,
        cancelSucceeded: false,
        cancelConfirmed: false,
        cancelError: message,
        manualInterventionRequired: true,
        manualInterventionReason: `Cancel-all failed: ${message}`,
      };
      saveRecord(failedRecord);
      failed.push({ orderId: record.orderId, reason: message });
    }
  }

  return {
    cancelled,
    failed,
    skipped,
  };
}

async function pollForCancellationConfirmation(
  tradingClient: TradingStatusClient,
  orderId: string,
  pollIntervalMs: number,
  pollTimeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<OrderResponse | undefined> {
  const deadline = now() + pollTimeoutMs;

  while (now() <= deadline) {
    await sleep(pollIntervalMs);
    const order = await tradingClient.getOrder(orderId);
    if (order.status !== 'open' && order.status !== 'partial') {
      return order;
    }
  }

  return undefined;
}

function mapOrderStatusToRecordStatus(order: OrderResponse): CanaryTradeRecord['status'] {
  switch (order.status) {
    case 'cancelled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'filled':
      return 'filled';
    case 'partial':
      return 'partial';
    case 'open':
    default:
      return 'open';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noopSaveRecord(_record: CanaryCancelableOrderRecord): void {
  // Intentionally empty when the caller does not want persistence side effects.
}
