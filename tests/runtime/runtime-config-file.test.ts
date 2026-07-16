import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  summarizeTradingSystemConfig,
  validateTradingSystemConfigFile,
  writeExampleTradingSystemConfig,
} from '../../src/runtime/runtime-config.js';

describe('writeExampleTradingSystemConfig', () => {
  it('writes a reusable daemon config template to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polymarket-runtime-config-file-'));
    const targetPath = join(dir, 'trading-system.json');

    const config = writeExampleTradingSystemConfig(targetPath);

    expect(existsSync(targetPath)).toBe(true);
    expect(config.liveTrading).toBe(false);
    expect(config.markets.length).toBeGreaterThan(0);
    expect(config.events.length).toBeGreaterThan(0);
  });

  it('refuses to overwrite an existing config without force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polymarket-runtime-config-file-'));
    const targetPath = join(dir, 'trading-system.json');
    writeFileSync(
      targetPath,
      '{"liveTrading":false,"markets":["m1"],"events":[{"id":"e1","markets":[{"id":"m1","outcome":"YES","price":0.5}]}]}'
    );

    expect(() => writeExampleTradingSystemConfig(targetPath)).toThrow(/already exists/);
  });

  it('overwrites an existing config when force=true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polymarket-runtime-config-file-'));
    const targetPath = join(dir, 'trading-system.json');
    writeFileSync(targetPath, '{"invalid":true}');

    const config = writeExampleTradingSystemConfig(targetPath, { force: true });

    expect(config.events[0]?.id).toBe('sample-event');
  });
});

describe('validateTradingSystemConfigFile', () => {
  it('validates a generated config file and returns a summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polymarket-runtime-config-file-'));
    const targetPath = join(dir, 'trading-system.json');
    writeExampleTradingSystemConfig(targetPath);

    const result = validateTradingSystemConfigFile(targetPath);

    expect(result.path).toBe(targetPath);
    expect(result.summary).toEqual({
      liveTrading: false,
      configuredMarkets: 2,
      configuredEvents: 1,
    });
  });

  it('rejects invalid daemon config files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polymarket-runtime-config-file-'));
    const targetPath = join(dir, 'trading-system.json');
    writeFileSync(
      targetPath,
      JSON.stringify({
        liveTrading: false,
        markets: ['market-1'],
        events: [
          {
            id: 'event-1',
            markets: [{ id: 'missing-market', outcome: 'YES', price: 0.5 }],
          },
        ],
      })
    );

    expect(() => validateTradingSystemConfigFile(targetPath)).toThrow(
      /missing from the top-level markets list/
    );
  });
});

describe('summarizeTradingSystemConfig', () => {
  it('summarizes the daemon config for operator output', () => {
    expect(
      summarizeTradingSystemConfig({
        liveTrading: false,
        markets: ['m1', 'm2', 'm3'],
        events: [
          {
            id: 'event-1',
            markets: [{ id: 'm1', outcome: 'YES', price: 0.4 }],
          },
          {
            id: 'event-2',
            markets: [
              { id: 'm2', outcome: 'YES', price: 0.6 },
              { id: 'm3', outcome: 'NO', price: 0.3 },
            ],
          },
        ],
      })
    ).toEqual({
      liveTrading: false,
      configuredMarkets: 3,
      configuredEvents: 2,
    });
  });
});
