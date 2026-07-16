import WebSocket from 'ws';

import { NETWORK_CONFIG } from '../utils/config.js';
import { getErrorMessage } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

const DEFAULT_USER_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const CONDITION_ID_REGEX = /^0x[a-fA-F0-9]{64}$/;
const TOKEN_ID_REGEX = /^\d+$/;

export interface UserWebSocketCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface UserOrderUpdate {
  orderId: string;
  conditionId: string;
  tokenId: string;
  side: 'buy' | 'sell';
  lifecycle: 'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
  status: string;
  originalSize: number;
  matchedSize: number;
  price: number;
  observedAt: number;
}

export interface UserTradeUpdate {
  tradeId: string;
  conditionId: string;
  tokenId: string;
  side: 'buy' | 'sell';
  lifecycle: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';
  size: number;
  price: number;
  transactionHash?: string;
  relatedOrderIds: string[];
  observedAt: number;
}

export type UserWebSocketEvent =
  | { type: 'order'; data: UserOrderUpdate }
  | { type: 'trade'; data: UserTradeUpdate };

export interface PolymarketUserWebSocketOptions {
  url?: string;
  conditionIds?: readonly string[];
  connectionTimeoutMs?: number;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  heartbeatIntervalMs?: number;
  heartbeatDeadThresholdMs?: number;
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
}

type UserEventHandler = (event: UserWebSocketEvent) => void;

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function getUserWebSocketCredentialsFromEnv(): UserWebSocketCredentials {
  const credentials = {
    apiKey: NETWORK_CONFIG.POLYMARKET_API_KEY ?? '',
    secret: NETWORK_CONFIG.POLYMARKET_SECRET ?? '',
    passphrase: NETWORK_CONFIG.POLYMARKET_PASSPHRASE ?? '',
  };
  assertCredentials(credentials);
  return credentials;
}

export function createPolymarketUserWebSocketFromEnv(
  options: PolymarketUserWebSocketOptions = {}
): PolymarketUserWebSocketClient {
  return new PolymarketUserWebSocketClient(getUserWebSocketCredentialsFromEnv(), options);
}

/** Authenticated CLOB user channel for private order and trade lifecycle updates. */
export class PolymarketUserWebSocketClient {
  private readonly logger = getLogger().child({ module: 'PolymarketUserWebSocket' });
  private readonly url: string;
  private readonly conditionIds: string[];
  private readonly connectionTimeoutMs: number;
  private readonly reconnectIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatDeadThresholdMs: number;
  private readonly webSocketFactory: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  private readonly handlers = new Set<UserEventHandler>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly lastOrderUpdates = new Map<string, UserOrderUpdate>();
  private ws: WebSocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private generation = 0;
  private manualClose = false;
  private receivedPong = false;
  private lastPongAt = 0;
  private openedAt = 0;

  constructor(
    private readonly credentials: UserWebSocketCredentials,
    options: PolymarketUserWebSocketOptions = {}
  ) {
    assertCredentials(credentials);
    this.url = options.url ?? DEFAULT_USER_WS_URL;
    this.conditionIds = [...new Set(options.conditionIds ?? [])];
    for (const conditionId of this.conditionIds) {
      if (!CONDITION_ID_REGEX.test(conditionId)) {
        throw new Error(`Invalid user-channel condition id: ${conditionId}`);
      }
    }
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? NETWORK_CONFIG.CONNECTION_TIMEOUT;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? NETWORK_CONFIG.RECONNECT_INTERVAL;
    this.maxReconnectAttempts =
      options.maxReconnectAttempts ?? NETWORK_CONFIG.MAX_RECONNECT_ATTEMPTS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.heartbeatDeadThresholdMs = options.heartbeatDeadThresholdMs ?? 30_000;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
    if (
      this.heartbeatIntervalMs < 1000 ||
      this.heartbeatDeadThresholdMs < this.heartbeatIntervalMs * 2
    ) {
      throw new Error(
        'User-channel heartbeat threshold must cover at least two heartbeat intervals'
      );
    }
  }

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.manualClose = false;
    const generation = ++this.generation;
    this.receivedPong = false;
    this.lastPongAt = 0;
    this.openedAt = 0;
    this.logger.info('Connecting to authenticated Polymarket user channel', { url: this.url });
    try {
      const ws = this.webSocketFactory(this.url, { handshakeTimeout: this.connectionTimeoutMs });
      this.ws = ws;
      this.setupEventHandlers(ws, generation);
    } catch (error) {
      this.logger.error('Failed to create authenticated user WebSocket', {
        error: getErrorMessage(error),
      });
      this.scheduleReconnect(generation);
    }
  }

  disconnect(): void {
    this.manualClose = true;
    this.generation++;
    this.clearTimers();
    this.rejectReadyWaiters(new Error('Authenticated user WebSocket disconnected'));
    const ws = this.ws;
    this.ws = undefined;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    this.receivedPong = false;
    this.lastPongAt = 0;
    this.openedAt = 0;
  }

  subscribe(handler: UserEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isReady(now = Date.now()): boolean {
    return (
      this.isConnected() &&
      this.receivedPong &&
      now >= this.lastPongAt &&
      now - this.lastPongAt <= this.heartbeatDeadThresholdMs
    );
  }

  waitUntilReady(timeoutMs = this.connectionTimeoutMs): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('User-channel readiness timeout must be positive'));
    }
    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.readyWaiters.delete(waiter);
          reject(new Error('Timed out waiting for authenticated user-channel PONG'));
        }, timeoutMs),
      };
      this.readyWaiters.add(waiter);
    });
  }

  getLastOrderUpdate(orderId: string): UserOrderUpdate | undefined {
    return this.lastOrderUpdates.get(orderId);
  }

  waitForOrderUpdate(
    orderId: string,
    predicate: (update: UserOrderUpdate) => boolean,
    timeoutMs = this.connectionTimeoutMs
  ): Promise<UserOrderUpdate> {
    if (orderId.trim() === '') return Promise.reject(new Error('order id is required'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('order update timeout must be positive'));
    }
    const existing = this.lastOrderUpdates.get(orderId);
    if (existing && predicate(existing)) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe((event) => {
        if (event.type !== 'order' || event.data.orderId !== orderId || !predicate(event.data)) {
          return;
        }
        clearTimeout(timer);
        unsubscribe();
        resolve(event.data);
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for user-channel update for order ${orderId}`));
      }, timeoutMs);
    });
  }

  private setupEventHandlers(ws: WebSocket, generation: number): void {
    ws.on('open', () => {
      if (!this.isCurrent(ws, generation)) return;
      this.reconnectAttempts = 0;
      this.openedAt = Date.now();
      this.logger.info('Authenticated user WebSocket connected');
      this.sendSubscription(ws);
      this.sendPing(ws);
      this.startHeartbeat(ws, generation);
    });

    ws.on('message', (data: WebSocket.Data) => {
      if (!this.isCurrent(ws, generation)) return;
      const text = webSocketDataToString(data);
      if (text === 'PONG') {
        this.receivedPong = true;
        this.lastPongAt = Date.now();
        this.resolveReadyWaiters();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.logger.warn('Ignored non-JSON authenticated user-channel message');
        return;
      }
      if (isServerError(parsed)) {
        this.logger.error('Authenticated user-channel subscription was rejected');
        this.rejectReadyWaiters(new Error('Authenticated user-channel subscription rejected'));
        ws.terminate();
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) this.handleUserMessage(message);
    });

    ws.on('close', (code: number) => {
      if (!this.isCurrent(ws, generation)) return;
      this.ws = undefined;
      this.clearHeartbeat();
      this.receivedPong = false;
      this.logger.warn('Authenticated user WebSocket closed', { code });
      if (!this.manualClose) this.scheduleReconnect(generation);
    });

    ws.on('error', (error: Error) => {
      if (!this.isCurrent(ws, generation)) return;
      this.logger.error('Authenticated user WebSocket error', { error: error.message });
    });

    ws.on('ping', (data: Buffer) => {
      if (this.isCurrent(ws, generation) && ws.readyState === WebSocket.OPEN) ws.pong(data);
    });
  }

  private sendSubscription(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        auth: {
          apiKey: this.credentials.apiKey,
          secret: this.credentials.secret,
          passphrase: this.credentials.passphrase,
        },
        ...(this.conditionIds.length > 0 ? { markets: this.conditionIds } : {}),
        type: 'user',
      })
    );
  }

  private startHeartbeat(ws: WebSocket, generation: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isCurrent(ws, generation) || ws.readyState !== WebSocket.OPEN) return;
      const lastHealthyAt = this.lastPongAt || this.openedAt;
      if (lastHealthyAt > 0 && Date.now() - lastHealthyAt > this.heartbeatDeadThresholdMs) {
        this.logger.error('Authenticated user WebSocket heartbeat became stale');
        ws.terminate();
        return;
      }
      this.sendPing(ws);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private sendPing(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) ws.send('PING');
  }

  private handleUserMessage(value: unknown): void {
    try {
      const event = parseUserEvent(value);
      if (!event) {
        this.logger.warn('Ignored unknown authenticated user-channel event');
        return;
      }
      if (event.type === 'order') this.lastOrderUpdates.set(event.data.orderId, event.data);
      for (const handler of this.handlers) handler(event);
    } catch (error) {
      this.logger.warn('Ignored malformed authenticated user-channel event', {
        error: getErrorMessage(error),
      });
    }
  }

  private scheduleReconnect(generation: number): void {
    if (this.manualClose || generation !== this.generation || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Authenticated user WebSocket exhausted reconnect attempts');
      this.rejectReadyWaiters(new Error('Authenticated user WebSocket reconnect limit reached'));
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectIntervalMs * Math.min(2 ** (this.reconnectAttempts - 1), 16);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.manualClose && generation === this.generation) this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private isCurrent(ws: WebSocket, generation: number): boolean {
    return this.ws === ws && this.generation === generation;
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.readyWaiters.clear();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

function assertCredentials(credentials: UserWebSocketCredentials): void {
  const fields: [keyof UserWebSocketCredentials, string][] = [
    ['apiKey', credentials.apiKey],
    ['secret', credentials.secret],
    ['passphrase', credentials.passphrase],
  ];
  const missing = fields.filter(([, value]) => value.trim() === '').map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Authenticated user WebSocket is missing ${missing.join(', ')}`);
  }
}

function parseUserEvent(value: unknown): UserWebSocketEvent | undefined {
  const record = asRecord(value, 'user event');
  if (record.event_type === 'order') return { type: 'order', data: parseOrderUpdate(record) };
  if (record.event_type === 'trade') return { type: 'trade', data: parseTradeUpdate(record) };
  return undefined;
}

function parseOrderUpdate(record: Record<string, unknown>): UserOrderUpdate {
  const lifecycle = requiredString(record.type, 'order type');
  if (lifecycle !== 'PLACEMENT' && lifecycle !== 'UPDATE' && lifecycle !== 'CANCELLATION') {
    throw new Error('unsupported order lifecycle');
  }
  return {
    orderId: requiredString(record.id, 'order id'),
    conditionId: conditionId(record.market),
    tokenId: tokenId(record.asset_id),
    side: side(record.side),
    lifecycle,
    status: requiredString(record.status, 'order status'),
    originalSize: nonNegativeNumber(record.original_size, 'original order size'),
    matchedSize: nonNegativeNumber(record.size_matched, 'matched order size'),
    price: price(record.price),
    observedAt: timestamp(record.timestamp),
  };
}

function parseTradeUpdate(record: Record<string, unknown>): UserTradeUpdate {
  const lifecycle = requiredString(record.status, 'trade status');
  if (
    lifecycle !== 'MATCHED' &&
    lifecycle !== 'MINED' &&
    lifecycle !== 'CONFIRMED' &&
    lifecycle !== 'RETRYING' &&
    lifecycle !== 'FAILED'
  ) {
    throw new Error('unsupported trade lifecycle');
  }
  const relatedOrderIds = new Set<string>();
  const takerOrderId = optionalString(record.taker_order_id);
  if (takerOrderId) relatedOrderIds.add(takerOrderId);
  if (Array.isArray(record.maker_orders)) {
    for (const value of record.maker_orders) {
      const maker = asRecord(value, 'maker order');
      const id = optionalString(maker.order_id);
      if (id) relatedOrderIds.add(id);
    }
  }
  const transactionHash = optionalString(record.transaction_hash);
  return {
    tradeId: requiredString(record.id, 'trade id'),
    conditionId: conditionId(record.market),
    tokenId: tokenId(record.asset_id),
    side: side(record.side),
    lifecycle,
    size: nonNegativeNumber(record.size, 'trade size'),
    price: price(record.price),
    ...(transactionHash ? { transactionHash } : {}),
    relatedOrderIds: [...relatedOrderIds],
    observedAt: timestamp(record.timestamp ?? record.last_update),
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function conditionId(value: unknown): string {
  const result = requiredString(value, 'condition id');
  if (!CONDITION_ID_REGEX.test(result)) throw new Error('condition id is invalid');
  return result;
}

function tokenId(value: unknown): string {
  const result = requiredString(value, 'token id');
  if (!TOKEN_ID_REGEX.test(result)) throw new Error('token id is invalid');
  return result;
}

function side(value: unknown): 'buy' | 'sell' {
  const result = requiredString(value, 'side').toLowerCase();
  if (result !== 'buy' && result !== 'sell') throw new Error('side is invalid');
  return result;
}

function nonNegativeNumber(value: unknown, field: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${field} is invalid`);
  return result;
}

function price(value: unknown): number {
  const result = nonNegativeNumber(value, 'price');
  if (result <= 0 || result >= 1) throw new Error('price is outside the binary contract range');
  return result;
}

function timestamp(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error('timestamp is invalid');
}

function isServerError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.error === 'string' || record.event_type === 'error';
}

function webSocketDataToString(data: WebSocket.Data): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}
