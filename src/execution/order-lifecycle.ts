import type { OrderResponse } from '../api/polymarket-client.js';
import type { TradingClient, TradingStatusClient } from '../api/trading-client.js';
import { getErrorMessage } from '../utils/errors.js';

export interface ManagedOrderRecord<TStatus extends string> {
  updatedAt: number;
  status: TStatus;
  cancelAttempted?: boolean;
  cancelSucceeded?: boolean;
  cancelConfirmed?: boolean;
  cancelError?: string;
  manualInterventionRequired?: boolean;
  manualInterventionReason?: string;
}

export interface PollOrderUntilTerminalParams<TStatus extends string> {
  tradingClient: TradingStatusClient;
  orderId: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  mapStatus: (status: OrderResponse['status']) => TStatus;
  openStatuses: ReadonlySet<TStatus>;
  beforePoll?: () => void;
  onUpdate?: (order: OrderResponse, status: TStatus) => void;
}

export interface HandlePartialOrderFillParams<
  TRecord extends ManagedOrderRecord<TStatus>,
  TStatus extends string,
> {
  tradingClient: TradingClient;
  order: OrderResponse;
  record: TRecord;
  saveRecord: (record: TRecord) => void;
  now: () => number;
  partialStatus: TStatus;
  buildPartialInterventionReason: (order: OrderResponse) => string;
}

export interface HandleTimedOutOrderParams<
  TRecord extends ManagedOrderRecord<TStatus>,
  TStatus extends string,
> {
  tradingClient: TradingClient;
  order: OrderResponse;
  record: TRecord;
  saveRecord: (record: TRecord) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  timedOutStatus: TStatus;
  mapStatus: (status: OrderResponse['status']) => TStatus;
  openStatuses: ReadonlySet<TStatus>;
  shouldRequireManualIntervention: (status: TStatus, order: OrderResponse) => boolean;
  buildTransitionPatch: (status: TStatus, order: OrderResponse) => Partial<TRecord>;
  cancelUnconfirmedReason: string;
  buildCancelFailureReason: (errorMessage: string) => string;
}

export function isTradingStatusClient(client: TradingClient): client is TradingStatusClient {
  return 'getOrder' in client && typeof client.getOrder === 'function';
}

export async function pollOrderUntilTerminal<TStatus extends string>(
  params: PollOrderUntilTerminalParams<TStatus>
): Promise<OrderResponse | undefined> {
  const deadline = params.now() + params.pollTimeoutMs;

  while (params.now() <= deadline) {
    params.beforePoll?.();
    await params.sleep(params.pollIntervalMs);
    params.beforePoll?.();
    const order = await params.tradingClient.getOrder(params.orderId);
    const status = params.mapStatus(order.status);
    params.onUpdate?.(order, status);

    if (!params.openStatuses.has(status)) {
      return order;
    }
  }

  return undefined;
}

export async function handlePartialOrderFill<
  TRecord extends ManagedOrderRecord<TStatus>,
  TStatus extends string,
>(params: HandlePartialOrderFillParams<TRecord, TStatus>): Promise<TRecord> {
  const baseRecord = {
    ...params.record,
    updatedAt: params.now(),
    status: params.partialStatus,
    manualInterventionRequired: true,
    manualInterventionReason: params.buildPartialInterventionReason(params.order),
  } satisfies TRecord;

  try {
    await params.tradingClient.cancelOrder(params.order.id);
    const cancelledRecord = {
      ...baseRecord,
      updatedAt: params.now(),
      cancelAttempted: true,
      cancelSucceeded: true,
    } satisfies TRecord;
    params.saveRecord(cancelledRecord);
    return cancelledRecord;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const failedCancelRecord = {
      ...baseRecord,
      updatedAt: params.now(),
      cancelAttempted: true,
      cancelSucceeded: false,
      cancelError: errorMessage,
      manualInterventionReason: `${params.buildPartialInterventionReason(params.order)}; cancel failed: ${errorMessage}`,
    } satisfies TRecord;
    params.saveRecord(failedCancelRecord);
    return failedCancelRecord;
  }
}

export async function handleTimedOutOrder<
  TRecord extends ManagedOrderRecord<TStatus>,
  TStatus extends string,
>(
  params: HandleTimedOutOrderParams<TRecord, TStatus>
): Promise<{ record: TRecord; order?: OrderResponse }> {
  try {
    await params.tradingClient.cancelOrder(params.order.id);

    const cancelRequestedRecord = {
      ...params.record,
      updatedAt: params.now(),
      cancelAttempted: true,
      cancelSucceeded: true,
    } satisfies TRecord;
    params.saveRecord(cancelRequestedRecord);

    if (isTradingStatusClient(params.tradingClient)) {
      const confirmedOrder = await pollOrderUntilTerminal({
        tradingClient: params.tradingClient,
        orderId: params.order.id,
        pollIntervalMs: params.pollIntervalMs,
        pollTimeoutMs: params.pollTimeoutMs,
        sleep: params.sleep,
        now: params.now,
        mapStatus: params.mapStatus,
        openStatuses: params.openStatuses,
      });

      if (confirmedOrder) {
        const confirmedStatus = params.mapStatus(confirmedOrder.status);
        const confirmedRecord = {
          ...cancelRequestedRecord,
          updatedAt: params.now(),
          status: confirmedStatus,
          cancelConfirmed: true,
          manualInterventionRequired: params.shouldRequireManualIntervention(
            confirmedStatus,
            confirmedOrder
          ),
          ...params.buildTransitionPatch(confirmedStatus, confirmedOrder),
        } satisfies TRecord;
        params.saveRecord(confirmedRecord);

        return {
          record: confirmedRecord,
          order: confirmedOrder,
        };
      }
    }

    const unconfirmedRecord = {
      ...cancelRequestedRecord,
      updatedAt: params.now(),
      cancelConfirmed: false,
      manualInterventionRequired: true,
      manualInterventionReason: params.cancelUnconfirmedReason,
    } satisfies TRecord;
    params.saveRecord(unconfirmedRecord);
    return { record: unconfirmedRecord };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const failedCancelRecord = {
      ...params.record,
      updatedAt: params.now(),
      status: params.timedOutStatus,
      cancelAttempted: true,
      cancelSucceeded: false,
      cancelConfirmed: false,
      cancelError: errorMessage,
      manualInterventionRequired: true,
      manualInterventionReason: params.buildCancelFailureReason(errorMessage),
    } satisfies TRecord;
    params.saveRecord(failedCancelRecord);
    return { record: failedCancelRecord };
  }
}
