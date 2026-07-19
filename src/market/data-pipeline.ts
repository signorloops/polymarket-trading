/**
 * WebSocket Data Pipeline for Polymarket
 *
 * Handles real-time market data ingestion via WebSocket connection.
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Message parsing and event dispatching
 * - Connection state management
 * - Heartbeat/ping-pong handling
 */

import WebSocket from 'ws';
import { getLogger } from '../utils/logger.js';
import { NETWORK_CONFIG } from '../utils/config.js';
import { TradingMetrics } from '../utils/metrics.js';
import { getErrorMessage } from '../utils/errors.js';
import { createSingleton } from '../utils/singleton.js';

export interface MarketData {
  marketId: string;
  eventId: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

export interface OrderBookUpdate {
  marketId: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  timestamp: number;
  kind: 'snapshot' | 'delta';
}

export type DataPipelineEvent =
  | { type: 'trade'; data: MarketData }
  | { type: 'orderbook'; data: OrderBookUpdate }
  | { type: 'tick-size'; marketId: string; tickSize: number; timestamp: number }
  | { type: 'market-resolved'; marketId: string; timestamp: number }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'reconnect_exhausted'; attempts: number }
  | { type: 'error'; error: Error };

type EventHandler = (event: DataPipelineEvent) => void;

export class DataPipeline {
  private ws: WebSocket | null = null;
  private url: string;
  private assetIds: string[];
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private handlers: Set<EventHandler> = new Set();
  private logger = getLogger().child({ module: 'DataPipeline' });
  private isManualClose = false;
  private reconnectExhausted = false;

  constructor(url: string = NETWORK_CONFIG.WS_URL, assetIds: string[] = []) {
    this.url = url;
    this.assetIds = [...assetIds];
  }

  /**
   * Connect to the WebSocket
   */
  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.logger.warn('Already connected');
      return;
    }

    this.isManualClose = false;
    this.reconnectExhausted = false;
    this.logger.info('Connecting to WebSocket', { url: this.url });

    try {
      this.ws = new WebSocket(this.url, {
        handshakeTimeout: NETWORK_CONFIG.CONNECTION_TIMEOUT,
      });

      this.setupEventHandlers();
    } catch (error) {
      this.logger.error('Failed to create WebSocket', {
        error: getErrorMessage(error),
      });
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the WebSocket
   */
  async disconnect(): Promise<void> {
    this.isManualClose = true;
    this.clearTimers();

    const currentWs = this.ws;
    this.ws = null;
    if (!currentWs || currentWs.readyState === WebSocket.CLOSED) {
      return;
    }

    this.logger.info('Disconnecting from WebSocket');
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forceCloseTimer);
        resolve();
      };
      const forceCloseTimer = setTimeout(() => {
        if (
          currentWs.readyState !== WebSocket.CLOSED &&
          typeof currentWs.terminate === 'function'
        ) {
          currentWs.terminate();
        }
        finish();
      }, 2_000);
      forceCloseTimer.unref();

      if (typeof currentWs.once === 'function') {
        currentWs.once('close', finish);
      } else {
        // Minimal WebSocket-compatible transports may close synchronously.
        finish();
      }
      if (currentWs.readyState === WebSocket.CLOSING) {
        return;
      }
      currentWs.close();
    });
  }

  /**
   * Subscribe to market data events
   */
  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isReconnectExhausted(): boolean {
    return this.reconnectExhausted;
  }

  resetReconnect(): void {
    this.reconnectExhausted = false;
    this.reconnectAttempts = 0;
    if (!this.isManualClose && !this.isConnected()) {
      this.connect();
    }
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;
    const currentWs = this.ws;

    currentWs.on('open', () => {
      if (this.ws !== currentWs) {
        return;
      }
      this.logger.info('WebSocket connected');
      this.reconnectAttempts = 0;
      this.reconnectExhausted = false;
      this.lastPongAt = Date.now();
      this.startHeartbeat();
      this.emit({ type: 'connected' });
      this.subscribeToMarkets();
    });

    currentWs.on('message', (wsData: WebSocket.Data) => {
      if (this.ws !== currentWs) {
        return;
      }
      const startTime = performance.now();
      try {
        const dataStr = this.webSocketDataToString(wsData);
        if (dataStr.trim().toUpperCase() === 'PONG') {
          this.lastPongAt = Date.now();
          return;
        }
        const message: unknown = JSON.parse(dataStr);
        this.handleMessage(message);

        // Record message processing time
        const processingTime = performance.now() - startTime;
        TradingMetrics.wsMessageProcessingTime.observe({}, processingTime);
      } catch (error) {
        const dataPreview = (() => {
          try {
            return this.webSocketDataToString(wsData).slice(0, 200);
          } catch {
            return '[unreadable websocket payload]';
          }
        })();
        this.logger.error('Failed to parse message', {
          error: getErrorMessage(error),
          data: dataPreview,
        });
        TradingMetrics.websocketErrors.inc();
      }
    });

    currentWs.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== currentWs) {
        return;
      }
      this.ws = null;
      this.logger.info('WebSocket closed', {
        code,
        reason: reason.toString(),
      });
      this.clearTimers();
      this.emit({ type: 'disconnected' });

      if (!this.isManualClose) {
        TradingMetrics.websocketReconnects.inc();
        this.scheduleReconnect();
      }
    });

    currentWs.on('error', (error: Error) => {
      if (this.ws !== currentWs) {
        return;
      }
      this.logger.error('WebSocket error', { error: error.message });
      this.emit({ type: 'error', error });
    });

    currentWs.on('ping', (data: Buffer) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong(data);
      }
    });
  }

  private handleMessage(message: unknown): void {
    if (Array.isArray(message)) {
      for (const entry of message) this.handleMessage(entry);
      return;
    }
    if (!this.isValidMessage(message)) {
      this.logger.warn('Invalid message received', { message });
      return;
    }

    const msg = message;

    switch (msg.event_type) {
      case 'trade':
      case 'last_trade_price':
        this.handleTradeMessage(msg);
        break;
      case 'orderbook':
      case 'book':
        this.handleOrderBookMessage(msg);
        break;
      case 'price_change':
        this.handlePriceChangeMessage(msg);
        break;
      case 'tick_size_change':
        this.handleTickSizeChangeMessage(msg);
        break;
      case 'market_resolved':
        this.handleMarketResolvedMessage(msg);
        break;
      default:
        // Unknown message type, ignore
        break;
    }
  }

  private isValidMessage(msg: unknown): msg is { event_type: string } & Record<string, unknown> {
    return (
      typeof msg === 'object' &&
      msg !== null &&
      'event_type' in msg &&
      typeof (msg as Record<string, unknown>).event_type === 'string'
    );
  }

  private handleTradeMessage(msg: Record<string, unknown>): void {
    const marketId = this.readStringIdentifier(msg.asset_id ?? msg.market_id);
    const eventId = this.readStringIdentifier(msg.market ?? msg.event_id);

    if (!this.isValidPrice(msg.price)) {
      this.logger.warn('Dropping trade message with invalid price', {
        marketId,
        rawPrice: msg.price,
      });
      return;
    }

    const data: MarketData = {
      marketId,
      eventId,
      price: Number(msg.price),
      size: this.isValidSize(msg.size) ? Number(msg.size) : 0,
      side: this.normalizeSide(msg.side),
      timestamp: this.readTimestamp(msg.timestamp),
    };

    if (data.marketId) {
      this.emit({ type: 'trade', data });
    }
  }

  private handleOrderBookMessage(msg: Record<string, unknown>): void {
    const processStartTime = performance.now();

    // Missing bids/asks means an incomplete frame — not an explicit empty book (MKT-5).
    if (!Array.isArray(msg.bids) || !Array.isArray(msg.asks)) {
      this.logger.warn('Ignoring book snapshot missing bids or asks arrays');
      return;
    }

    const toLevels = (arr: unknown): { price: number; size: number }[] => {
      if (!Array.isArray(arr)) return [];
      const levels: { price: number; size: number }[] = [];
      for (const entry of arr) {
        const record = (entry ?? {}) as Record<string, unknown>;
        if (!this.isValidPrice(record.price) || !this.isValidSize(record.size)) {
          continue;
        }
        levels.push({ price: Number(record.price), size: Number(record.size) });
      }
      return levels;
    };

    const bids = toLevels(msg.bids);
    const asks = toLevels(msg.asks);

    const marketId = this.readStringIdentifier(msg.asset_id ?? msg.market_id);
    const data: OrderBookUpdate = {
      marketId,
      bids,
      asks,
      timestamp: this.readTimestamp(msg.timestamp),
      kind: 'snapshot',
    };

    if (data.marketId) {
      this.emit({ type: 'orderbook', data });

      // Record order book update metrics
      const processingTime = performance.now() - processStartTime;
      // Aggregate without market_id — token ids are unbounded cardinality (INFRA-6).
      TradingMetrics.orderBookUpdateLatency.observe({}, processingTime);
      TradingMetrics.orderBookUpdates.inc({});
    }
  }

  private handlePriceChangeMessage(msg: Record<string, unknown>): void {
    const timestamp = this.readTimestamp(msg.timestamp);
    const rawChanges = msg.price_changes;

    if (Array.isArray(rawChanges)) {
      for (const change of rawChanges) {
        const entry = (change ?? {}) as Record<string, unknown>;
        const marketId = this.readStringIdentifier(entry.asset_id ?? entry.market_id);
        if (!marketId) {
          continue;
        }

        const side = this.normalizeSide(entry.side);
        if (!this.isValidPrice(entry.price) || !this.isValidSize(entry.size)) {
          continue;
        }
        const level = {
          price: Number(entry.price),
          size: Number(entry.size),
        };

        this.emit({
          type: 'orderbook',
          data: {
            marketId,
            bids: side === 'buy' ? [level] : [],
            asks: side === 'sell' ? [level] : [],
            timestamp,
            kind: 'delta',
          },
        });
      }
      return;
    }

    const marketId = this.readStringIdentifier(msg.asset_id ?? msg.market_id);
    const eventId = this.readStringIdentifier(msg.market ?? msg.event_id);

    if (!this.isValidPrice(msg.price)) {
      this.logger.warn('Dropping price-change message with invalid price', {
        marketId,
        rawPrice: msg.price,
      });
      return;
    }

    const data: MarketData = {
      marketId,
      eventId,
      price: Number(msg.price),
      size: 0,
      side: msg.side === undefined ? 'buy' : this.normalizeSide(msg.side),
      timestamp,
    };

    if (marketId) {
      this.emit({ type: 'trade', data });
    }
  }

  private handleTickSizeChangeMessage(msg: Record<string, unknown>): void {
    const marketId = this.readStringIdentifier(msg.asset_id ?? msg.market_id);
    const tickSize = Number(msg.new_tick_size ?? msg.tick_size);
    if (!marketId || !Number.isFinite(tickSize) || tickSize <= 0 || tickSize >= 1) {
      this.logger.warn('Dropping invalid tick-size-change message', { marketId });
      return;
    }
    this.emit({
      type: 'tick-size',
      marketId,
      tickSize,
      timestamp: this.readTimestamp(msg.timestamp),
    });
  }

  private handleMarketResolvedMessage(msg: Record<string, unknown>): void {
    const marketId = this.readStringIdentifier(
      msg.asset_id ?? msg.market_id ?? msg.winning_asset_id ?? msg.market
    );
    if (!marketId) return;
    this.emit({
      type: 'market-resolved',
      marketId,
      timestamp: this.readTimestamp(msg.timestamp),
    });
  }

  private subscribeToMarkets(): void {
    if (this.assetIds.length === 0) {
      this.logger.warn('No asset ids configured for market subscription');
      return;
    }

    this.send({
      assets_ids: this.assetIds,
      type: 'market',
      custom_feature_enabled: true,
    });
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private webSocketDataToString(data: WebSocket.Data): string {
    if (typeof data === 'string') {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data.toString();
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString();
    }
    return Buffer.from(data).toString();
  }

  private emit(event: DataPipelineEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error('Error in event handler', {
          error: getErrorMessage(error),
        });
      }
    }
  }

  private readStringIdentifier(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    return '';
  }

  private normalizeSide(side: unknown): 'buy' | 'sell' {
    return typeof side === 'string' && side.toLowerCase() === 'buy' ? 'buy' : 'sell';
  }

  private readTimestamp(value: unknown): number {
    const timestamp = Number(value ?? Date.now());
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  }

  /**
   * Validate a price from an untrusted WebSocket message. Outcome-token prices are
   * open-interval (0, 1), matching OrderBook (MKT-4). Reject NaN/Infinity/edges/
   * missing values so a malformed message cannot poison detection.
   */
  private isValidPrice(value: unknown): boolean {
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) && num > 0 && num < 1;
  }

  private isValidSize(value: unknown): boolean {
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) && num >= 0;
  }

  private scheduleReconnect(): void {
    if (this.isManualClose) {
      return;
    }

    if (this.reconnectAttempts >= NETWORK_CONFIG.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectExhausted = true;
      this.logger.error('Max reconnection attempts reached');
      this.emit({
        type: 'reconnect_exhausted',
        attempts: this.reconnectAttempts,
      });
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      NETWORK_CONFIG.RECONNECT_INTERVAL * Math.pow(2, this.reconnectAttempts - 1),
      60000 // Max 60 seconds
    );

    this.logger.info(`Scheduling reconnect in ${String(delay)}ms`, {
      attempt: this.reconnectAttempts,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isManualClose) {
        return;
      }
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Polymarket market/user channels require an application-level PING every
    // 10 seconds and answer with the literal PONG message.
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        if (Date.now() - this.lastPongAt > 25000) {
          this.logger.error('WebSocket heartbeat timed out; reconnecting');
          if (typeof this.ws.terminate === 'function') {
            this.ws.terminate();
          } else {
            this.ws.close();
          }
          return;
        }
        this.ws.send('PING');
      }
    }, 10000);
    this.heartbeatTimer.unref();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

/**
 * Create a singleton data pipeline instance
 */
const pipelineSingleton = createSingleton(() => new DataPipeline());
let pipelineCreated = false;

export function getDataPipeline(): DataPipeline {
  pipelineCreated = true;
  return pipelineSingleton.get();
}

/**
 * Reset the global pipeline (for testing)
 * Disconnects the WebSocket before clearing the instance.
 */
export async function resetDataPipeline(): Promise<void> {
  if (pipelineCreated) {
    await pipelineSingleton.get().disconnect();
    pipelineCreated = false;
  }
  pipelineSingleton.reset();
}
