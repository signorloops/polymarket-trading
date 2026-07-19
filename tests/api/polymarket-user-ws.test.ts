import { once } from 'node:events';

import { jest } from '@jest/globals';
import WebSocket, { WebSocketServer } from 'ws';

import {
  PolymarketUserWebSocketClient,
  type UserWebSocketEvent,
} from '../../src/api/polymarket-user-ws.js';

const conditionId = `0x${'a'.repeat(64)}`;
const credentials = {
  apiKey: 'api-key-value',
  secret: 'secret-value',
  passphrase: 'passphrase-value',
};

describe('PolymarketUserWebSocketClient', () => {
  let server: WebSocketServer;
  let serverSocket: WebSocket | undefined;
  let client: PolymarketUserWebSocketClient | undefined;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    server.on('connection', (socket) => {
      serverSocket = socket;
    });
  });

  afterEach(async () => {
    client?.disconnect();
    client = undefined;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function url(): string {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    return `ws://127.0.0.1:${String(address.port)}`;
  }

  it('sends credentials only in the user subscription and becomes ready after PONG', async () => {
    const frames: string[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const frame = rawDataToString(data);
        frames.push(frame);
        if (frame === 'PING') socket.send('PONG');
      });
    });
    client = new PolymarketUserWebSocketClient(credentials, {
      url: url(),
      conditionIds: [conditionId],
      maxReconnectAttempts: 0,
    });

    client.connect();
    await client.waitUntilReady(2000);

    expect(client.isReady()).toBe(true);
    const subscription = frames
      .map((frame) => safeParse(frame))
      .find((frame) => frame !== undefined);
    expect(subscription).toEqual({
      auth: {
        apiKey: credentials.apiKey,
        secret: credentials.secret,
        passphrase: credentials.passphrase,
      },
      markets: [conditionId],
      type: 'user',
    });
    expect(frames).toContain('PING');
  });

  it('strictly normalizes order and trade lifecycle events', async () => {
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        if (rawDataToString(data) === 'PING') socket.send('PONG');
      });
    });
    client = new PolymarketUserWebSocketClient(credentials, {
      url: url(),
      maxReconnectAttempts: 0,
    });
    const events: UserWebSocketEvent[] = [];
    client.subscribe((event) => events.push(event));
    client.connect();
    await client.waitUntilReady(2000);

    const confirmed = client.waitForOrderUpdate(
      'order-1',
      (update) => update.status === 'LIVE',
      1000
    );
    serverSocket?.send(
      JSON.stringify({
        event_type: 'order',
        type: 'UPDATE',
        id: 'order-1',
        market: conditionId,
        asset_id: '123',
        side: 'BUY',
        status: 'LIVE',
        original_size: '10',
        size_matched: '2.5',
        price: '0.45',
        timestamp: '1700000000',
      })
    );
    serverSocket?.send(
      JSON.stringify({
        event_type: 'trade',
        id: 'trade-1',
        market: conditionId,
        asset_id: '123',
        side: 'SELL',
        status: 'CONFIRMED',
        size: '2.5',
        price: '0.45',
        timestamp: '1700000001',
        taker_order_id: 'order-1',
        maker_orders: [{ order_id: 'maker-order-1' }],
        transaction_hash: `0x${'b'.repeat(64)}`,
      })
    );
    await waitFor(() => events.length === 2);

    expect(events[0]).toEqual({
      type: 'order',
      data: {
        orderId: 'order-1',
        conditionId,
        tokenId: '123',
        side: 'buy',
        lifecycle: 'UPDATE',
        status: 'LIVE',
        originalSize: 10,
        matchedSize: 2.5,
        price: 0.45,
        observedAt: 1_700_000_000_000,
      },
    });
    expect(client.getLastOrderUpdate('order-1')).toEqual(events[0]?.data);
    await expect(confirmed).resolves.toMatchObject({ orderId: 'order-1', status: 'LIVE' });
    expect(events[1]).toMatchObject({
      type: 'trade',
      data: {
        tradeId: 'trade-1',
        lifecycle: 'CONFIRMED',
        relatedOrderIds: ['order-1', 'maker-order-1'],
        observedAt: 1_700_000_001_000,
      },
    });
  });

  it('ignores malformed private events without exposing them to consumers', async () => {
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        if (rawDataToString(data) === 'PING') socket.send('PONG');
      });
    });
    client = new PolymarketUserWebSocketClient(credentials, {
      url: url(),
      maxReconnectAttempts: 0,
    });
    const handler = jest.fn();
    client.subscribe(handler);
    client.connect();
    await client.waitUntilReady(2000);

    serverSocket?.send(
      JSON.stringify({
        event_type: 'order',
        type: 'UPDATE',
        id: 'order-1',
        market: 'not-a-condition',
        asset_id: '123',
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed when credentials are incomplete', () => {
    expect(
      () =>
        new PolymarketUserWebSocketClient({
          apiKey: 'key',
          secret: '',
          passphrase: 'passphrase',
        })
    ).toThrow(/missing secret/);
  });

  it('emits reconnect_exhausted and rejects ready waiters after max attempts (API-3)', async () => {
    // Drop the peer immediately so the client schedules reconnect with a zero budget.
    server.on('connection', (socket) => {
      socket.close();
    });

    client = new PolymarketUserWebSocketClient(credentials, {
      url: url(),
      maxReconnectAttempts: 0,
      reconnectIntervalMs: 10,
      connectionTimeoutMs: 500,
    });
    const events: UserWebSocketEvent[] = [];
    client.subscribe((event) => events.push(event));

    const ready = client.waitUntilReady(500);
    client.connect();

    await expect(ready).rejects.toThrow(/reconnect limit reached/);
    await waitFor(() => events.some((e) => e.type === 'reconnect_exhausted'));
    expect(client.isReconnectExhausted()).toBe(true);
    expect(events).toContainEqual({ type: 'reconnect_exhausted', attempts: 0 });
  });

  it('rejects waitUntilReady when readiness times out (API-3)', async () => {
    // Accept the TCP connection but never reply PONG.
    client = new PolymarketUserWebSocketClient(credentials, {
      url: url(),
      maxReconnectAttempts: 0,
      connectionTimeoutMs: 50,
    });
    client.connect();
    await expect(client.waitUntilReady(80)).rejects.toThrow(/Timed out waiting/);
  });

  it('rejects pending ready waiters on disconnect (API-3)', async () => {
    client = new PolymarketUserWebSocketClient(credentials, {
      url: url(),
      maxReconnectAttempts: 0,
      connectionTimeoutMs: 2000,
    });
    const ready = client.waitUntilReady(2000);
    client.connect();
    // Disconnect before PONG arrives.
    client.disconnect();
    await expect(ready).rejects.toThrow(/disconnected/);
  });

  it('rejects pending order-update waiters on disconnect (API-6)', async () => {
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        if (rawDataToString(data) === 'PING') socket.send('PONG');
      });
    });
    client = new PolymarketUserWebSocketClient(credentials, {
      url: url(),
      maxReconnectAttempts: 0,
    });
    client.connect();
    await client.waitUntilReady(2000);

    const pending = client.waitForOrderUpdate('order-pending', () => true, 5000);
    client.disconnect();
    await expect(pending).rejects.toThrow(/disconnected/);
  });

  it('terminates when the heartbeat becomes stale (API-3)', async () => {
    client = new PolymarketUserWebSocketClient(credentials, {
      url: url(),
      maxReconnectAttempts: 0,
      heartbeatIntervalMs: 1000,
      heartbeatDeadThresholdMs: 2000,
      connectionTimeoutMs: 2000,
    });

    // Respond to the initial PING so the client becomes ready, then go silent.
    let pongsSent = 0;
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        if (rawDataToString(data) === 'PING' && pongsSent === 0) {
          pongsSent++;
          socket.send('PONG');
        }
      });
    });

    client.connect();
    await client.waitUntilReady(2000);
    expect(client.isReady()).toBe(true);

    const socket = serverSocket;
    expect(socket).toBeDefined();
    await once(socket!, 'close');
    expect(client.isConnected()).toBe(false);
  }, 10_000);
});

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function rawDataToString(data: WebSocket.RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
