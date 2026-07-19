/**
 * Polymarket WebSocket Client
 *
 * Real-time market data streaming
 */

import WebSocket from 'ws';
import { getLogger } from '../utils/logger.js';
import { NETWORK_CONFIG } from '../utils/config.js';
import { getErrorMessage } from '../utils/errors.js';
import { createSingleton } from '../utils/singleton.js';

export interface WsTrade {
  marketId: string;
  price: string;
  size: string;
  side: 'buy' | 'sell';
  timestamp: string;
}

export interface WsOrderBookUpdate {
  marketId: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  timestamp: string;
  /** Official `book` messages replace state; `price_change` messages are deltas. */
  kind?: 'snapshot' | 'delta';
}

export type WsMessage =
  | { type: 'trade'; data: WsTrade }
  | { type: 'orderbook'; data: WsOrderBookUpdate }
  | { type: 'price'; data: { marketId: string; price: string; timestamp: string } }
  | { type: 'reconnect_exhausted'; attempts: number };

type WsHandler = (message: WsMessage) => void;

export class PolymarketWebSocketClient {
  private static readonly HEARTBEAT_INTERVAL_MS = 10000;
  // If no pong arrives within this window (>= 2 missed heartbeats), the socket is
  // considered half-open/dead and terminated so reconnect logic can take over.
  private static readonly HEARTBEAT_DEAD_THRESHOLD_MS = 30000;

  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Set<WsHandler> = new Set();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isManualClose = false;
  private subscribedMarkets: Set<string> = new Set();
  private lastPongAt = 0;
  private reconnectExhausted = false;
  private logger = getLogger().child({ module: 'PolymarketWebSocket' });

  constructor(url?: string, _apiKey?: string) {
    this.url = url ?? NETWORK_CONFIG.WS_URL;
  }

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.logger.warn('WebSocket already connected');
      return;
    }

    this.isManualClose = false;
    this.reconnectExhausted = false;
    this.logger.info('Connecting to Polymarket WebSocket', { url: this.url });

    try {
      // The market channel is public. Trading credentials belong only in the
      // authenticated user-channel subscription body and must never be sent here.
      this.ws = new WebSocket(this.url, {
        handshakeTimeout: NETWORK_CONFIG.CONNECTION_TIMEOUT,
      });

      this.setupEventHandlers();
    } catch (error) {
      this.logger.error('Failed to create WebSocket', { error });
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.isManualClose = true;
    this.clearTimers();

    if (this.ws) {
      this.logger.info('Disconnecting WebSocket');
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(handler: WsHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeToMarket(marketId: string): void {
    this.subscribedMarkets.add(marketId);
    this.send({
      assets_ids: [marketId],
      operation: 'subscribe',
      custom_feature_enabled: true,
    });
  }

  unsubscribeFromMarket(marketId: string): void {
    this.subscribedMarkets.delete(marketId);
    this.send({
      assets_ids: [marketId],
      operation: 'unsubscribe',
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** True after reconnect attempts are exhausted until resetReconnect()/connect(). */
  isReconnectExhausted(): boolean {
    return this.reconnectExhausted;
  }

  /**
   * Clear the exhausted state and allow a fresh reconnect sequence (API-1).
   * Call after operator intervention or orchestration restart.
   */
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
      if (this.ws && this.ws !== currentWs) {
        return;
      }
      this.logger.info('WebSocket connected');
      this.reconnectAttempts = 0;
      this.reconnectExhausted = false;
      this.lastPongAt = Date.now();
      this.startHeartbeat();

      // The first market-channel subscription has a different shape from a
      // dynamic subscribe operation.
      if (this.subscribedMarkets.size > 0) {
        this.send({
          assets_ids: [...this.subscribedMarkets],
          type: 'market',
          custom_feature_enabled: true,
        });
      }
    });

    currentWs.on('message', (data: WebSocket.Data) => {
      if (this.ws && this.ws !== currentWs) {
        return;
      }
      try {
        const dataStr = this.webSocketDataToString(data);
        if (dataStr === 'PONG') {
          this.lastPongAt = Date.now();
          return;
        }
        const message: unknown = JSON.parse(dataStr);
        if (Array.isArray(message)) {
          for (const item of message) this.handleMessage(item);
        } else {
          this.handleMessage(message);
        }
      } catch (error) {
        const dataStr = this.webSocketDataToString(data);
        this.logger.error('Failed to parse message', {
          error: getErrorMessage(error),
          data: dataStr,
        });
      }
    });

    currentWs.on('close', (code: number, reason: Buffer) => {
      if (this.ws && this.ws !== currentWs) {
        return;
      }
      this.ws = null;
      this.logger.info('WebSocket closed', { code, reason: reason.toString() });
      this.clearTimers();

      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    });

    currentWs.on('error', (error: Error) => {
      if (this.ws && this.ws !== currentWs) {
        return;
      }
      this.logger.error('WebSocket error', { error: error.message });
    });

    currentWs.on('ping', (data: Buffer) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong(data);
      }
    });

    // Track our own pings' pongs so the heartbeat can detect a half-open socket.
    currentWs.on('pong', () => {
      this.lastPongAt = Date.now();
    });
  }

  private handleMessage(message: unknown): void {
    if (this.handleOfficialMarketMessage(message)) {
      return;
    }
    if (!this.isValidMessage(message)) {
      this.logger.warn('Invalid message received', { message: JSON.stringify(message) });
      return;
    }

    const msg = message;

    switch (msg.type) {
      case 'trade':
        this.emit({ type: 'trade', data: msg.data as WsTrade });
        break;
      case 'orderbook':
        this.emit({ type: 'orderbook', data: msg.data as WsOrderBookUpdate });
        break;
      case 'price':
        this.emit({
          type: 'price',
          data: msg.data as { marketId: string; price: string; timestamp: string },
        });
        break;
      default:
        this.logger.debug('Unknown message type', { type: msg.type });
    }
  }

  private handleOfficialMarketMessage(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const value = message as Record<string, unknown>;
    const eventType = value.event_type;
    if (typeof eventType !== 'string') return false;
    const timestamp = typeof value.timestamp === 'string' ? value.timestamp : String(Date.now());

    if (eventType === 'book') {
      const marketId = value.asset_id;
      if (typeof marketId !== 'string') return true;
      const bids = parseOfficialLevels(value.bids);
      const asks = parseOfficialLevels(value.asks);
      if (!bids || !asks) return true;
      this.emit({
        type: 'orderbook',
        data: { marketId, bids, asks, timestamp, kind: 'snapshot' },
      });
      return true;
    }

    if (eventType === 'price_change' && Array.isArray(value.price_changes)) {
      for (const rawChange of value.price_changes) {
        if (!rawChange || typeof rawChange !== 'object') continue;
        const change = rawChange as Record<string, unknown>;
        if (
          typeof change.asset_id !== 'string' ||
          typeof change.price !== 'string' ||
          typeof change.size !== 'string' ||
          (change.side !== 'BUY' && change.side !== 'SELL')
        ) {
          continue;
        }
        const level = { price: change.price, size: change.size };
        this.emit({
          type: 'orderbook',
          data: {
            marketId: change.asset_id,
            bids: change.side === 'BUY' ? [level] : [],
            asks: change.side === 'SELL' ? [level] : [],
            timestamp,
            kind: 'delta',
          },
        });
      }
      return true;
    }

    if (eventType === 'last_trade_price') {
      if (
        typeof value.asset_id !== 'string' ||
        typeof value.price !== 'string' ||
        typeof value.size !== 'string' ||
        (value.side !== 'BUY' && value.side !== 'SELL')
      ) {
        return true;
      }
      const data: WsTrade = {
        marketId: value.asset_id,
        price: value.price,
        size: value.size,
        side: value.side === 'BUY' ? 'buy' : 'sell',
        timestamp,
      };
      this.emit({ type: 'trade', data });
      this.emit({
        type: 'price',
        data: { marketId: data.marketId, price: data.price, timestamp },
      });
      return true;
    }

    // Recognized lifecycle/tick/top-of-book messages do not fit this legacy
    // client's narrow event union. They are handled by DataPipeline in the daemon.
    return true;
  }

  private isValidMessage(msg: unknown): msg is { type: string; data: unknown } {
    return (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      typeof (msg as Record<string, unknown>).type === 'string'
    );
  }

  private emit(message: WsMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch (error) {
        this.logger.error('Error in message handler', { error });
      }
    }
  }

  /**
   * Convert WebSocket data to string
   */
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
    // Handle ArrayBuffer
    return Buffer.from(data).toString();
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
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
      60000
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

    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      this.ws.send('PING');

      // Dead-socket detection: a fire-and-forget ping can't tell us the peer is
      // gone. If no pong has arrived since the dead-window started, the socket is
      // effectively half-open; terminate it so the 'close' handler reconnects.
      const sincePong = Date.now() - this.lastPongAt;
      if (
        this.lastPongAt > 0 &&
        sincePong > PolymarketWebSocketClient.HEARTBEAT_DEAD_THRESHOLD_MS
      ) {
        this.logger.warn('WebSocket dead socket (no pong received); terminating to reconnect', {
          sincePongMs: sincePong,
        });
        this.ws.terminate();
      }
    }, PolymarketWebSocketClient.HEARTBEAT_INTERVAL_MS);
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

function parseOfficialLevels(value: unknown): { price: string; size: string }[] | null {
  if (!Array.isArray(value)) return null;
  const levels: { price: string; size: string }[] = [];
  for (const level of value) {
    if (!level || typeof level !== 'object') return null;
    const price = (level as Record<string, unknown>).price;
    const size = (level as Record<string, unknown>).size;
    if (typeof price !== 'string' || typeof size !== 'string') return null;
    levels.push({ price, size });
  }
  return levels;
}

// Singleton instance
const polymarketWsSingleton = createSingleton(() => new PolymarketWebSocketClient());

export function getPolymarketWebSocketClient(
  _url?: string,
  _apiKey?: string
): PolymarketWebSocketClient {
  return polymarketWsSingleton.get();
}

export function resetPolymarketWebSocketClient(): void {
  polymarketWsSingleton.get().disconnect();
  polymarketWsSingleton.reset();
}
