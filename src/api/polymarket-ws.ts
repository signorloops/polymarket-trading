/**
 * Polymarket WebSocket Client
 *
 * Real-time market data streaming
 */

import WebSocket from 'ws';
import { getLogger } from '../utils/logger.js';
import { NETWORK_CONFIG } from '../utils/config.js';

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
}

export type WsMessage =
  | { type: 'trade'; data: WsTrade }
  | { type: 'orderbook'; data: WsOrderBookUpdate }
  | { type: 'price'; data: { marketId: string; price: string; timestamp: string } };

type WsHandler = (message: WsMessage) => void;

export class PolymarketWebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private apiKey: string;
  private handlers: Set<WsHandler> = new Set();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isManualClose = false;
  private subscribedMarkets: Set<string> = new Set();
  private logger = getLogger().child({ module: 'PolymarketWebSocket' });

  constructor(url?: string, apiKey?: string) {
    this.url = url ?? NETWORK_CONFIG.WS_URL;
    this.apiKey = apiKey ?? NETWORK_CONFIG.POLYMARKET_API_KEY ?? '';
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.logger.warn('WebSocket already connected');
      return;
    }

    this.isManualClose = false;
    this.logger.info('Connecting to Polymarket WebSocket', { url: this.url });

    try {
      this.ws = new WebSocket(this.url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
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
      type: 'subscribe',
      channel: 'market',
      marketId,
    });
  }

  unsubscribeFromMarket(marketId: string): void {
    this.subscribedMarkets.delete(marketId);
    this.send({
      type: 'unsubscribe',
      channel: 'market',
      marketId,
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();

      // Resubscribe to markets
      for (const marketId of this.subscribedMarkets) {
        this.subscribeToMarket(marketId);
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const dataStr = typeof data === 'string' ? data : Buffer.from(data).toString();
        const message: unknown = JSON.parse(dataStr);
        this.handleMessage(message);
      } catch (error) {
        const dataStr = typeof data === 'string' ? data : Buffer.from(data).toString();
        this.logger.error('Failed to parse message', { error: error instanceof Error ? error.message : String(error), data: dataStr });
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.info('WebSocket closed', { code, reason: reason.toString() });
      this.clearTimers();

      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: Error) => {
      this.logger.error('WebSocket error', { error: error.message });
    });

    this.ws.on('ping', (data: Buffer) => {
      this.ws?.pong(data);
    });
  }

  private handleMessage(message: unknown): void {
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
        this.emit({ type: 'price', data: msg.data as { marketId: string; price: string; timestamp: string } });
        break;
      default:
        this.logger.debug('Unknown message type', { type: msg.type });
    }
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

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= NETWORK_CONFIG.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error('Max reconnection attempts reached');
      return;
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
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
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

// Singleton instance
let globalWsClient: PolymarketWebSocketClient | null = null;

export function getPolymarketWebSocketClient(url?: string, apiKey?: string): PolymarketWebSocketClient {
  globalWsClient ??= new PolymarketWebSocketClient(url, apiKey);
  return globalWsClient;
}

export function resetPolymarketWebSocketClient(): void {
  globalWsClient?.disconnect();
  globalWsClient = null;
}
