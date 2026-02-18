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
import type { LifecycleComponent, ComponentStatus } from '../lifecycle/shutdown.js';

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
  sequence?: number;
}

/**
 * Sequence tracking statistics
 */
export interface SequenceStats {
  lastSequence: number;
  totalMessages: number;
  droppedMessages: number;
  lastDropTime: number | null;
  consecutiveDrops: number;
}

export type DataPipelineEvent =
  | { type: 'trade'; data: MarketData }
  | { type: 'orderbook'; data: OrderBookUpdate }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'error'; error: Error };

type EventHandler = (event: DataPipelineEvent) => void;

/**
 * Alert callback for sequence gap events
 */
export type SequenceGapAlert = (marketId: string, expected: number, received: number) => void;

export class DataPipeline implements LifecycleComponent {
  id = 'data-pipeline';
  priority = 100; // Close early

  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private handlers: Set<EventHandler> = new Set();
  private logger = getLogger().child({ module: 'DataPipeline' });
  private isManualClose = false;
  private lastActivity = Date.now();

  // Sequence tracking per market
  private sequenceTracker: Map<string, SequenceStats> = new Map();
  private sequenceGapAlert: SequenceGapAlert | null = null;
  private readonly MAX_CONSECUTIVE_DROPS = 3;

  constructor(url: string = NETWORK_CONFIG.WS_URL) {
    this.url = url;
  }

  /**
   * Connect to the WebSocket
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
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
        error: error instanceof Error ? error.message : String(error),
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

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emit({ type: 'connected' });
      this.subscribeToMarkets();
    });

    this.ws.on('message', (wsData: WebSocket.Data) => {
      try {
        const dataStr = typeof wsData === 'string' ? wsData : Buffer.from(wsData as Buffer).toString();
        const message: unknown = JSON.parse(dataStr);
        this.handleMessage(message);
      } catch (error) {
        this.logger.error('Failed to parse message', {
          error: error instanceof Error ? error.message : String(error),
          data: typeof wsData === 'string' ? wsData : Buffer.from(wsData as Buffer).toString().slice(0, 200),
        });
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.info('WebSocket closed', {
        code,
        reason: reason.toString(),
      });
      this.clearTimers();
      this.emit({ type: 'disconnected' });

      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: Error) => {
      this.logger.error('WebSocket error', { error: error.message });
      this.emit({ type: 'error', error });
    });

    this.ws.on('ping', (data: Buffer) => {
      this.ws?.pong(data);
    });
  }

  private handleMessage(message: unknown): void {
    this.lastActivity = Date.now();

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

    // Validate sequence number
    const sequence = typeof msg.sequence === 'number' ? msg.sequence : undefined;
    const isValidSequence = this.validateSequence(marketId, sequence);

    const data: OrderBookUpdate = {
      marketId,
      bids,
      asks,
      timestamp: Number(msg.timestamp ?? Date.now()),
      ...(sequence !== undefined && { sequence }),
    };

    if (data.marketId) {
      // Emit with gap information
      this.emit({ type: 'orderbook', data });

      // Log warning if sequence gap detected
      if (!isValidSequence && sequence !== undefined) {
        this.logger.warn('Order book update may be incomplete due to message gap', {
          marketId,
          sequence,
        });
      }
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

  private emit(event: DataPipelineEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error('Error in event handler', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Validate sequence number for a market
   * Returns true if message is valid (no gap), false if dropped messages detected
   */
  private validateSequence(marketId: string, sequence: number | undefined): boolean {
    if (sequence === undefined) {
      // Message without sequence number is always accepted
      return true;
    }

    const stats = this.sequenceTracker.get(marketId);

    if (!stats) {
      // First message for this market
      this.sequenceTracker.set(marketId, {
        lastSequence: sequence,
        totalMessages: 1,
        droppedMessages: 0,
        lastDropTime: null,
        consecutiveDrops: 0,
      });
      return true;
    }

    const expectedSequence = stats.lastSequence + 1;

    if (sequence === expectedSequence) {
      // Perfect sequence
      stats.lastSequence = sequence;
      stats.totalMessages++;
      stats.consecutiveDrops = 0;
      return true;
    }

    if (sequence > expectedSequence) {
      // Gap detected - messages were dropped
      const droppedCount = sequence - expectedSequence;
      stats.droppedMessages += droppedCount;
      stats.lastSequence = sequence;
      stats.totalMessages++;
      stats.lastDropTime = Date.now();
      stats.consecutiveDrops++;

      this.logger.warn('Message sequence gap detected', {
        marketId,
        expected: expectedSequence,
        received: sequence,
        droppedCount,
        consecutiveDrops: stats.consecutiveDrops,
      });

      // Trigger alert callback if registered
      if (this.sequenceGapAlert) {
        try {
          this.sequenceGapAlert(marketId, expectedSequence, sequence);
        } catch (error) {
          this.logger.error('Error in sequence gap alert handler', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // If too many consecutive drops, trigger resync
      if (stats.consecutiveDrops >= this.MAX_CONSECUTIVE_DROPS) {
        this.logger.error('Too many consecutive message drops, triggering resync', {
          marketId,
          consecutiveDrops: stats.consecutiveDrops,
        });
        this.triggerResync(marketId);
      }

      return false;
    }

    // sequence < expectedSequence - duplicate or out-of-order message
    this.logger.warn('Out-of-order message received', {
      marketId,
      expected: expectedSequence,
      received: sequence,
      lastSequence: stats.lastSequence,
    });

    // Still accept the message but don't update sequence tracking
    stats.totalMessages++;
    return true;
  }

  /**
   * Trigger resync for a specific market
   */
  private triggerResync(marketId: string): void {
    this.logger.info('Triggering market resync', { marketId });

    // Request full order book snapshot
    this.send({
      type: 'resync',
      market_id: marketId,
      channel: 'orderbook',
    });

    // Reset sequence tracking for this market
    const stats = this.sequenceTracker.get(marketId);
    if (stats) {
      stats.consecutiveDrops = 0;
    }
  }

  /**
   * Register a callback for sequence gap alerts
   */
  onSequenceGap(alert: SequenceGapAlert): () => void {
    this.sequenceGapAlert = alert;
    return () => {
      this.sequenceGapAlert = null;
    };
  }

  /**
   * Get sequence statistics for all markets
   */
  getSequenceStats(): Map<string, SequenceStats> {
    return new Map(this.sequenceTracker);
  }

  /**
   * Get sequence statistics for a specific market
   */
  getMarketSequenceStats(marketId: string): SequenceStats | undefined {
    return this.sequenceTracker.get(marketId);
  }

  /**
   * Reset sequence tracking for a market
   */
  resetSequenceTracking(marketId?: string): void {
    if (marketId) {
      this.sequenceTracker.delete(marketId);
      this.logger.debug('Reset sequence tracking for market', { marketId });
    } else {
      this.sequenceTracker.clear();
      this.logger.debug('Reset sequence tracking for all markets');
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
      60000 // Max 60 seconds
    );

    this.logger.info(`Scheduling reconnect in ${String(delay)}ms`, {
      attempt: this.reconnectAttempts,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    // Send ping every 30 seconds to keep connection alive
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
    this.heartbeatTimer.unref?.();
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

  /**
   * Lifecycle: Destroy the data pipeline
   */
  async destroy(): Promise<void> {
    this.logger.info('Destroying DataPipeline...');

    // Disconnect WebSocket
    this.disconnect();

    // Clear all handlers
    this.handlers.clear();

    // Clear sequence tracking
    this.sequenceTracker.clear();

    this.logger.info('DataPipeline destroyed');
  }

  /**
   * Lifecycle: Get component status
   */
  getStatus(): ComponentStatus {
    return {
      id: this.id,
      healthy: this.isConnected(),
      pendingOperations: 0,
      lastActivity: this.lastActivity,
    };
  }
}

/**
 * Create a singleton data pipeline instance
 */
let globalPipeline: DataPipeline | null = null;

export function getDataPipeline(url?: string): DataPipeline {
  globalPipeline ??= new DataPipeline(url);
  return globalPipeline;
}

/**
 * Reset the global pipeline (for testing)
 */
export async function resetDataPipeline(): Promise<void> {
  if (globalPipeline) {
    await globalPipeline.destroy();
    globalPipeline = null;
  }
}
