import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileOrderIdempotencyStore } from '../../src/execution/order-idempotency-store.js';

describe('FileOrderIdempotencyStore', () => {
  it('atomically blocks the same logical order across store instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'polymarket-order-idempotency-'));
    const first = new FileOrderIdempotencyStore(directory);
    const second = new FileOrderIdempotencyStore(directory);
    const order = {
      idempotencyKey: 'logical-order-123',
      marketId: 'token-1',
      side: 'buy' as const,
      size: 1,
      price: 0.4,
      orderType: 'limit' as const,
    };

    first.claim('logical-order-123', order);

    expect(() => second.claim('logical-order-123', order)).toThrow(/Duplicate logical order/);
  });

  it('persists accepted and ambiguous outcomes for restart reconciliation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'polymarket-order-idempotency-'));
    const store = new FileOrderIdempotencyStore(directory);
    const order = {
      marketId: 'token-1',
      side: 'buy' as const,
      size: 1,
      price: 0.4,
    };

    store.claim('submitted-order', order);
    store.markSubmitted('submitted-order', 'exchange-1');
    expect(new FileOrderIdempotencyStore(directory).get('submitted-order')).toMatchObject({
      state: 'submitted',
      exchangeOrderId: 'exchange-1',
    });

    store.claim('ambiguous-order', order);
    store.markUnknown('ambiguous-order', new Error('socket reset'));
    expect(new FileOrderIdempotencyStore(directory).get('ambiguous-order')).toMatchObject({
      state: 'unknown',
      lastError: 'socket reset',
    });
  });

  it('fails closed when the journal is corrupt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'polymarket-order-idempotency-'));
    const store = new FileOrderIdempotencyStore(directory);
    const order = { marketId: 'token-1', side: 'buy' as const, size: 1, price: 0.4 };
    store.claim('corrupt-order', order);

    const [recordFile] = readdirSync(directory);
    expect(recordFile).toBeDefined();
    writeFileSync(join(directory, recordFile!), '{broken', 'utf8');

    expect(() => store.get('corrupt-order')).toThrow(/Failed to read order idempotency record/);
    expect(() => store.claim('corrupt-order', order)).toThrow(
      /Failed to read order idempotency record/
    );
  });
});
