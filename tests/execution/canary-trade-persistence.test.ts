import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CanaryTradePersistence,
  type CanaryTradeRecord,
} from '../../src/execution/canary-trade-persistence.js';

describe('CanaryTradePersistence', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trade-'));
    statePath = path.join(tempDir, 'canary-trades.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists and reloads canary trade records', () => {
    const persistence = new CanaryTradePersistence(statePath);
    const record: CanaryTradeRecord = {
      runId: 'canary-1',
      requestedAt: 1_000,
      updatedAt: 2_000,
      dryRun: false,
      submitted: true,
      tokenId: '1234567890',
      side: 'buy',
      size: 1,
      price: 0.01,
      notionalUsd: 0.01,
      orderId: '0xorder',
      status: 'filled',
    };

    persistence.saveRecord(record);

    const restored = new CanaryTradePersistence(statePath).loadRecords();
    expect(restored).toEqual([record]);
  });

  it('updates existing records by run id instead of duplicating them', () => {
    const persistence = new CanaryTradePersistence(statePath);
    const baseRecord: CanaryTradeRecord = {
      runId: 'canary-1',
      requestedAt: 1_000,
      updatedAt: 2_000,
      dryRun: false,
      submitted: true,
      tokenId: '1234567890',
      side: 'buy',
      size: 1,
      price: 0.01,
      notionalUsd: 0.01,
      orderId: '0xorder',
      status: 'open',
    };

    persistence.saveRecord(baseRecord);
    persistence.saveRecord({ ...baseRecord, updatedAt: 3_000, status: 'filled' });

    expect(persistence.loadRecords()).toEqual([
      { ...baseRecord, updatedAt: 3_000, status: 'filled' },
    ]);
  });

  it('fails visibly when an existing state file is corrupt or empty', () => {
    fs.writeFileSync(statePath, '{not-json', 'utf8');
    expect(() => new CanaryTradePersistence(statePath).loadRecords()).toThrow(
      /Failed to load canary trade state/
    );

    fs.writeFileSync(statePath, '', 'utf8');
    expect(() => new CanaryTradePersistence(statePath).loadRecords()).toThrow(
      /state file is empty/
    );
  });

  it('throws when state cannot be persisted', () => {
    const parentAsFile = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(parentAsFile, 'blocker', 'utf8');
    const persistence = new CanaryTradePersistence(path.join(parentAsFile, 'state.json'));

    expect(() =>
      persistence.saveRecord({
        runId: 'canary-write-failure',
        requestedAt: 1,
        updatedAt: 1,
        dryRun: true,
        submitted: false,
        tokenId: '1234567890',
        side: 'buy',
        size: 1,
        price: 0.1,
        notionalUsd: 0.1,
        status: 'dry-run',
      })
    ).toThrow(/Failed to persist canary trade state/);
  });
});
