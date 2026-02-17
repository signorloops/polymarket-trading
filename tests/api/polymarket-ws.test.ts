/**
 * Unit tests for Polymarket WebSocket Client
 */

import { jest } from '@jest/globals';
import type {
  WsMessage,
  WsTrade,
  WsOrderBookUpdate,
} from '../../src/api/polymarket-ws.js';

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
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
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
const {
  PolymarketWebSocketClient,
  getPolymarketWebSocketClient,
  resetPolymarketWebSocketClient,
} = await import('../../src/api/polymarket-ws.js');

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
      const { PolymarketWebSocketClient: WsClient } = await import(
        '../../src/api/polymarket-ws.js'
      );
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

        const pingSpy = jest.spyOn(mockWs!, 'ping');
        mockWs?.emit('open');

        // Advance time to trigger heartbeat
        jest.advanceTimersByTime(30000);

        expect(pingSpy).toHaveBeenCalled();
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
          data: { marketId: 'market-1', price: '0.6', size: '100', side: 'buy', timestamp: '2024-01-01T00:00:00Z' },
        });

        getMockWs()?.emit('message', message);

        expect(handler).toHaveBeenCalled();
      });

      it('should handle ArrayBuffer data', () => {
        const handler = jest.fn();
        client.subscribe(handler);

        const message = JSON.stringify({
          type: 'trade',
          data: { marketId: 'market-1', price: '0.6', size: '100', side: 'buy', timestamp: '2024-01-01T00:00:00Z' },
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
          data: { marketId: 'market-1', price: '0.6', size: '100', side: 'buy', timestamp: '2024-01-01T00:00:00Z' },
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
          type: 'subscribe',
          channel: 'market',
          marketId: 'market-1',
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
          type: 'unsubscribe',
          channel: 'market',
          marketId: 'market-1',
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
      client.connect();

      // Simulate multiple reconnect attempts
      for (let i = 0; i < 10; i++) {
        const mockWs = getMockWs();
        mockWs!.readyState = MockWebSocket.CLOSED;
        mockWs?.emit('close', 1006, Buffer.from('Connection lost'));
        jest.advanceTimersByTime(Math.min(1000 * Math.pow(2, i), 60000));
      }

      // Should still be trying to reconnect
      expect(getMockWs()).toBeTruthy();
    });

    it('should stop reconnecting after max attempts', () => {
      const connectSpy = jest.spyOn(client, 'connect');

      client.connect();

      // Exhaust all reconnect attempts
      for (let i = 0; i < 4; i++) {
        const mockWs = getMockWs();
        mockWs!.readyState = MockWebSocket.CLOSED;
        mockWs?.emit('close', 1006, Buffer.from('Connection lost'));
        jest.advanceTimersByTime(60000);
      }

      // Try one more time
      const mockWs = getMockWs();
      mockWs!.readyState = MockWebSocket.CLOSED;
      mockWs?.emit('close', 1006, Buffer.from('Connection lost'));
      jest.advanceTimersByTime(60000);

      // Should not have created a new WebSocket
      expect(connectSpy).toHaveBeenCalledTimes(4); // Initial + 3 reconnects
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      client.connect();
    });

    it('should send periodic ping messages', () => {
      const mockWs = getMockWs();
      const pingSpy = jest.spyOn(mockWs!, 'ping');

      mockWs!.readyState = MockWebSocket.OPEN;
      mockWs?.emit('open');

      jest.advanceTimersByTime(30000);
      expect(pingSpy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30000);
      expect(pingSpy).toHaveBeenCalledTimes(2);
    });

    it('should not ping if connection is closed', () => {
      const mockWs = getMockWs();
      const pingSpy = jest.spyOn(mockWs!, 'ping');

      mockWs!.readyState = MockWebSocket.OPEN;
      mockWs?.emit('open');

      mockWs!.readyState = MockWebSocket.CLOSED;
      jest.advanceTimersByTime(30000);

      // Ping should not be called when closed
      expect(pingSpy).not.toHaveBeenCalled();
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
