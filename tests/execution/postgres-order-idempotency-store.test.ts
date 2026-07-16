import { newDb } from 'pg-mem';

import type { OrderRequest } from '../../src/api/polymarket-client.js';
import {
  PostgresOrderIdempotencyStore,
  type PgPoolLike,
} from '../../src/execution/postgres-order-idempotency-store.js';

const order: OrderRequest = {
  idempotencyKey: 'logical-order-0001',
  marketId: '123',
  side: 'buy',
  size: 10,
  price: 0.45,
  orderType: 'limit',
  timeInForce: 'GTC',
};

describe('PostgresOrderIdempotencyStore', () => {
  function createStores(count = 1): {
    stores: PostgresOrderIdempotencyStore[];
    pools: PgPoolLike[];
  } {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pools = Array.from({ length: count }, () => new adapter.Pool() as unknown as PgPoolLike);
    return {
      pools,
      stores: pools.map(
        (pool, index) =>
          new PostgresOrderIdempotencyStore(
            {
              connectionString: 'postgres://test:test@localhost:5432/test',
              initializeSchema: index === 0,
            },
            pool
          )
      ),
    };
  }

  it('claims once across independent process stores sharing a database', async () => {
    const { stores, pools } = createStores(2);
    // Initialize both store instances before racing claims. Real PostgreSQL also
    // permits concurrent CREATE TABLE IF NOT EXISTS; pg-mem does not model that DDL race.
    await stores[0]!.listUnresolved();
    await stores[1]!.listUnresolved();
    const results = await Promise.allSettled([
      stores[0]!.claim('logical-order-0001', order),
      stores[1]!.claim('logical-order-0001', order),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: expect.stringMatching(/Duplicate logical order/),
      }),
    });
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('persists compare-and-set state transitions and hides terminal records', async () => {
    const { stores, pools } = createStores();
    const store = stores[0]!;

    await expect(store.claim('logical-order-0002', order)).resolves.toMatchObject({
      key: 'logical-order-0002',
      state: 'claimed',
    });
    await store.markSubmitted('logical-order-0002', 'exchange-order-1');
    await expect(store.get('logical-order-0002')).resolves.toMatchObject({
      state: 'submitted',
      exchangeOrderId: 'exchange-order-1',
    });
    await expect(store.listUnresolved()).resolves.toHaveLength(1);

    await store.markTerminal('logical-order-0002', 'filled');
    await expect(store.get('logical-order-0002')).resolves.toMatchObject({
      state: 'terminal',
      terminalStatus: 'filled',
    });
    await expect(store.listUnresolved()).resolves.toEqual([]);
    await expect(store.markTerminal('logical-order-0002', 'cancelled')).rejects.toThrow(
      /Cannot mark terminal/
    );
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('records ambiguous failures without allowing a later submission transition', async () => {
    const { stores, pools } = createStores();
    const store = stores[0]!;
    await store.claim('logical-order-0003', order);

    await store.markUnknown('logical-order-0003', new Error('network outcome unknown'));

    await expect(store.get('logical-order-0003')).resolves.toMatchObject({
      state: 'unknown',
      lastError: 'network outcome unknown',
    });
    await expect(store.markSubmitted('logical-order-0003', 'exchange-order-2')).rejects.toThrow(
      /Cannot mark unknown/
    );
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('detects reuse of a logical key with a different request body', async () => {
    const { stores, pools } = createStores();
    const store = stores[0]!;
    await store.claim('logical-order-0004', order);

    await expect(store.claim('logical-order-0004', { ...order, price: 0.46 })).rejects.toThrow(
      /requestHash=mismatch/
    );
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('validates the database connection scheme before creating a pool', () => {
    expect(
      () => new PostgresOrderIdempotencyStore({ connectionString: 'https://db.example.com' })
    ).toThrow(/postgres:\/\//);
  });
});
