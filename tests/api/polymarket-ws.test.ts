/**
 * Unit tests for Polymarket WebSocket Client
 */

import { jest } from '@jest/globals';
import type { WsMessage, WsTrade, WsOrderBookUpdate } from '../../src/api/polymarket-ws.js';

// Mock WebSocket class
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url = '';
  options: Record<string, unknown> | undefined;
  private eventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  constructor(url: string, options?: Record<string, unknown>) {
    this.url = url;
    this.options = options;
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.eventHandlers[event] ??= [];
    this.eventHandlers[event].push(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    this.eventHandlers[event]?.forEach((handler) => handler(...args));
  }

  send(data: string): void {
    // Mock send
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  ping(): void {
    // Mock ping
  }

  pong(data: Buffer): void {
    // Mock pong
  }

  terminate(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

// Replace WebSocket with mock
jest.unstable_mockModule('ws', () => ({
  default: MockWebSocket,
}));

// Mock config
jest.unstable_mockModule('../../src/utils/config.js', () => ({
  NETWORK_CONFIG: {
    WS_URL: 'wss://ws.polymarket.com',
    POLYMARKET_API_KEY: 'test-api-key',
    CONNECTION_TIMEOUT: 30000,
    RECONNECT_INTERVAL: 1000,
    MAX_RECONNECT_ATTEMPTS: 3,
  },
}));

// Mock logger
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  getLogger: jest.fn(() => ({
    child: jest.fn(() => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
}));

// Import after mocks
const { PolymarketWebSocketClient, getPolymarketWebSocketClient, resetPolymarketWebSocketClient } =
  await import('../../src/api/polymarket-ws.js');
const { NETWORK_CONFIG } = await import('../../src/utils/config.js');

describe('PolymarketWebSocketClient', () => {
  let client: InstanceType<typeof PolymarketWebSocketClient>;

  function getMockWs(): MockWebSocket | null {
    return client['ws'] as MockWebSocket | null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetPolymarketWebSocketClient();

    client = new PolymarketWebSocketClient('wss://ws.polymarket.com', 'test-api-key');
  });

  afterEach(() => {
    jest.useRealTimers();
    client.disconnect();
    resetPolymarketWebSocketClient();
  });

  describe('constructor', () => {
    it('should create client with provided URL and API key', () => {
      expect(client).toBeDefined();
    });

    it('should use default config values when not provided', () => {
      const defaultClient = new PolymarketWebSocketClient();
      expect(defaultClient).toBeDefined();
    });
  });

  describe('connect', () => {
    it('should create WebSocket connection', () => {
      client.connect();

      const mockWs = getMockWs();
      expect(mockWs).toBeTruthy();
      expect(mockWs?.url).toBe('wss://ws.polymarket.com');
      expect(mockWs?.options).not.toHaveProperty('headers');
    });

    it('should warn if already connected', () => {
      client.connect();
      const mockWs = getMockWs();
      if (mockWs) {
        mockWs.readyState = MockWebSocket.OPEN;
      }

      // Second connect should warn
      client.connect();
    });

    it('should setup event handlers', () => {
      client.connect();

      // Should have handlers registered
      expect(getMockWs()).toBeTruthy();
    });

    it('should handle connection creation error', async () => {
      // Mock WebSocket to throw on construction
      jest.unstable_mockModule('ws', () => ({
        default: class {
          constructor() {
            throw new Error('Connection failed');
          }
        },
      }));

      // Re-import to get the throwing mock
      const { PolymarketWebSocketClient: WsClient } =
        await import('../../src/api/polymarket-ws.js');
      const testClient = new WsClient('wss://ws.polymarket.com', 'test-api-key');

      testClient.connect();

      // Should schedule reconnect
      jest.advanceTimersByTime(1000);
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket connection', () => {
      client.connect();

      const mockWs = getMockWs();
      if (mockWs) {
        mockWs.readyState = MockWebSocket.OPEN;
      }

      const closeSpy = jest.spyOn(mockWs!, 'close');
      client.disconnect();

      expect(closeSpy).toHaveBeenCalled();
    });

    it('should clear timers on disconnect', () => {
      client.connect();

      // Trigger open to start heartbeat
      getMockWs()?.emit('open');

      client.disconnect();

      // Should not throw
      expect(() => jest.advanceTimersByTime(30000)).not.toThrow();
    });

    it('should handle disconnect when not connected', () => {
      // Should not throw
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe('event handlers', () => {
    beforeEach(() => {
      client.connect();
    });

    describe('open handler', () => {
      it('should reset reconnect attempts on open', () => {
        getMockWs()?.emit('open');

        // After reconnect attempts were incremented and then connection opened
        expect(client['reconnectAttempts']).toBe(0);
      });

      it('should start heartbeat on open', () => {
        const mockWs = getMockWs();
        if (mockWs) {
          mockWs.readyState = MockWebSocket.OPEN;
        }

        const sendSpy = jest.spyOn(mockWs!, 'send');
        mockWs?.emit('open');

        // Advance time to trigger heartbeat
        jest.advanceTimersByTime(10000);

        expect(sendSpy).toHaveBeenCalledWith('PING');
      });

      it('should resubscribe to markets on reconnect', () => {
        const mockWs = getMockWs();
        if (mockWs) {
          mockWs.readyState = MockWebSocket.OPEN;
        }

        // Subscribe to a market first
        client.subscribeToMarket('market-1');

        // Trigger reconnect (open after disconnect)
        mockWs?.emit('open');
      });
    });

    describe('message handler', () => {
      it('should handle trade messages', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const tradeMessage = {
          type: 'trade',
          data: {
            marketId: 'market-1',
            price: '0.6',
            size: '100',
            side: 'buy',
            timestamp: '2024-01-01T00:00:00Z',
          },
        };

        getMockWs()?.emit('message', Buffer.from(JSON.stringify(tradeMessage)));

        expect(handler).toHaveBeenCalledWith({
          type: 'trade',
          data: tradeMessage.data,
        });
      });

      it('should handle orderbook messages', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const orderbookMessage = {
          type: 'orderbook',
          data: {
            marketId: 'market-1',
            bids: [{ price: '0.6', size: '100' }],
            asks: [{ price: '0.65', size: '50' }],
            timestamp: '2024-01-01T00:00:00Z',
          },
        };

        getMockWs()?.emit('message', Buffer.from(JSON.stringify(orderbookMessage)));

        expect(handler).toHaveBeenCalledWith({
          type: 'orderbook',
          data: orderbookMessage.data,
        });
      });

      it('maps an official CLOB book snapshot without credentials or legacy envelopes', () => {
        const handler = jest.fn();
        client.subscribe(handler);
        getMockWs()?.emit(
          'message',
          JSON.stringify({
            event_type: 'book',
            asset_id: '1234567890',
            bids: [{ price: '0.48', size: '30' }],
            asks: [{ price: '0.52', size: '25' }],
            timestamp: '1757908892351',
          })
        );

        expect(handler).toHaveBeenCalledWith({
          type: 'orderbook',
          data: {
            marketId: '1234567890',
            bids: [{ price: '0.48', size: '30' }],
            asks: [{ price: '0.52', size: '25' }],
            timestamp: '1757908892351',
            kind: 'snapshot',
          },
        });
      });

      it('maps official price-change deltas and last-trade messages', () => {
        const handler = jest.fn();
        client.subscribe(handler);
        getMockWs()?.emit(
          'message',
          JSON.stringify({
            event_type: 'price_change',
            timestamp: '1757908892351',
            price_changes: [
              { asset_id: '123', price: '0.5', size: '20', side: 'BUY' },
              { asset_id: '456', price: '0.6', size: '10', side: 'SELL' },
            ],
          })
        );
        getMockWs()?.emit(
          'message',
          JSON.stringify({
            event_type: 'last_trade_price',
            asset_id: '123',
            price: '0.51',
            size: '2',
            side: 'BUY',
            timestamp: '1757908892352',
          })
        );

        expect(handler).toHaveBeenCalledWith({
          type: 'orderbook',
          data: {
            marketId: '123',
            bids: [{ price: '0.5', size: '20' }],
            asks: [],
            timestamp: '1757908892351',
            kind: 'delta',
          },
        });
        expect(handler).toHaveBeenCalledWith({
          type: 'trade',
          data: {
            marketId: '123',
            price: '0.51',
            size: '2',
            side: 'buy',
            timestamp: '1757908892352',
          },
        });
      });

      it('should handle price messages', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const priceMessage = {
          type: 'price',
          data: {
            marketId: 'market-1',
            price: '0.6',
            timestamp: '2024-01-01T00:00:00Z',
          },
        };

        getMockWs()?.emit('message', Buffer.from(JSON.stringify(priceMessage)));

        expect(handler).toHaveBeenCalledWith({
          type: 'price',
          data: priceMessage.data,
        });
      });

      it('should handle string data', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const message = JSON.stringify({
          type: 'trade',
          data: {
            marketId: 'market-1',
            price: '0.6',
            size: '100',
            side: 'buy',
            timestamp: '2024-01-01T00:00:00Z',
          },
        });

        getMockWs()?.emit('message', message);

        expect(handler).toHaveBeenCalled();
      });

      it('should handle ArrayBuffer data', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const message = JSON.stringify({
          type: 'trade',
          data: {
            marketId: 'market-1',
            price: '0.6',
            size: '100',
            side: 'buy',
            timestamp: '2024-01-01T00:00:00Z',
          },
        });
        const buffer = new ArrayBuffer(message.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < message.length; i++) {
          view[i] = message.charCodeAt(i);
        }

        getMockWs()?.emit('message', buffer);

        expect(handler).toHaveBeenCalled();
      });

      it('should handle invalid JSON gracefully', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        // Should not throw
        getMockWs()?.emit('message', Buffer.from('invalid json'));

        expect(handler).not.toHaveBeenCalled();
      });

      it('should handle messages without type', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const invalidMessage = { data: { test: 'value' } };

        getMockWs()?.emit('message', Buffer.from(JSON.stringify(invalidMessage)));

        expect(handler).not.toHaveBeenCalled();
      });

      it('should handle unknown message types', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const unknownMessage = {
          type: 'unknown',
          data: { test: 'value' },
        };

        // Should not throw
        getMockWs()?.emit('message', Buffer.from(JSON.stringify(unknownMessage)));

        expect(handler).not.toHaveBeenCalled();
      });

      it('should handle handler errors gracefully', () => {
        const errorHandler = jest.fn(() => {
          throw new Error('Handler error');
        });
        client.subscribe(errorHandler);

        const tradeMessage = {
          type: 'trade',
          data: {
            marketId: 'market-1',
            price: '0.6',
            size: '100',
            side: 'buy',
            timestamp: '2024-01-01T00:00:00Z',
          },
        };

        // Should not throw
        getMockWs()?.emit('message', Buffer.from(JSON.stringify(tradeMessage)));

        expect(errorHandler).toHaveBeenCalled();
      });

      it('should handle fragmented buffer arrays', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const message = JSON.stringify({
          type: 'trade',
          data: {
            marketId: 'market-1',
            price: '0.6',
            size: '100',
            side: 'buy',
            timestamp: '2024-01-01T00:00:00Z',
          },
        });

        // Split message into fragments
        const fragment1 = Buffer.from(message.slice(0, 20));
        const fragment2 = Buffer.from(message.slice(20));

        getMockWs()?.emit('message', [fragment1, fragment2]);

        expect(handler).toHaveBeenCalled();
      });
    });

    describe('close handler', () => {
      it('should clear timers on close', () => {
        getMockWs()?.emit('close', 1000, Buffer.from('Normal closure'));

        // Should not throw when advancing timers
        expect(() => jest.advanceTimersByTime(30000)).not.toThrow();
      });

      it('should schedule reconnect on unexpected close', () => {
        const mockWs = getMockWs();
        mockWs!.readyState = MockWebSocket.OPEN;
        mockWs?.emit('open');

        // Reset reconnect attempts to ensure we're starting fresh
        client['reconnectAttempts'] = 0;
        client['isManualClose'] = false;

        const connectSpy = jest.spyOn(client, 'connect');

        // Simulate unexpected close
        mockWs!.readyState = MockWebSocket.CLOSED;
        mockWs?.emit('close', 1006, Buffer.from('Connection lost'));

        // Advance to reconnect
        jest.advanceTimersByTime(1000);

        expect(connectSpy).toHaveBeenCalledTimes(1);
      });

      it('should not reconnect on manual close', () => {
        const mockWs = getMockWs();
        mockWs!.readyState = MockWebSocket.OPEN;
        mockWs?.emit('open');

        const connectSpy = jest.spyOn(client, 'connect');

        client.disconnect();
        mockWs?.emit('close', 1000, Buffer.from('Manual close'));

        // Advance time
        jest.advanceTimersByTime(5000);

        // Should not create new connection (only the initial connect in beforeEach)
        expect(connectSpy).toHaveBeenCalledTimes(0);
      });
    });

    describe('error handler', () => {
      it('should log errors', () => {
        const error = new Error('Connection error');

        // Should not throw
        getMockWs()?.emit('error', error);
      });
    });

    describe('ping handler', () => {
      it('should respond with pong', () => {
        const mockWs = getMockWs();
        if (mockWs) {
          mockWs.readyState = MockWebSocket.OPEN;
        }

        const pongSpy = jest.spyOn(mockWs!, 'pong');
        const pingData = Buffer.from('ping');

        mockWs?.emit('ping', pingData);

        expect(pongSpy).toHaveBeenCalledWith(pingData);
      });
    });
  });

  describe('subscribe', () => {
    it('should add handler and return unsubscribe function', () => {
      const handler = jest.fn();

      const unsubscribe = client.subscribe(handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should remove handler when unsubscribe called', () => {
      client.connect();
      const mockWs = getMockWs();
      if (mockWs) {
        mockWs.readyState = MockWebSocket.OPEN;
      }

      const handler = jest.fn();
      const unsubscribe = client.subscribe(handler);

      // Trigger a message to verify handler is called
      const tradeMessage = {
        type: 'trade',
        data: {
          marketId: 'market-1',
          price: '0.6',
          size: '100',
          side: 'buy',
          timestamp: '2024-01-01T00:00:00Z',
        },
      };

      mockWs?.emit('message', Buffer.from(JSON.stringify(tradeMessage)));
      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Trigger another message
      mockWs?.emit('message', Buffer.from(JSON.stringify(tradeMessage)));
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, not called again
    });
  });

  describe('subscribeToMarket', () => {
    beforeEach(() => {
      client.connect();
      const mockWs = getMockWs();
      if (mockWs) {
        mockWs.readyState = MockWebSocket.OPEN;
      }
    });

    it('should send subscribe message', () => {
      const mockWs = getMockWs();
      const sendSpy = jest.spyOn(mockWs!, 'send');

      client.subscribeToMarket('market-1');

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify({
          assets_ids: ['market-1'],
          operation: 'subscribe',
          custom_feature_enabled: true,
        })
      );
    });

    it('should track subscribed markets', () => {
      client.subscribeToMarket('market-1');
      client.subscribeToMarket('market-2');

      expect(client['subscribedMarkets'].has('market-1')).toBe(true);
      expect(client['subscribedMarkets'].has('market-2')).toBe(true);
    });

    it('should not send when not connected', () => {
      const mockWs = getMockWs();
      mockWs!.readyState = MockWebSocket.CLOSED;

      // Should not throw
      client.subscribeToMarket('market-1');

      // Market should still be tracked
      expect(client['subscribedMarkets'].has('market-1')).toBe(true);
    });
  });

  describe('unsubscribeFromMarket', () => {
    beforeEach(() => {
      client.connect();
      const mockWs = getMockWs();
      if (mockWs) {
        mockWs.readyState = MockWebSocket.OPEN;
      }
    });

    it('should send unsubscribe message', () => {
      client.subscribeToMarket('market-1');

      const mockWs = getMockWs();
      const sendSpy = jest.spyOn(mockWs!, 'send');

      client.unsubscribeFromMarket('market-1');

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify({
          assets_ids: ['market-1'],
          operation: 'unsubscribe',
        })
      );
    });

    it('should remove market from tracking', () => {
      client.subscribeToMarket('market-1');
      client.unsubscribeFromMarket('market-1');

      expect(client['subscribedMarkets'].has('market-1')).toBe(false);
    });

    it('should handle unsubscribing from non-subscribed market', () => {
      // Should not throw
      client.unsubscribeFromMarket('non-existent');
    });
  });

  describe('isConnected', () => {
    it('should return true when WebSocket is open', () => {
      client.connect();
      const mockWs = getMockWs();
      if (mockWs) {
        mockWs.readyState = MockWebSocket.OPEN;
      }

      expect(client.isConnected()).toBe(true);
    });

    it('should return false when WebSocket is not open', () => {
      client.connect();
      // readyState is CONNECTING by default

      expect(client.isConnected()).toBe(false);
    });

    it('should return false when WebSocket is null', () => {
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('reconnection', () => {
    it('should reconnect with exponential backoff', () => {
      // Pin jitter so delays equal the deterministic base (API-5).
      jest.spyOn(Math, 'random').mockReturnValue(1);
      const connectSpy = jest.spyOn(client, 'connect');

      client.connect();

      // First close
      const mockWs = getMockWs();
      mockWs!.readyState = MockWebSocket.CLOSED;
      mockWs?.emit('close', 1006, Buffer.from('Connection lost'));

      // Should schedule reconnect at 1000ms (initial interval)
      jest.advanceTimersByTime(1000);
      expect(connectSpy).toHaveBeenCalledTimes(2);

      // Get the new WebSocket instance
      const mockWs2 = getMockWs();

      // Second close
      mockWs2!.readyState = MockWebSocket.CLOSED;
      mockWs2?.emit('close', 1006, Buffer.from('Connection lost'));

      // Should schedule reconnect at 2000ms (2x initial interval)
      jest.advanceTimersByTime(2000);
      expect(connectSpy).toHaveBeenCalledTimes(3);
    });

    it('should cap reconnect delay at 60 seconds', () => {
      jest.spyOn(Math, 'random').mockReturnValue(1);
      const mutableNetworkConfig = NETWORK_CONFIG as { MAX_RECONNECT_ATTEMPTS: number };
      const originalMaxReconnectAttempts = mutableNetworkConfig.MAX_RECONNECT_ATTEMPTS;
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      try {
        client.connect();

        mutableNetworkConfig.MAX_RECONNECT_ATTEMPTS = 20;
        client['reconnectAttempts'] = 7;

        const mockWs = getMockWs();
        mockWs!.readyState = MockWebSocket.CLOSED;
        mockWs?.emit('close', 1006, Buffer.from('Connection lost'));

        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 60000);
      } finally {
        mutableNetworkConfig.MAX_RECONNECT_ATTEMPTS = originalMaxReconnectAttempts;
        setTimeoutSpy.mockRestore();
      }
    });

    it('should stop reconnecting after max attempts', () => {
      const connectSpy = jest.spyOn(client, 'connect');
      const handler = jest.fn();
      client.subscribe(handler);

      client.connect();

      // Exhaust all reconnect attempts
      for (let i = 0; i < 4; i++) {
        const mockWs = getMockWs();
        mockWs!.readyState = MockWebSocket.CLOSED;
        mockWs?.emit('close', 1006, Buffer.from('Connection lost'));
        jest.advanceTimersByTime(60000);
      }

      jest.advanceTimersByTime(60000);

      // Should not have created a new WebSocket
      expect(connectSpy).toHaveBeenCalledTimes(4); // Initial + 3 reconnects
      expect(client.isReconnectExhausted()).toBe(true);
      expect(handler).toHaveBeenCalledWith({ type: 'reconnect_exhausted', attempts: 3 });
    });

    it('resetReconnect clears exhaustion and schedules a fresh connect (API-1)', () => {
      const connectSpy = jest.spyOn(client, 'connect');
      client.connect();

      for (let i = 0; i < 4; i++) {
        const mockWs = getMockWs();
        mockWs!.readyState = MockWebSocket.CLOSED;
        mockWs?.emit('close', 1006, Buffer.from('Connection lost'));
        jest.advanceTimersByTime(60000);
      }
      expect(client.isReconnectExhausted()).toBe(true);
      const callsAfterExhaust = connectSpy.mock.calls.length;

      client.resetReconnect();
      expect(client.isReconnectExhausted()).toBe(false);
      expect(connectSpy.mock.calls.length).toBeGreaterThan(callsAfterExhaust);
    });

    it('should cancel stale reconnect timers after repeated close events', () => {
      const connectSpy = jest.spyOn(client, 'connect');
      client.connect();

      const mockWs = getMockWs();
      mockWs!.readyState = MockWebSocket.CLOSED;
      mockWs?.emit('close', 1006, Buffer.from('Connection lost'));
      mockWs?.emit('close', 1006, Buffer.from('Connection lost'));

      client.disconnect();
      jest.advanceTimersByTime(60000);

      expect(connectSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      client.connect();
    });

    it('should send periodic ping messages', () => {
      const mockWs = getMockWs();
      const sendSpy = jest.spyOn(mockWs!, 'send');

      mockWs!.readyState = MockWebSocket.OPEN;
      mockWs?.emit('open');

      jest.advanceTimersByTime(10000);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenLastCalledWith('PING');

      mockWs?.emit('message', 'PONG');
      jest.advanceTimersByTime(10000);
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });

    it('should not ping if connection is closed', () => {
      const mockWs = getMockWs();
      const sendSpy = jest.spyOn(mockWs!, 'send');

      mockWs!.readyState = MockWebSocket.OPEN;
      mockWs?.emit('open');

      mockWs!.readyState = MockWebSocket.CLOSED;
      jest.advanceTimersByTime(10000);

      // Ping should not be called when closed
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('terminates the socket when PONG goes stale (API-4)', () => {
      const mockWs = getMockWs();
      const terminateSpy = jest.spyOn(mockWs!, 'terminate');

      mockWs!.readyState = MockWebSocket.OPEN;
      mockWs?.emit('open');
      // open sets lastPongAt; threshold is strict > 30s
      jest.advanceTimersByTime(40_000);

      expect(terminateSpy).toHaveBeenCalled();
    });

    it('refreshes the dead-socket window on PONG text frames (API-4)', () => {
      const mockWs = getMockWs();
      const terminateSpy = jest.spyOn(mockWs!, 'terminate');

      mockWs!.readyState = MockWebSocket.OPEN;
      mockWs?.emit('open');

      jest.advanceTimersByTime(20_000);
      mockWs?.emit('message', 'PONG');
      jest.advanceTimersByTime(20_000);

      expect(terminateSpy).not.toHaveBeenCalled();
    });
  });

  describe('singleton', () => {
    it('getPolymarketWebSocketClient should return same instance', () => {
      const client1 = getPolymarketWebSocketClient('wss://ws1.polymarket.com', 'key1');
      const client2 = getPolymarketWebSocketClient('wss://ws2.polymarket.com', 'key2');

      expect(client1).toBe(client2);
    });

    it('resetPolymarketWebSocketClient should disconnect and clear instance', () => {
      const client1 = getPolymarketWebSocketClient();
      client1.connect();

      // Get the WebSocket instance created by connect
      const wsBeforeReset = client1['ws'] as MockWebSocket | null;
      if (wsBeforeReset) {
        wsBeforeReset.readyState = MockWebSocket.OPEN;
      }

      resetPolymarketWebSocketClient();

      expect(wsBeforeReset?.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('resetPolymarketWebSocketClient should work when client is not connected', () => {
      getPolymarketWebSocketClient();

      // Should not throw
      expect(() => resetPolymarketWebSocketClient()).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle null message data', () => {
      client.connect();

      const handler = jest.fn();
      client.subscribe(handler);

      // Should not throw
      getMockWs()?.emit('message', Buffer.from('null'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle message with null type', () => {
      client.connect();

      const handler = jest.fn();
      client.subscribe(handler);

      const message = { type: null, data: {} };

      // Should not throw
      getMockWs()?.emit('message', Buffer.from(JSON.stringify(message)));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle empty string message', () => {
      client.connect();

      const handler = jest.fn();
      client.subscribe(handler);

      // Should not throw
      getMockWs()?.emit('message', Buffer.from(''));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle send when not connected', () => {
      client.connect();
      const mockWs = getMockWs();
      if (mockWs) {
        mockWs.readyState = MockWebSocket.CLOSED;
      }

      // Should not throw
      client.subscribeToMarket('market-1');
    });
  });
});
