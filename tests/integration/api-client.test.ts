/**
 * API Client Integration Tests
 */

import { PolymarketClient } from '../../src/api/polymarket-client.js';
import { PolymarketWebSocketClient } from '../../src/api/polymarket-ws.js';

describe('API Client Integration', () => {
  describe('PolymarketClient', () => {
    it('should create client with default config', () => {
      const client = new PolymarketClient();
      expect(client).toBeDefined();
    });

    it('should create client with API key', () => {
      const client = new PolymarketClient('test-api-key');
      expect(client).toBeDefined();
    });
  });

  describe('PolymarketWebSocketClient', () => {
    it('should create WebSocket client', () => {
      const client = new PolymarketWebSocketClient('wss://test.example.com');
      expect(client).toBeDefined();
    });

    it('should track subscription state', () => {
      const client = new PolymarketWebSocketClient('wss://test.example.com');
      expect((client as any).ws).toBeNull();
    });

    it('should handle message handlers', () => {
      const client = new PolymarketWebSocketClient('wss://test.example.com');
      const handler = () => {};

      client.subscribe(handler);

      const handlers = (client as any).handlers;
      expect(handlers.has(handler)).toBe(true);
    });
  });
});
