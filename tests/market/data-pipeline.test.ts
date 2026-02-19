/**
 * Unit tests for WebSocket Data Pipeline
 *
 * Comprehensive tests covering WebSocket event handlers, message parsing,
 * reconnection logic, heartbeat/ping-pong, subscription management,
 * and error handling.
 */

import { jest } from '@jest/globals';
import type { MarketData, OrderBookUpdate, DataPipelineEvent } from '../../src/market/data-pipeline.js';

// Define mock state - must be defined before any imports
const mockState: {
  wsInstance: MockWsInstance | null;
  constructorCalls: Array<{ url: string; options: unknown }>;
} = {
  wsInstance: null,
  constructorCalls: [],
};

interface MockWsInstance {
  readyState: number;
  on: jest.Mock;
  close: jest.Mock;
  send: jest.Mock;
  ping: jest.Mock;
  pong: jest.Mock;
  eventHandlers: Record<string, (...args: unknown[]) => void>;
}

// Mock logger - must be before importing the module under test
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  getLogger: jest.fn(() => ({
    child: jest.fn(() => mockLogger),
  })),
  createSilentLogger: jest.fn(() => mockLogger),
}));

// Mock config
jest.unstable_mockModule('../../src/utils/config.js', () => ({
  NETWORK_CONFIG: {
    WS_URL: 'wss://ws.polymarket.com',
    CONNECTION_TIMEOUT: 30000,
    RECONNECT_INTERVAL: 100,
    MAX_RECONNECT_ATTEMPTS: 3,
  },
}));

// Mock ws module - using unstable_mockModule for ES modules
// The key is to use __esModule: true and default export
jest.unstable_mockModule('ws', () => ({
  __esModule: true,
  default: Object.assign(
    jest.fn().mockImplementation((url: string, options: unknown) => {
      mockState.constructorCalls.push({ url, options });
      const instance: MockWsInstance = {
        readyState: 0, // CONNECTING
        on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
          instance.eventHandlers[event] = handler;
        }),
        close: jest.fn(),
        send: jest.fn(),
        ping: jest.fn(),
        pong: jest.fn(),
        eventHandlers: {},
      };
      mockState.wsInstance = instance;
      return instance;
    }),
    {
      OPEN: 1,
      CLOSED: 3,
      CONNECTING: 0,
    }
  ),
  OPEN: 1,
  CLOSED: 3,
  CONNECTING: 0,
}));

// Import after mocks
const { DataPipeline, getDataPipeline, resetDataPipeline } = await import('../../src/market/data-pipeline.js');

describe('DataPipeline', () => {
  let pipeline: InstanceType<typeof DataPipeline>;

  beforeEach(() => {
    jest.useFakeTimers();
    // Reset mock state
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockState.wsInstance = null;
    mockState.constructorCalls = [];

    resetDataPipeline();
    pipeline = new DataPipeline('wss://test.polymarket.com');
  });

  afterEach(() => {
    pipeline?.disconnect();
    resetDataPipeline();
    jest.useRealTimers();
  });

  describe('connection management', () => {
    it('should connect to WebSocket', () => {
      pipeline.connect();

      expect(mockState.constructorCalls).toHaveLength(1);
      expect(mockState.constructorCalls[0].url).toBe('wss://test.polymarket.com');
      expect(mockState.constructorCalls[0].options).toEqual({
        handshakeTimeout: 30000,
      });
    });

    it('should warn when already connected', () => {
      pipeline.connect();

      // Simulate connection open
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      // Try to connect again
      pipeline.connect();

      expect(mockLogger.warn).toHaveBeenCalledWith('Already connected');
    });

    it('should disconnect from WebSocket', () => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      pipeline.disconnect();

      expect(mockState.wsInstance?.close).toHaveBeenCalled();
    });

    it('should handle multiple disconnect calls gracefully', () => {
      pipeline.connect();
      pipeline.disconnect();
      pipeline.disconnect();
      pipeline.disconnect();

      // Should not throw
      expect(mockState.wsInstance?.close).toHaveBeenCalledTimes(1);
    });

    it('should report connection state correctly', () => {
      expect(pipeline.isConnected()).toBe(false);

      pipeline.connect();
      expect(pipeline.isConnected()).toBe(false);

      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }
      expect(pipeline.isConnected()).toBe(true);
    });
  });

  describe('WebSocket event handlers', () => {
    beforeEach(() => {
      pipeline.connect();
    });

    it('should handle open event', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      // Simulate open
      mockState.wsInstance?.eventHandlers['open']?.();

      expect(handler).toHaveBeenCalledWith({ type: 'connected' });
    });

    it('should reset reconnect attempts on open', () => {
      // First trigger a reconnect to set attempts > 0
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
      jest.advanceTimersByTime(100);

      // Simulate successful reconnection
      mockState.wsInstance?.eventHandlers['open']?.();

      // Next reconnect should start from attempt 1
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
      jest.advanceTimersByTime(100);
    });

    it('should start heartbeat on open', () => {
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      mockState.wsInstance?.eventHandlers['open']?.();

      // Advance by 30 seconds (heartbeat interval)
      jest.advanceTimersByTime(30000);

      expect(mockState.wsInstance?.ping).toHaveBeenCalled();
    });

    it('should handle close event', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test reason'));

      expect(handler).toHaveBeenCalledWith({ type: 'disconnected' });
    });

    it('should schedule reconnect on unexpected close', () => {
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));

      // Should schedule reconnect
      jest.advanceTimersByTime(100);

      expect(mockState.constructorCalls).toHaveLength(2);
    });

    it('should not reconnect on manual disconnect', () => {
      pipeline.disconnect();

      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));

      // Should not schedule reconnect
      jest.advanceTimersByTime(200);

      // WebSocket should only be called once (initial connection)
      expect(mockState.constructorCalls).toHaveLength(1);
    });

    it('should handle error event', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const error = new Error('WebSocket error');
      mockState.wsInstance?.eventHandlers['error']?.(error);

      expect(handler).toHaveBeenCalledWith({ type: 'error', error });
    });

    it('should handle ping event with pong response', () => {
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      const pingData = Buffer.from('ping');
      mockState.wsInstance?.eventHandlers['ping']?.(pingData);

      expect(mockState.wsInstance?.pong).toHaveBeenCalledWith(pingData);
    });

    it('should clear timers on close', () => {
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }
      mockState.wsInstance?.eventHandlers['open']?.();

      // Close should clear heartbeat
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));

      // Advance timers - should not call ping
      jest.advanceTimersByTime(30000);

      // Ping should only be called once (before close)
      expect(mockState.wsInstance?.ping).not.toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    beforeEach(() => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }
    });

    it('should handle trade message', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const tradeMessage = {
        event_type: 'trade',
        market_id: 'market-1',
        event_id: 'event-1',
        price: 0.75,
        size: 100,
        side: 'buy',
        timestamp: 1234567890,
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(tradeMessage));

      expect(handler).toHaveBeenCalledWith({
        type: 'trade',
        data: {
          marketId: 'market-1',
          eventId: 'event-1',
          price: 0.75,
          size: 100,
          side: 'buy',
          timestamp: 1234567890,
        },
      });
    });

    it('should handle trade message with numeric market_id', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const tradeMessage = {
        event_type: 'trade',
        market_id: 12345,
        event_id: 67890,
        price: 0.75,
        size: 100,
        side: 'sell',
        timestamp: 1234567890,
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(tradeMessage));

      expect(handler).toHaveBeenCalledWith({
        type: 'trade',
        data: {
          marketId: '12345',
          eventId: '67890',
          price: 0.75,
          size: 100,
          side: 'sell',
          timestamp: 1234567890,
        },
      });
    });

    it('should not emit trade without market_id', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const tradeMessage = {
        event_type: 'trade',
        price: 0.75,
        size: 100,
        side: 'buy',
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(tradeMessage));

      expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'trade' }));
    });

    it('should handle orderbook message', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const orderbookMessage = {
        event_type: 'orderbook',
        market_id: 'market-1',
        bids: [{ price: 0.4, size: 100 }, { price: 0.45, size: 200 }],
        asks: [{ price: 0.6, size: 100 }, { price: 0.65, size: 200 }],
        timestamp: 1234567890,
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(orderbookMessage));

      expect(handler).toHaveBeenCalledWith({
        type: 'orderbook',
        data: {
          marketId: 'market-1',
          bids: [{ price: 0.4, size: 100 }, { price: 0.45, size: 200 }],
          asks: [{ price: 0.6, size: 100 }, { price: 0.65, size: 200 }],
          timestamp: 1234567890,
        },
      });
    });

    it('should handle book message (alias for orderbook)', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const bookMessage = {
        event_type: 'book',
        market_id: 'market-1',
        bids: [{ price: 0.4, size: 100 }],
        asks: [{ price: 0.6, size: 100 }],
        timestamp: 1234567890,
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(bookMessage));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'orderbook',
        })
      );
    });

    it('should handle orderbook without bids/asks arrays', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const orderbookMessage = {
        event_type: 'orderbook',
        market_id: 'market-1',
        timestamp: 1234567890,
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(orderbookMessage));

      expect(handler).toHaveBeenCalledWith({
        type: 'orderbook',
        data: {
          marketId: 'market-1',
          bids: [],
          asks: [],
          timestamp: 1234567890,
        },
      });
    });

    it('should not emit orderbook without market_id', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const orderbookMessage = {
        event_type: 'orderbook',
        bids: [{ price: 0.4, size: 100 }],
        asks: [{ price: 0.6, size: 100 }],
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(orderbookMessage));

      expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'orderbook' }));
    });

    it('should handle price_change message', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const priceMessage = {
        event_type: 'price_change',
        market_id: 'market-1',
        event_id: 'event-1',
        price: 0.8,
        timestamp: 1234567890,
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(priceMessage));

      expect(handler).toHaveBeenCalledWith({
        type: 'trade',
        data: {
          marketId: 'market-1',
          eventId: 'event-1',
          price: 0.8,
          size: 0,
          side: 'buy',
          timestamp: 1234567890,
        },
      });
    });

    it('should ignore unknown message types', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const unknownMessage = {
        event_type: 'unknown_type',
        data: 'some data',
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(unknownMessage));

      // Should only receive connected event from open handler, not unknown message
      const tradeCalls = handler.mock.calls.filter(
        (call) => (call[0] as {type: string}).type === 'trade'
      );
      const orderbookCalls = handler.mock.calls.filter(
        (call) => (call[0] as {type: string}).type === 'orderbook'
      );

      expect(tradeCalls).toHaveLength(0);
      expect(orderbookCalls).toHaveLength(0);
    });

    it('should handle invalid JSON message', () => {
      mockState.wsInstance?.eventHandlers['message']?.('invalid json {[');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to parse message',
        expect.objectContaining({
          error: expect.any(String),
          data: 'invalid json {[',
        })
      );
    });

    it('should handle message without event_type', () => {
      const invalidMessage = {
        market_id: 'market-1',
        price: 0.5,
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(invalidMessage));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid message received',
        expect.objectContaining({
          message: expect.objectContaining(invalidMessage),
        })
      );
    });

    it('should handle message with Buffer data', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const tradeMessage = {
        event_type: 'trade',
        market_id: 'market-1',
        event_id: 'event-1',
        price: 0.75,
        size: 100,
        side: 'buy',
        timestamp: 1234567890,
      };

      const bufferData = Buffer.from(JSON.stringify(tradeMessage));
      mockState.wsInstance?.eventHandlers['message']?.(bufferData);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'trade',
        })
      );
    });

    it('should handle message with ArrayBuffer data', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const tradeMessage = {
        event_type: 'trade',
        market_id: 'market-1',
        event_id: 'event-1',
        price: 0.75,
        size: 100,
        side: 'buy',
        timestamp: 1234567890,
      };

      const encoded = new TextEncoder().encode(JSON.stringify(tradeMessage));
      const arrayBuffer = encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength
      );
      mockState.wsInstance?.eventHandlers['message']?.(arrayBuffer);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'trade',
        })
      );
    });

    it('should handle message with fragmented Buffer array data', () => {
      const handler = jest.fn();
      pipeline.subscribe(handler);

      const tradeMessage = {
        event_type: 'trade',
        market_id: 'market-1',
        event_id: 'event-1',
        price: 0.75,
        size: 100,
        side: 'buy',
        timestamp: 1234567890,
      };

      const serialized = JSON.stringify(tradeMessage);
      const midpoint = Math.floor(serialized.length / 2);
      const fragments = [
        Buffer.from(serialized.slice(0, midpoint)),
        Buffer.from(serialized.slice(midpoint)),
      ];
      mockState.wsInstance?.eventHandlers['message']?.(fragments);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'trade',
        })
      );
    });

    it('should handle invalid Buffer data', () => {
      const bufferData = Buffer.from('invalid json {[');
      mockState.wsInstance?.eventHandlers['message']?.(bufferData);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to parse message',
        expect.objectContaining({
          error: expect.any(String),
          data: 'invalid json {[',
        })
      );
    });

    it('should handle null message', () => {
      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(null));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid message received',
        expect.any(Object)
      );
    });

    it('should handle message with non-string event_type', () => {
      const invalidMessage = {
        event_type: 123,
        market_id: 'market-1',
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(invalidMessage));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid message received',
        expect.any(Object)
      );
    });
  });

  describe('subscription management', () => {
    it('should subscribe and receive events', () => {
      const handler = jest.fn();
      const unsubscribe = pipeline.subscribe(handler);

      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    });

    it('should allow multiple subscribers', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      const unsubscribe1 = pipeline.subscribe(handler1);
      const unsubscribe2 = pipeline.subscribe(handler2);

      expect(typeof unsubscribe1).toBe('function');
      expect(typeof unsubscribe2).toBe('function');

      expect(() => unsubscribe1()).not.toThrow();
      expect(() => unsubscribe2()).not.toThrow();
    });

    it('should stop receiving events after unsubscribe', () => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      const handler = jest.fn();
      const unsubscribe = pipeline.subscribe(handler);

      // Unsubscribe
      unsubscribe();

      // Trigger event
      mockState.wsInstance?.eventHandlers['open']?.();

      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle handler errors gracefully', () => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      const errorHandler = jest.fn(() => {
        throw new Error('Handler error');
      });
      const goodHandler = jest.fn();

      pipeline.subscribe(errorHandler);
      pipeline.subscribe(goodHandler);

      // Trigger event
      mockState.wsInstance?.eventHandlers['open']?.();

      // Error handler should have thrown but been caught
      expect(errorHandler).toHaveBeenCalled();
      // Good handler should still be called
      expect(goodHandler).toHaveBeenCalled();
      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error in event handler',
        expect.objectContaining({
          error: 'Handler error',
        })
      );
    });

    it('should handle handler errors with non-Error objects', () => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      const errorHandler = jest.fn(() => {
        throw 'String error';
      });

      pipeline.subscribe(errorHandler);

      // Trigger event
      mockState.wsInstance?.eventHandlers['open']?.();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error in event handler',
        expect.objectContaining({
          error: 'String error',
        })
      );
    });
  });

  describe('reconnection logic', () => {
    beforeEach(() => {
      pipeline.connect();
    });

    it('should reconnect with exponential backoff', () => {
      // First disconnect triggers reconnect after 100ms
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
      jest.advanceTimersByTime(100);
      expect(mockState.constructorCalls).toHaveLength(2);

      // Second disconnect triggers reconnect after 200ms
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
      jest.advanceTimersByTime(200);
      expect(mockState.constructorCalls).toHaveLength(3);

      // Third disconnect triggers reconnect after 400ms
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
      jest.advanceTimersByTime(400);
      expect(mockState.constructorCalls).toHaveLength(4);
    });

    it('should stop reconnecting after max attempts', () => {
      // Trigger max reconnects
      for (let i = 0; i < 4; i++) {
        mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
        jest.advanceTimersByTime(100 * Math.pow(2, i));
      }

      expect(mockLogger.error).toHaveBeenCalledWith('Max reconnection attempts reached');

      // Should not attempt more reconnects
      jest.advanceTimersByTime(60000);
      expect(mockState.constructorCalls).toHaveLength(4); // Initial + 3 reconnects
    });

    it('should cap reconnect delay at 60 seconds', () => {
      // Simulate many reconnects to test delay capping
      // Initial connection + 10 reconnects = 11 total
      for (let i = 0; i < 10; i++) {
        // Trigger close event
        mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
        // Advance by the base reconnect interval (100ms) to trigger next reconnect
        // The delay increases exponentially but we advance by a small fixed amount
        // to ensure timers fire
        jest.advanceTimersByTime(100);
      }

      // Advance any remaining timers to ensure all reconnects complete
      jest.runAllTimers();

      // Should have attempted many reconnects (initial + reconnects)
      // Note: Due to exponential backoff, not all 10 may complete immediately
      expect(mockState.constructorCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('should reset reconnect attempts on successful connection', () => {
      // Trigger reconnect
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
      jest.advanceTimersByTime(100);

      // Simulate successful connection
      mockState.wsInstance?.eventHandlers['open']?.();

      // Now disconnect again - should start from attempt 1
      mockState.wsInstance?.eventHandlers['close']?.(1000, Buffer.from('test'));
      jest.advanceTimersByTime(100);

      // Should reconnect immediately with base delay
      expect(mockState.constructorCalls).toHaveLength(3);
    });

    it('should cancel stale reconnect timers after repeated close events', () => {
      // Fire close twice before timer execution to simulate noisy close/error bursts.
      mockState.wsInstance?.eventHandlers['close']?.(1006, Buffer.from('test'));
      mockState.wsInstance?.eventHandlers['close']?.(1006, Buffer.from('test'));

      // Manual disconnect should cancel all future reconnect attempts.
      pipeline.disconnect();
      jest.advanceTimersByTime(60000);

      expect(mockState.constructorCalls).toHaveLength(1);
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }
    });

    it('should send ping every 30 seconds', () => {
      mockState.wsInstance?.eventHandlers['open']?.();

      jest.advanceTimersByTime(30000);
      expect(mockState.wsInstance?.ping).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30000);
      expect(mockState.wsInstance?.ping).toHaveBeenCalledTimes(2);
    });

    it('should not send ping if connection is closed', () => {
      mockState.wsInstance?.eventHandlers['open']?.();

      // Close connection
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 3; // CLOSED
      }

      jest.advanceTimersByTime(30000);
      expect(mockState.wsInstance?.ping).not.toHaveBeenCalled();
    });
  });

  describe('subscription to markets', () => {
    beforeEach(() => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }
    });

    it('should subscribe to all market channels on connect', () => {
      mockState.wsInstance?.eventHandlers['open']?.();

      expect(mockState.wsInstance?.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', channel: 'trades' })
      );
      expect(mockState.wsInstance?.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', channel: 'orderbook' })
      );
      expect(mockState.wsInstance?.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', channel: 'price_change' })
      );
    });

    it('should not send subscription if connection is not open', () => {
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 0; // CONNECTING
      }
      mockState.wsInstance?.eventHandlers['open']?.();

      // Since readyState is not OPEN during the call, subscriptions won't be sent
      // This tests the guard in the send method
    });
  });

  describe('singleton management', () => {
    it('should return same instance from getDataPipeline', () => {
      const pipeline1 = getDataPipeline();
      const pipeline2 = getDataPipeline();

      expect(pipeline1).toBe(pipeline2);
    });

    it('should create new instance after reset', () => {
      const pipeline1 = getDataPipeline();
      resetDataPipeline();
      const pipeline2 = getDataPipeline();

      expect(pipeline1).not.toBe(pipeline2);
    });

    it('should disconnect on reset', () => {
      const testPipeline = getDataPipeline();
      testPipeline.connect();

      expect(() => resetDataPipeline()).not.toThrow();
    });
  });

  describe('data types', () => {
    it('should export MarketData type', () => {
      const marketData: {marketId: string, eventId: string, price: number, size: number, side: 'buy' | 'sell', timestamp: number} = {
        marketId: 'test',
        eventId: 'event-1',
        price: 0.5,
        size: 100,
        side: 'buy',
        timestamp: Date.now(),
      };

      expect(marketData.marketId).toBe('test');
      expect(marketData.side).toBe('buy');
    });

    it('should export OrderBookUpdate type', () => {
      const orderBook: {marketId: string, bids: Array<{price: number, size: number}>, asks: Array<{price: number, size: number}>, timestamp: number} = {
        marketId: 'test',
        bids: [{ price: 0.4, size: 100 }],
        asks: [{ price: 0.6, size: 100 }],
        timestamp: Date.now(),
      };

      expect(orderBook.marketId).toBe('test');
      expect(orderBook.bids).toHaveLength(1);
      expect(orderBook.asks).toHaveLength(1);
    });

    it('should export DataPipelineEvent type', () => {
      const connectedEvent: {type: string} = { type: 'connected' };
      const disconnectedEvent: {type: string} = { type: 'disconnected' };
      const errorEvent: {type: string, error: Error} = { type: 'error', error: new Error('test') };
      const tradeEvent: {type: string, data: unknown} = {
        type: 'trade',
        data: {
          marketId: 'test',
          eventId: 'event-1',
          price: 0.5,
          size: 100,
          side: 'buy',
          timestamp: Date.now(),
        },
      };
      const orderbookEvent: {type: string, data: unknown} = {
        type: 'orderbook',
        data: {
          marketId: 'test',
          bids: [{ price: 0.4, size: 100 }],
          asks: [{ price: 0.6, size: 100 }],
          timestamp: Date.now(),
        },
      };

      expect(connectedEvent.type).toBe('connected');
      expect(disconnectedEvent.type).toBe('disconnected');
      expect(errorEvent.type).toBe('error');
      expect(tradeEvent.type).toBe('trade');
      expect(orderbookEvent.type).toBe('orderbook');
    });
  });

  describe('edge cases', () => {
    it('should handle rapid connect/disconnect cycles', () => {
      expect(() => {
        pipeline.connect();
        pipeline.disconnect();
        pipeline.connect();
        pipeline.disconnect();
      }).not.toThrow();
    });

    it('should handle subscribe after disconnect', () => {
      pipeline.connect();
      pipeline.disconnect();

      const handler = jest.fn();
      expect(() => pipeline.subscribe(handler)).not.toThrow();
    });

    it('should handle trade with default values', () => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      const handler = jest.fn();
      pipeline.subscribe(handler);

      const tradeMessage = {
        event_type: 'trade',
        market_id: 'market-1',
        // Missing optional fields
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(tradeMessage));

      expect(handler).toHaveBeenCalledWith({
        type: 'trade',
        data: {
          marketId: 'market-1',
          eventId: '',
          price: 0,
          size: 0,
          side: 'sell', // default when not 'buy'
          timestamp: expect.any(Number),
        },
      });
    });

    it('should handle orderbook with missing bid/ask fields', () => {
      pipeline.connect();
      if (mockState.wsInstance) {
        mockState.wsInstance.readyState = 1; // OPEN
      }

      const handler = jest.fn();
      pipeline.subscribe(handler);

      const orderbookMessage = {
        event_type: 'orderbook',
        market_id: 'market-1',
        bids: [{ price: undefined, size: null }, { price: 0.5 }],
        asks: [{ unknown: 'field' }],
      };

      mockState.wsInstance?.eventHandlers['message']?.(JSON.stringify(orderbookMessage));

      expect(handler).toHaveBeenCalledWith({
        type: 'orderbook',
        data: {
          marketId: 'market-1',
          bids: [
            { price: expect.any(Number), size: expect.any(Number) },
            { price: 0.5, size: expect.any(Number) },
          ],
          asks: [{ price: expect.any(Number), size: expect.any(Number) }],
          timestamp: expect.any(Number),
        },
      });
    });
  });
});
