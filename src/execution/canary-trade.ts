import { randomUUID } from 'node:crypto';
import type { OrderRequest, OrderResponse } from '../api/polymarket-client.js';
import type { TradingClient } from '../api/trading-client.js';
import {
  CanaryTradePersistence,
  DEFAULT_CANARY_STATE_FILE_PATH,
  type CanaryTradePersistencePort,
  type CanaryTradeRecord,
  type CanaryTradeRecordStatus,
} from './canary-trade-persistence.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  handlePartialOrderFill,
  handleTimedOutOrder,
  isTradingStatusClient,
  pollOrderUntilTerminal,
} from './order-lifecycle.js';
import {
  CanaryKillSwitchPersistence,
  type CanaryKillSwitchState,
  type CanaryKillSwitchStatePort,
} from './canary-kill-switch.js';

export const CANARY_CONFIRMATION_PHRASE = 'PLACE_ONE_REAL_POLYMARKET_CANARY_ORDER';
export const CANARY_HARD_MAX_NOTIONAL_USD = 5;
export const DEFAULT_CANARY_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_CANARY_POLL_TIMEOUT_MS = 30_000;

export interface CanaryTradeConfig {
  tokenId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  maxNotionalUsd: number;
  dryRun: boolean;
  tradingEnabled: boolean;
  confirmation: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  stateFilePath: string;
}

export interface CanaryTradeResult {
  submitted: boolean;
  dryRun: boolean;
  notionalUsd: number;
  orderRequest: OrderRequest;
  order?: OrderResponse;
  record: CanaryTradeRecord;
  reason?: string;
}

type EnvRecord = Record<string, string | undefined>;
export type { CanaryTradePersistencePort, CanaryTradeRecord };

export interface CanaryTradeDependencies {
  persistence?: CanaryTradePersistencePort;
  killSwitch?: CanaryKillSwitchStatePort;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  createRunId?: (timestamp: number) => string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

const OPEN_CANARY_STATUSES = new Set<CanaryTradeRecordStatus>(['open', 'submitted']);

class CanaryKillSwitchActivatedError extends Error {
  constructor(readonly state: CanaryKillSwitchState) {
    super(`Canary kill switch is active: ${state.reason ?? 'manual stop'}`);
    this.name = 'CanaryKillSwitchActivatedError';
  }
}

export function parseCanaryTradeConfigFromEnv(env: EnvRecord = process.env): CanaryTradeConfig {
  const stateFilePath = env.CANARY_STATE_PATH?.trim();

  return {
    tokenId: requiredEnv(env, 'CANARY_TOKEN_ID'),
    side: parseSide(requiredEnv(env, 'CANARY_SIDE')),
    size: parsePositiveNumber(requiredEnv(env, 'CANARY_SIZE'), 'CANARY_SIZE'),
    price: parsePrice(requiredEnv(env, 'CANARY_PRICE')),
    maxNotionalUsd: parsePositiveNumber(
      env.CANARY_MAX_NOTIONAL_USD ?? String(CANARY_HARD_MAX_NOTIONAL_USD),
      'CANARY_MAX_NOTIONAL_USD'
    ),
    dryRun: parseBoolean(env.CANARY_DRY_RUN ?? 'true', 'CANARY_DRY_RUN'),
    tradingEnabled: parseBoolean(env.CANARY_TRADING_ENABLED ?? 'false', 'CANARY_TRADING_ENABLED'),
    confirmation: env.CANARY_CONFIRMATION ?? '',
    pollIntervalMs: parsePositiveNumber(
      env.CANARY_POLL_INTERVAL_MS ?? String(DEFAULT_CANARY_POLL_INTERVAL_MS),
      'CANARY_POLL_INTERVAL_MS'
    ),
    pollTimeoutMs: parsePositiveNumber(
      env.CANARY_POLL_TIMEOUT_MS ?? String(DEFAULT_CANARY_POLL_TIMEOUT_MS),
      'CANARY_POLL_TIMEOUT_MS'
    ),
    stateFilePath:
      stateFilePath && stateFilePath.length > 0 ? stateFilePath : DEFAULT_CANARY_STATE_FILE_PATH,
  };
}

export async function runCanaryTrade(
  config: CanaryTradeConfig,
  tradingClient?: TradingClient,
  dependencies: CanaryTradeDependencies = {}
): Promise<CanaryTradeResult> {
  validateCanaryConfig(config);

  const notionalUsd = calculateNotionalUsd(config);
  const now = dependencies.now ?? Date.now;
  const persistence = dependencies.persistence ?? new CanaryTradePersistence(config.stateFilePath);
  const killSwitch = dependencies.killSwitch ?? new CanaryKillSwitchPersistence();
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? config.pollIntervalMs;
  const pollTimeoutMs = dependencies.pollTimeoutMs ?? config.pollTimeoutMs;
  const runTimestamp = now();
  const runId =
    dependencies.createRunId?.(runTimestamp) ?? `canary-${String(runTimestamp)}-${randomUUID()}`;
  const orderRequest = createCanaryOrderRequest(config, runId);

  if (config.dryRun) {
    const record = createRecord({
      runId,
      requestedAt: now(),
      updatedAt: now(),
      config,
      notionalUsd,
      status: 'dry-run',
      submitted: false,
    });
    persistence.saveRecord(record);

    return {
      submitted: false,
      dryRun: true,
      notionalUsd,
      orderRequest,
      record,
      reason: 'dry-run',
    };
  }

  assertRealCanaryEnabled(config);
  const submittedAt = now();
  let record: CanaryTradeRecord | undefined;

  try {
    assertCanaryKillSwitchInactive(killSwitch);
    if (!tradingClient) {
      throw new Error('Trading client is required for real canary submission');
    }

    let order = await tradingClient.placeOrder(orderRequest);
    record = createRecord({
      runId,
      requestedAt: submittedAt,
      updatedAt: submittedAt,
      config,
      notionalUsd,
      status: toCanaryRecordStatus(order.status),
      submitted: true,
      orderId: order.id,
    });
    persistence.saveRecord(record);

    const updateRecord = (patch: Partial<CanaryTradeRecord>): CanaryTradeRecord => {
      if (!record) {
        throw new Error('Canary trade record is unavailable');
      }

      record = {
        ...record,
        ...patch,
      };
      persistence.saveRecord(record);
      return record;
    };

    if (order.status === 'open' && isTradingStatusClient(tradingClient)) {
      try {
        const polledOrder = await pollOrderUntilTerminal({
          tradingClient,
          orderId: order.id,
          pollIntervalMs,
          pollTimeoutMs,
          sleep,
          now,
          mapStatus: toCanaryRecordStatus,
          openStatuses: OPEN_CANARY_STATUSES,
          beforePoll: () => {
            assertCanaryKillSwitchInactive(killSwitch);
          },
          onUpdate: (statusOrder: OrderResponse, status: CanaryTradeRecordStatus) => {
            order = statusOrder;
            updateRecord({
              updatedAt: now(),
              status,
              orderId: statusOrder.id,
            });
          },
        });

        if (polledOrder) {
          order = polledOrder;
          updateRecord({
            updatedAt: now(),
            status: toCanaryRecordStatus(order.status),
          });
        } else {
          record = updateRecord({
            updatedAt: now(),
            status: 'timed_out',
            manualInterventionRequired: true,
            manualInterventionReason: 'Order remained open after the canary polling timeout',
          });

          const timedOutResult = await handleTimedOutCanaryOrder({
            tradingClient,
            order,
            record,
            persistence,
            now,
            sleep,
            pollIntervalMs,
            pollTimeoutMs,
          });
          order = timedOutResult.order ?? order;
          record = timedOutResult.record;
        }
      } catch (error) {
        if (!(error instanceof CanaryKillSwitchActivatedError)) {
          throw error;
        }

        record = updateRecord({
          updatedAt: now(),
          manualInterventionRequired: true,
          manualInterventionReason: error.message,
        });
        const stoppedResult = await handleKillSwitchActivatedCanaryOrder({
          tradingClient,
          order,
          record,
          persistence,
          now,
          sleep,
          pollIntervalMs,
          pollTimeoutMs,
          reason: error.message,
        });
        order = stoppedResult.order ?? order;
        record = stoppedResult.record;
      }
    }

    if (order.status === 'partial' && record.cancelAttempted !== true) {
      record = await handlePartialCanaryFill({
        tradingClient,
        order,
        record,
        persistence,
        now,
      });
    }

    return {
      submitted: true,
      dryRun: false,
      notionalUsd,
      orderRequest,
      order,
      record,
      ...(record.manualInterventionRequired ? { reason: 'manual-intervention-required' } : {}),
    };
  } catch (error) {
    const failedRecord =
      record ??
      createRecord({
        runId,
        requestedAt: submittedAt,
        updatedAt: now(),
        config,
        notionalUsd,
        status: 'failed',
        submitted: false,
      });

    persistence.saveRecord({
      ...failedRecord,
      updatedAt: now(),
      status: 'failed',
      lastError: getErrorMessage(error),
    });

    throw error;
  }
}

export function createCanaryOrderRequest(
  config: CanaryTradeConfig,
  idempotencyKey = `canary-dry-run-${config.tokenId}`
): OrderRequest {
  return {
    idempotencyKey,
    marketId: config.tokenId,
    side: config.side,
    size: config.size,
    price: config.price,
    orderType: 'limit',
    timeInForce: 'GTC',
  };
}

function validateCanaryConfig(config: CanaryTradeConfig): void {
  if (!/^\d+$/.test(config.tokenId)) {
    throw new Error('CANARY_TOKEN_ID must be a Polymarket CLOB token id');
  }
  if (!Number.isFinite(config.size) || config.size <= 0) {
    throw new Error('CANARY_SIZE must be greater than 0');
  }
  if (!Number.isFinite(config.price) || config.price <= 0 || config.price >= 1) {
    throw new Error('CANARY_PRICE must be between 0 and 1');
  }
  if (!Number.isFinite(config.maxNotionalUsd) || config.maxNotionalUsd <= 0) {
    throw new Error('CANARY_MAX_NOTIONAL_USD must be greater than 0');
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
    throw new Error('CANARY_POLL_INTERVAL_MS must be greater than 0');
  }
  if (!Number.isFinite(config.pollTimeoutMs) || config.pollTimeoutMs <= 0) {
    throw new Error('CANARY_POLL_TIMEOUT_MS must be greater than 0');
  }
  if (config.maxNotionalUsd > CANARY_HARD_MAX_NOTIONAL_USD) {
    throw new Error(
      `CANARY_MAX_NOTIONAL_USD cannot exceed ${String(CANARY_HARD_MAX_NOTIONAL_USD)}`
    );
  }

  const notionalUsd = calculateNotionalUsd(config);
  if (notionalUsd > config.maxNotionalUsd || notionalUsd > CANARY_HARD_MAX_NOTIONAL_USD) {
    throw new Error(
      `Canary order notional ${notionalUsd.toFixed(4)} exceeds max ${Math.min(
        config.maxNotionalUsd,
        CANARY_HARD_MAX_NOTIONAL_USD
      ).toFixed(4)}`
    );
  }
}

function assertRealCanaryEnabled(config: CanaryTradeConfig): void {
  if (!config.tradingEnabled) {
    throw new Error('CANARY_TRADING_ENABLED must be "true" for real canary submission');
  }
  if (config.confirmation !== CANARY_CONFIRMATION_PHRASE) {
    throw new Error(`CANARY_CONFIRMATION must equal ${CANARY_CONFIRMATION_PHRASE}`);
  }
}

function assertCanaryKillSwitchInactive(killSwitch: CanaryKillSwitchStatePort): void {
  const state = killSwitch.loadState();
  if (state.active) {
    throw new CanaryKillSwitchActivatedError(state);
  }
}

function calculateNotionalUsd(config: CanaryTradeConfig): number {
  return config.size * config.price;
}

function createRecord(params: {
  runId: string;
  requestedAt: number;
  updatedAt: number;
  config: CanaryTradeConfig;
  notionalUsd: number;
  status: CanaryTradeRecordStatus;
  submitted: boolean;
  orderId?: string;
}): CanaryTradeRecord {
  return {
    runId: params.runId,
    requestedAt: params.requestedAt,
    updatedAt: params.updatedAt,
    dryRun: params.config.dryRun,
    submitted: params.submitted,
    tokenId: params.config.tokenId,
    side: params.config.side,
    size: params.config.size,
    price: params.config.price,
    notionalUsd: params.notionalUsd,
    ...(params.orderId ? { orderId: params.orderId } : {}),
    status: params.status,
  };
}

function toCanaryRecordStatus(status: OrderResponse['status']): CanaryTradeRecordStatus {
  switch (status) {
    case 'partial':
      return 'partial';
    case 'filled':
      return 'filled';
    case 'cancelled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'open':
      return 'open';
    default:
      return 'submitted';
  }
}

async function handlePartialCanaryFill(params: {
  tradingClient: TradingClient;
  order: OrderResponse;
  record: CanaryTradeRecord;
  persistence: CanaryTradePersistencePort;
  now: () => number;
}): Promise<CanaryTradeRecord> {
  return handlePartialOrderFill<CanaryTradeRecord, CanaryTradeRecordStatus>({
    tradingClient: params.tradingClient,
    order: params.order,
    record: params.record,
    saveRecord: (record: CanaryTradeRecord) => {
      params.persistence.saveRecord(record);
    },
    now: params.now,
    partialStatus: 'partial',
    buildPartialInterventionReason: (order: OrderResponse) =>
      `Partial fill detected: ${String(order.filledSize)} filled, ${String(
        order.remainingSize
      )} remaining`,
  });
}

async function handleTimedOutCanaryOrder(params: {
  tradingClient: TradingClient;
  order: OrderResponse;
  record: CanaryTradeRecord;
  persistence: CanaryTradePersistencePort;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}): Promise<{ record: CanaryTradeRecord; order?: OrderResponse }> {
  return handleTimedOutOrder<CanaryTradeRecord, CanaryTradeRecordStatus>({
    tradingClient: params.tradingClient,
    order: params.order,
    record: params.record,
    saveRecord: (record: CanaryTradeRecord) => {
      params.persistence.saveRecord(record);
    },
    now: params.now,
    sleep: params.sleep,
    pollIntervalMs: params.pollIntervalMs,
    pollTimeoutMs: params.pollTimeoutMs,
    timedOutStatus: 'timed_out',
    mapStatus: toCanaryRecordStatus,
    openStatuses: OPEN_CANARY_STATUSES,
    shouldRequireManualIntervention: (status: CanaryTradeRecordStatus) =>
      status !== 'cancelled' && status !== 'rejected',
    buildTransitionPatch: (
      status: CanaryTradeRecordStatus,
      order: OrderResponse
    ): Partial<CanaryTradeRecord> => buildManualInterventionReason(status, order),
    cancelUnconfirmedReason:
      'Timed out order cancel was submitted but final cancellation status could not be confirmed',
    buildCancelFailureReason: (errorMessage: string) =>
      `Timed out order cancel failed: ${errorMessage}`,
  });
}

async function handleKillSwitchActivatedCanaryOrder(params: {
  tradingClient: TradingClient;
  order: OrderResponse;
  record: CanaryTradeRecord;
  persistence: CanaryTradePersistencePort;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  reason: string;
}): Promise<{ record: CanaryTradeRecord; order?: OrderResponse }> {
  return handleTimedOutOrder<CanaryTradeRecord, CanaryTradeRecordStatus>({
    tradingClient: params.tradingClient,
    order: params.order,
    record: params.record,
    saveRecord: (record: CanaryTradeRecord) => {
      params.persistence.saveRecord(record);
    },
    now: params.now,
    sleep: params.sleep,
    pollIntervalMs: params.pollIntervalMs,
    pollTimeoutMs: params.pollTimeoutMs,
    timedOutStatus: params.record.status,
    mapStatus: toCanaryRecordStatus,
    openStatuses: OPEN_CANARY_STATUSES,
    shouldRequireManualIntervention: (status: CanaryTradeRecordStatus) =>
      status !== 'cancelled' && status !== 'rejected',
    buildTransitionPatch: (
      status: CanaryTradeRecordStatus,
      order: OrderResponse
    ): Partial<CanaryTradeRecord> =>
      buildKillSwitchInterventionReason(params.reason, status, order),
    cancelUnconfirmedReason: `${params.reason}; cancellation could not be confirmed`,
    buildCancelFailureReason: (errorMessage: string) =>
      `${params.reason}; cancel failed: ${errorMessage}`,
  });
}

function buildKillSwitchInterventionReason(
  reason: string,
  status: CanaryTradeRecordStatus,
  order: OrderResponse
): Partial<Pick<CanaryTradeRecord, 'manualInterventionReason'>> {
  if (status === 'cancelled' || status === 'rejected') {
    return {};
  }

  return {
    manualInterventionReason: `${reason}; order transitioned to ${status} (${String(
      order.filledSize
    )} filled, ${String(order.remainingSize)} remaining)`,
  };
}

function buildManualInterventionReason(
  status: CanaryTradeRecordStatus,
  order: OrderResponse
): Partial<Pick<CanaryTradeRecord, 'manualInterventionReason'>> {
  switch (status) {
    case 'cancelled':
    case 'rejected':
      return {};
    case 'partial':
      return {
        manualInterventionReason: `Timed out order partially filled during cancel handling: ${String(
          order.filledSize
        )} filled, ${String(order.remainingSize)} remaining`,
      };
    case 'filled':
      return {
        manualInterventionReason: 'Timed out order filled before cancellation could be confirmed',
      };
    default:
      return {
        manualInterventionReason: `Timed out order transitioned to ${status} during cancel handling`,
      };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(env: EnvRecord, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseSide(value: string): 'buy' | 'sell' {
  if (value === 'buy' || value === 'sell') {
    return value;
  }
  throw new Error('CANARY_SIDE must be "buy" or "sell"');
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parsePrice(value: string): number {
  const parsed = parsePositiveNumber(value, 'CANARY_PRICE');
  if (parsed >= 1) {
    throw new Error('CANARY_PRICE must be between 0 and 1');
  }
  return parsed;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be "true" or "false"`);
}
