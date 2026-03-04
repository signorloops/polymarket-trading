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
}

export type DataPipelineEvent =
  | { type: 'trade'; data: MarketData }
  | { type: 'orderbook'; data: OrderBookUpdate }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'error'; error: Error };

type EventHandler = (event: DataPipelineEvent) => void;

export class DataPipeline {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private handlers: Set<EventHandler> = new Set();
  private logger = getLogger().child({ module: 'DataPipeline' });
  private isManualClose = false;

  constructor(url: string = NETWORK_CONFIG.WS_URL) {
    this.url = url;
  }

  /**
   * Connect to the WebSocket
   */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.logger.warn('Already connected');
      return;
    }

    this.isManualClose = false;
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
  disconnect(): void {
    this.isManualClose = true;
    this.clearTimers();

    if (this.ws) {
      this.logger.info('Disconnecting from WebSocket');
      this.ws.close();
      this.ws = null;
    }
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

  private setupEventHandlers(): void {
    if (!this.ws) return;
    const currentWs = this.ws;

    currentWs.on('open', () => {
      if (this.ws && this.ws !== currentWs) {
        return;
      }
      this.logger.info('WebSocket connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emit({ type: 'connected' });
      this.subscribeToMarkets();
    });

    currentWs.on('message', (wsData: WebSocket.Data) => {
      if (this.ws && this.ws !== currentWs) {
        return;
      }
      const startTime = performance.now();
      try {
        const dataStr = this.webSocketDataToString(wsData);
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
      if (this.ws && this.ws !== currentWs) {
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
      if (this.ws && this.ws !== currentWs) {
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
    if (!this.isValidMessage(message)) {
      this.logger.warn('Invalid message received', { message });
      return;
    }

    const msg = message;

    switch (msg.event_type) {
      case 'trade':
        this.handleTradeMessage(msg);
        break;
      case 'orderbook':
      case 'book':
        this.handleOrderBookMessage(msg);
        break;
      case 'price_change':
        this.handlePriceChangeMessage(msg);
        break;
      default:
        // Unknown message type, ignore
        break;
    }
  }

  private isValidMessage(msg: unknown): msg is { event_type: string } & Record<string, unknown> {
    return typeof msg === 'object' && msg !== null && 'event_type' in msg && typeof (msg as Record<string, unknown>).event_type === 'string';
  }

  private handleTradeMessage(msg: Record<string, unknown>): void {
    const rawMarketId = msg.market_id;
    const rawEventId = msg.event_id;
    const marketId = typeof rawMarketId === 'string' || typeof rawMarketId === 'number' ? String(rawMarketId) : '';
    const eventId = typeof rawEventId === 'string' || typeof rawEventId === 'number' ? String(rawEventId) : '';
    const data: MarketData = {
      marketId,
      eventId,
      price: Number(msg.price ?? 0),
      size: Number(msg.size ?? 0),
      side: msg.side === 'buy' ? 'buy' : 'sell',
      timestamp: Number(msg.timestamp ?? Date.now()),
    };

    if (data.marketId) {
      this.emit({ type: 'trade', data });
    }
  }

  private handleOrderBookMessage(msg: Record<string, unknown>): void {
    const processStartTime = performance.now();

    const bids = Array.isArray(msg.bids)
      ? msg.bids.map((b: unknown) => ({
          price: Number((b as Record<string, unknown>).price ?? 0),
          size: Number((b as Record<string, unknown>).size ?? 0),
        }))
      : [];

    const asks = Array.isArray(msg.asks)
      ? msg.asks.map((a: unknown) => ({
          price: Number((a as Record<string, unknown>).price ?? 0),
          size: Number((a as Record<string, unknown>).size ?? 0),
        }))
      : [];

    const rawMarketId = msg.market_id;
    const marketId = typeof rawMarketId === 'string' || typeof rawMarketId === 'number' ? String(rawMarketId) : '';
    const data: OrderBookUpdate = {
      marketId,
      bids,
      asks,
      timestamp: Number(msg.timestamp ?? Date.now()),
    };

    if (data.marketId) {
      this.emit({ type: 'orderbook', data });

      // Record order book update metrics
      const processingTime = performance.now() - processStartTime;
      TradingMetrics.orderBookUpdateLatency.observe({ market_id: marketId }, processingTime);
      TradingMetrics.orderBookUpdates.inc({ market_id: marketId });
    }
  }

  private handlePriceChangeMessage(msg: Record<string, unknown>): void {
    // Convert price change to trade-like event for processing
    const rawMarketId = msg.market_id;
    const rawEventId = msg.event_id;
    const marketId = typeof rawMarketId === 'string' || typeof rawMarketId === 'number' ? String(rawMarketId) : '';
    const eventId = typeof rawEventId === 'string' || typeof rawEventId === 'number' ? String(rawEventId) : '';
    const data: MarketData = {
      marketId,
      eventId,
      price: Number(msg.price ?? 0),
      size: 0,
      side: 'buy',
      timestamp: Number(msg.timestamp ?? Date.now()),
    };

    if (data.marketId) {
      this.emit({ type: 'trade', data });
    }
  }

  private subscribeToMarkets(): void {
    // Subscribe to all market data channels
    const subscriptions = [
      { type: 'subscribe', channel: 'trades' },
      { type: 'subscribe', channel: 'orderbook' },
      { type: 'subscribe', channel: 'price_change' },
    ];

    for (const sub of subscriptions) {
      this.send(sub);
    }
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

  private scheduleReconnect(): void {
    if (this.isManualClose) {
      return;
    }

    if (this.reconnectAttempts >= NETWORK_CONFIG.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error('Max reconnection attempts reached');
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

    // Send ping every 30 seconds to keep connection alive
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
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
export function resetDataPipeline(): void {
  if (pipelineCreated) {
    pipelineSingleton.get().disconnect();
    pipelineCreated = false;
  }
  pipelineSingleton.reset();
}
