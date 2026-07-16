import { jest } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chain, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import type { SignedClobClientConfig, SignedClobSdkClient } from '../../src/api/index.js';
import { FileOrderIdempotencyStore } from '../../src/execution/order-idempotency-store.js';

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

jest.unstable_mockModule('../../src/utils/config.js', () => ({
  NETWORK_CONFIG: {
    POLYMARKET_API_KEY: 'env-api-key',
    POLYMARKET_SECRET: 'env-secret',
    POLYMARKET_PASSPHRASE: 'env-passphrase',
    POLYMARKET_CHAIN_ID: Chain.POLYGON,
    POLYMARKET_SIGNATURE_TYPE: SignatureTypeV2.POLY_PROXY,
    POLYMARKET_FUNDER_ADDRESS: '0x1111111111111111111111111111111111111111',
    POLYMARKET_DEFAULT_TICK_SIZE: '0.01',
    POLYMARKET_NEG_RISK: false,
  },
  WALLET_CONFIG: {
    PRIVATE_KEY: `0x${'1'.repeat(64)}`,
  },
}));

const { SignedClobTradingClient, getSignedClobConfigFromEnv } =
  await import('../../src/api/signed-clob-client.js');

describe('SignedClobTradingClient', () => {
  function createConfig(overrides: Partial<SignedClobClientConfig> = {}): SignedClobClientConfig {
    return {
      host: 'https://clob.polymarket.com',
      chainId: Chain.POLYGON,
      privateKey: `0x${'1'.repeat(64)}`,
      apiKey: 'api-key',
      secret: 'secret',
      passphrase: 'passphrase',
      signatureType: SignatureTypeV2.EOA,
      defaultTickSize: '0.01',
      negRisk: false,
      idempotencyDirectory: mkdtempSync(join(tmpdir(), 'signed-clob-idempotency-')),
      deferExec: false,
      ...overrides,
    };
  }

  function createSdk(overrides: Partial<SignedClobSdkClient> = {}): SignedClobSdkClient {
    return {
      createAndPostOrder: jest.fn().mockResolvedValue({
        success: true,
        orderID: '0xorder',
        status: 'live',
        errorMsg: '',
      }),
      createAndPostMarketOrder: jest.fn().mockResolvedValue({
        success: true,
        orderID: '0xorder',
        status: 'matched',
        takingAmount: '5',
        makingAmount: '2.1',
      }),
      cancelOrder: jest.fn().mockResolvedValue({ canceled: ['0xorder'] }),
      getOrder: jest.fn().mockRejectedValue(new Error('not indexed yet')),
      getOpenOrders: jest.fn().mockResolvedValue([]),
      getBalanceAllowance: jest.fn().mockResolvedValue({
        balance: '0',
        allowances: {},
      }),
      postHeartbeat: jest.fn().mockResolvedValue({ heartbeat_id: 'heartbeat-1' }),
      ...overrides,
    } as unknown as SignedClobSdkClient;
  }

  it('maps internal GTC limit orders to signed CLOB SDK orders', async () => {
    const sdk = createSdk();
    const client = new SignedClobTradingClient(createConfig(), sdk);

    const response = await client.placeOrder({
      idempotencyKey: 'signed-order-mapping',
      marketId: '1234567890',
      side: 'buy',
      size: 5,
      price: 0.42,
      orderType: 'limit',
      timeInForce: 'GTC',
    });

    expect(sdk.createAndPostOrder).toHaveBeenCalledWith(
      {
        tokenID: '1234567890',
        price: 0.42,
        side: 'BUY',
        size: 5,
      },
      { tickSize: '0.01', negRisk: false },
      'GTC',
      false,
      false
    );
    expect(response).toMatchObject({
      id: '0xorder',
      marketId: '1234567890',
      status: 'open',
      filledSize: 0,
      remainingSize: 5,
    });
  });

  it('blocks a duplicate in-flight order (kill-switch against double submission)', async () => {
    // Hold the first submission open so its in-flight key is still set when the
    // second, identical, concurrent submission arrives.
    let resolveCreate!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveCreate = resolve;
    });
    const sdk = createSdk({ createAndPostOrder: jest.fn().mockReturnValue(pending) });
    const client = new SignedClobTradingClient(createConfig(), sdk);

    const order = {
      idempotencyKey: 'concurrent-order-one',
      marketId: '1234567890',
      side: 'buy' as const,
      size: 5,
      price: 0.42,
      orderType: 'limit' as const,
      timeInForce: 'GTC' as const,
    };

    const first = client.placeOrder(order); // in-flight, not yet settled
    await expect(
      client.placeOrder({ ...order, idempotencyKey: 'concurrent-order-two' })
    ).rejects.toThrow(/Duplicate in-flight/);
    expect(sdk.createAndPostOrder).toHaveBeenCalledTimes(1);

    // After the first settles, the key is released and a new submission is allowed.
    resolveCreate({ success: true, orderID: '0xorder', status: 'live', errorMsg: '' });
    await first;
    await expect(
      client.placeOrder({ ...order, idempotencyKey: 'concurrent-order-three' })
    ).resolves.toBeDefined();
    expect(sdk.createAndPostOrder).toHaveBeenCalledTimes(2);
  });

  it('rejects order submission when L2 credentials are incomplete', async () => {
    const sdk = createSdk();
    const config = createConfig();
    delete config.apiKey;
    const client = new SignedClobTradingClient(config, sdk);

    await expect(
      client.placeOrder({
        idempotencyKey: 'missing-l2-credentials',
        marketId: '1234567890',
        side: 'sell',
        size: 5,
        price: 0.42,
        orderType: 'limit',
        timeInForce: 'GTC',
      })
    ).rejects.toThrow(/POLYMARKET_API_KEY/);
    expect(sdk.createAndPostOrder).not.toHaveBeenCalled();
  });

  it('rejects proxy wallet signing without a funder address', async () => {
    const sdk = createSdk();
    const client = new SignedClobTradingClient(
      createConfig({ signatureType: SignatureTypeV2.POLY_PROXY }),
      sdk
    );

    await expect(
      client.placeOrder({
        idempotencyKey: 'missing-funder-address',
        marketId: '1234567890',
        side: 'sell',
        size: 5,
        price: 0.42,
        orderType: 'limit',
        timeInForce: 'GTC',
      })
    ).rejects.toThrow(/POLYMARKET_FUNDER_ADDRESS/);
    expect(sdk.createAndPostOrder).not.toHaveBeenCalled();
  });

  it('maps FOK market orders to the V2 SDK', async () => {
    const sdk = createSdk();
    const client = new SignedClobTradingClient(createConfig(), sdk);

    await expect(
      client.placeOrder({
        idempotencyKey: 'supported-market-order',
        marketId: '1234567890',
        side: 'buy',
        size: 5,
        price: 0.42,
        orderType: 'market',
        timeInForce: 'FOK',
      })
    ).resolves.toMatchObject({ status: 'filled', filledSize: 5 });
    expect(sdk.createAndPostMarketOrder).toHaveBeenCalledWith(
      {
        tokenID: '1234567890',
        price: 0.42,
        side: 'BUY',
        amount: 2.1,
        orderType: 'FOK',
      },
      { tickSize: '0.01', negRisk: false },
      'FOK',
      false
    );
  });

  it('submits cancellation through the signed CLOB SDK', async () => {
    const sdk = createSdk();
    const client = new SignedClobTradingClient(createConfig(), sdk);

    await client.cancelOrder('0xorder');

    expect(sdk.cancelOrder).toHaveBeenCalledWith({ orderID: '0xorder' });
  });

  it('maps partially filled CLOB order status to partial', async () => {
    const sdk = createSdk({
      getOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        asset_id: '1234567890',
        side: 'BUY',
        original_size: '5',
        size_matched: '2',
        price: '0.42',
        status: 'partially_filled',
        created_at: 1_766_016_000,
      }),
    });
    const client = new SignedClobTradingClient(createConfig(), sdk);

    const order = await client.getOrder('0xorder');

    expect(order).toMatchObject({
      id: '0xorder',
      marketId: '1234567890',
      status: 'partial',
      filledSize: 2,
      remainingSize: 3,
      createdAt: '2025-12-18T00:00:00.000Z',
    });
  });

  it('reads complete conditional-token balances using six-decimal token units', async () => {
    const sdk = createSdk({
      getBalanceAllowance: jest
        .fn()
        .mockResolvedValueOnce({ balance: '2500000', allowances: { exchange: '1000000' } })
        .mockResolvedValueOnce({ balance: '125000', allowances: {} }),
    });
    const client = new SignedClobTradingClient(createConfig(), sdk);

    await expect(client.getBalances(['123', '456', '123'])).resolves.toEqual([
      { assetId: '123', size: 2.5, allowances: { exchange: 1 } },
      { assetId: '456', size: 0.125, allowances: {} },
    ]);
    expect(sdk.getBalanceAllowance).toHaveBeenCalledTimes(2);
  });

  it('confirms the first heartbeat before starting the keepalive loop', async () => {
    const sdk = createSdk();
    const client = new SignedClobTradingClient(createConfig(), sdk);

    await client.startHeartbeat(1_000);

    expect(sdk.postHeartbeat).toHaveBeenCalledTimes(1);
    client.stopHeartbeat();
  });

  it('rejects heartbeat startup when the exchange does not confirm it', async () => {
    const sdk = createSdk({
      postHeartbeat: jest.fn().mockResolvedValue({
        heartbeat_id: '',
        error_msg: 'heartbeat rejected',
      }),
    });
    const client = new SignedClobTradingClient(createConfig(), sdk);

    await expect(client.startHeartbeat()).rejects.toThrow(/heartbeat rejected/);
    client.stopHeartbeat();
  });

  it('does not resurrect a heartbeat timer when stopped during the initial request', async () => {
    jest.useFakeTimers();
    let resolveHeartbeat: ((value: { heartbeat_id: string }) => void) | undefined;
    const sdk = createSdk({
      postHeartbeat: jest.fn().mockImplementation(
        () =>
          new Promise<{ heartbeat_id: string }>((resolve) => {
            resolveHeartbeat = resolve;
          })
      ),
    });
    const client = new SignedClobTradingClient(createConfig(), sdk);
    try {
      const starting = client.startHeartbeat(1_000);
      client.stopHeartbeat();
      resolveHeartbeat?.({ heartbeat_id: 'hb-1' });
      await starting;
      await jest.advanceTimersByTimeAsync(2_000);

      expect(sdk.postHeartbeat).toHaveBeenCalledTimes(1);
    } finally {
      client.stopHeartbeat();
      jest.useRealTimers();
    }
  });

  it('rejects an order lookup response with a missing or unknown side', async () => {
    const sdk = createSdk({
      getOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        asset_id: '1234567890',
        original_size: '5',
        size_matched: '0',
        price: '0.42',
        status: 'live',
      }),
    });
    const client = new SignedClobTradingClient(createConfig(), sdk);

    await expect(client.getOrder('0xorder')).rejects.toThrow(/invalid side: missing/);
  });

  it('maps environment config to CLOB client config without exposing secrets', () => {
    const config = getSignedClobConfigFromEnv();

    expect(config).toMatchObject({
      host: 'https://clob.polymarket.com',
      chainId: Chain.POLYGON,
      apiKey: 'env-api-key',
      secret: 'env-secret',
      passphrase: 'env-passphrase',
      signatureType: SignatureTypeV2.POLY_PROXY,
      funderAddress: '0x1111111111111111111111111111111111111111',
      defaultTickSize: '0.01',
      negRisk: false,
      deferExec: false,
    });
  });

  it('fails closed on an ambiguous pre-restart journal claim', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'signed-clob-restart-'));
    const store = new FileOrderIdempotencyStore(directory);
    store.claim('old-ambiguous-order', {
      marketId: '1234567890',
      side: 'buy',
      size: 1,
      price: 0.4,
    });
    const sdk = createSdk();
    const client = new SignedClobTradingClient(
      createConfig({ idempotencyDirectory: directory }),
      sdk
    );

    await expect(
      client.placeOrder({
        idempotencyKey: 'new-order-after-restart',
        marketId: '1234567890',
        side: 'buy',
        size: 1,
        price: 0.4,
      })
    ).rejects.toThrow(/ambiguous pre-restart/);
    expect(sdk.createAndPostOrder).not.toHaveBeenCalled();
  });

  it('reconciles a terminal pre-restart order before accepting a new one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'signed-clob-restart-'));
    const store = new FileOrderIdempotencyStore(directory);
    store.claim('old-submitted-order', {
      marketId: '1234567890',
      side: 'buy',
      size: 1,
      price: 0.4,
    });
    store.markSubmitted('old-submitted-order', 'old-exchange-order');
    const sdk = createSdk({
      getOrder: jest.fn().mockImplementation((orderId: string) =>
        Promise.resolve({
          id: orderId,
          asset_id: '1234567890',
          side: 'BUY',
          original_size: '1',
          size_matched: '1',
          price: '0.4',
          status: 'matched',
          created_at: 1_766_016_000,
        })
      ),
    });
    const client = new SignedClobTradingClient(
      createConfig({ idempotencyDirectory: directory }),
      sdk
    );

    await expect(
      client.placeOrder({
        idempotencyKey: 'new-order-after-terminal',
        marketId: '1234567890',
        side: 'buy',
        size: 1,
        price: 0.4,
      })
    ).resolves.toMatchObject({ status: 'filled' });
    expect(store.get('old-submitted-order')).toMatchObject({
      state: 'terminal',
      terminalStatus: 'filled',
    });
  });
});
