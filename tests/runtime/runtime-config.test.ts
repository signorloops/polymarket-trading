import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadTradingSystemConfigFromEnv,
  parseRuntimeServerConfigFromEnv,
  shouldReconcileOnStartup,
} from '../../src/runtime/runtime-config.js';

describe('loadTradingSystemConfigFromEnv', () => {
  it('loads trading system config from inline JSON', () => {
    const config = loadTradingSystemConfigFromEnv({
      TRADING_SYSTEM_CONFIG_JSON: JSON.stringify({
        liveTrading: false,
        markets: ['market-yes', 'market-no'],
        events: [
          {
            id: 'event-1',
            markets: [
              { id: 'market-yes', outcome: 'YES', price: 0.55 },
              { id: 'market-no', outcome: 'NO', price: 0.4 },
            ],
          },
        ],
      }),
    });

    expect(config.liveTrading).toBe(false);
    expect(config.markets).toEqual(['market-yes', 'market-no']);
    expect(config.events).toHaveLength(1);
  });

  it('loads trading system config from a file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polymarket-runtime-config-'));
    const configPath = join(dir, 'runtime-config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        liveTrading: false,
        markets: ['market-1'],
        events: [
          {
            id: 'event-1',
            markets: [{ id: 'market-1', outcome: 'YES', price: 0.5 }],
          },
        ],
      })
    );

    const config = loadTradingSystemConfigFromEnv({
      TRADING_SYSTEM_CONFIG_PATH: configPath,
    });

    expect(config.markets).toEqual(['market-1']);
    expect(config.events[0]?.id).toBe('event-1');
  });

  it('rejects daemon startup when runtime config is missing in all environments', () => {
    expect(() => loadTradingSystemConfigFromEnv({ NODE_ENV: 'production' })).toThrow(
      /TRADING_SYSTEM_CONFIG_JSON or TRADING_SYSTEM_CONFIG_PATH/
    );
    expect(() => loadTradingSystemConfigFromEnv({ NODE_ENV: 'development' })).toThrow(
      /TRADING_SYSTEM_CONFIG_JSON or TRADING_SYSTEM_CONFIG_PATH/
    );
  });

  it('rejects automatic live trading in runtime config', () => {
    expect(() =>
      loadTradingSystemConfigFromEnv({
        TRADING_SYSTEM_CONFIG_JSON: JSON.stringify({
          liveTrading: true,
          markets: ['market-1'],
          events: [
            {
              id: 'event-1',
              markets: [{ id: 'market-1', outcome: 'YES', price: 0.5 }],
            },
          ],
        }),
      })
    ).toThrow(/liveTrading=true is not supported/);
  });

  it('loads an explicit cross-market payoff model', () => {
    const config = loadTradingSystemConfigFromEnv({
      TRADING_SYSTEM_CONFIG_JSON: JSON.stringify({
        liveTrading: false,
        markets: ['a-yes', 'b-no'],
        events: [
          { id: 'event-a', markets: [{ id: 'a-yes', outcome: 'YES', price: 0.4 }] },
          { id: 'event-b', markets: [{ id: 'b-no', outcome: 'NO', price: 0.5 }] },
        ],
        payoffModels: [
          {
            id: 'a-implies-b',
            marketIds: ['a-yes', 'b-no'],
            feeBufferBps: 100,
            scenarios: [
              { id: 'both', payouts: [1, 0] },
              { id: 'a-only', payouts: [1, 1] },
              { id: 'neither', payouts: [0, 1] },
            ],
          },
        ],
      }),
    });

    expect(config.payoffModels?.[0]?.marketIds).toEqual(['a-yes', 'b-no']);
  });

  it('rejects incomplete or dimensionally inconsistent payoff models', () => {
    expect(() =>
      loadTradingSystemConfigFromEnv({
        TRADING_SYSTEM_CONFIG_JSON: JSON.stringify({
          liveTrading: false,
          markets: ['a-yes', 'b-no'],
          events: [
            { id: 'event-a', markets: [{ id: 'a-yes', outcome: 'YES', price: 0.4 }] },
            { id: 'event-b', markets: [{ id: 'b-no', outcome: 'NO', price: 0.5 }] },
          ],
          payoffModels: [
            {
              id: 'broken',
              marketIds: ['a-yes', 'unknown'],
              feeBufferBps: 100,
              scenarios: [
                { id: 'one', payouts: [1, 0] },
                { id: 'two', payouts: [1] },
              ],
            },
          ],
        }),
      })
    ).toThrow(/unknown market|wrong dimension/);
  });
});

describe('parseRuntimeServerConfigFromEnv', () => {
  it('uses safe HTTP defaults for the daemon server', () => {
    const config = parseRuntimeServerConfigFromEnv({});

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.riskStatusToken).toBeUndefined();
  });

  it('accepts an explicit bind address and risk endpoint token', () => {
    const config = parseRuntimeServerConfigFromEnv({
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: '3100',
      HTTP_RISK_STATUS_TOKEN: 'a-secure-risk-token',
      HTTP_METRICS_TOKEN: 'a-secure-metrics-token',
    });

    expect(config).toEqual({
      host: '0.0.0.0',
      port: 3100,
      riskStatusToken: 'a-secure-risk-token',
      metricsToken: 'a-secure-metrics-token',
    });
  });

  it('rejects a weak risk endpoint token', () => {
    expect(() => parseRuntimeServerConfigFromEnv({ HTTP_RISK_STATUS_TOKEN: 'short' })).toThrow();
  });

  it('requires metrics authentication on a non-loopback bind', () => {
    expect(() => parseRuntimeServerConfigFromEnv({ HTTP_HOST: '0.0.0.0' })).toThrow(
      /HTTP_METRICS_TOKEN is required/
    );
  });

  it('loads a metrics token from a mounted secret file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polymarket-metrics-secret-'));
    const tokenPath = join(dir, 'metrics-token');
    writeFileSync(tokenPath, 'mounted-metrics-token\n');

    expect(
      parseRuntimeServerConfigFromEnv({
        HTTP_HOST: '0.0.0.0',
        HTTP_METRICS_TOKEN_FILE: tokenPath,
      }).metricsToken
    ).toBe('mounted-metrics-token');
  });
});

describe('shouldReconcileOnStartup', () => {
  it('is explicit and rejects ambiguous boolean values', () => {
    expect(shouldReconcileOnStartup({})).toBe(false);
    expect(shouldReconcileOnStartup({ RECONCILE_ON_STARTUP: 'true' })).toBe(true);
    expect(() => shouldReconcileOnStartup({ RECONCILE_ON_STARTUP: 'yes' })).toThrow(
      /must be "true" or "false"/
    );
  });
});
