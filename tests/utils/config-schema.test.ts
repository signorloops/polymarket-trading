/**
 * Config Schema Tests
 */

import {
  AlgorithmConfigSchema,
  TradingConfigSchema,
  NetworkConfigSchema,
  LogConfigSchema,
  RiskConfigSchema,
  parseConfigFromEnv,
  createDefaultConfig,
} from '../../src/utils/config-schema.js';

describe('AlgorithmConfigSchema', () => {
  it('should validate valid config', () => {
    const config = AlgorithmConfigSchema.parse({
      ALPHA: 0.9,
      MAX_ITERATIONS: 150,
    });

    expect(config.ALPHA).toBe(0.9);
    expect(config.MAX_ITERATIONS).toBe(150);
  });

  it('should use defaults', () => {
    const config = AlgorithmConfigSchema.parse({});

    expect(config.ALPHA).toBe(0.9);
    expect(config.INITIAL_EPSILON).toBe(0.1);
    expect(config.MIN_PROFIT_THRESHOLD).toBe(0.05);
  });

  it('should reject invalid ALPHA', () => {
    expect(() => AlgorithmConfigSchema.parse({ ALPHA: 1.5 })).toThrow();
    expect(() => AlgorithmConfigSchema.parse({ ALPHA: -0.1 })).toThrow();
  });

  it('should reject negative MAX_ITERATIONS', () => {
    expect(() => AlgorithmConfigSchema.parse({ MAX_ITERATIONS: -1 })).toThrow();
  });
});

describe('TradingConfigSchema', () => {
  it('should validate valid config', () => {
    const config = TradingConfigSchema.parse({
      MAX_POSITION_PCT: 0.5,
      SLIPPAGE_TOLERANCE: 0.02,
    });

    expect(config.MAX_POSITION_PCT).toBe(0.5);
    expect(config.SLIPPAGE_TOLERANCE).toBe(0.02);
  });

  it('should reject MAX_POSITION_PCT > 1', () => {
    expect(() => TradingConfigSchema.parse({ MAX_POSITION_PCT: 1.5 })).toThrow();
  });
});

describe('NetworkConfigSchema', () => {
  it('should validate valid URLs', () => {
    const config = NetworkConfigSchema.parse({
      POLYGON_RPC_URL: 'https://rpc.example.com',
      WS_URL: 'wss://ws.example.com',
    });

    expect(config.POLYGON_RPC_URL).toBe('https://rpc.example.com');
    expect(config.WS_URL).toBe('wss://ws.example.com');
  });

  it('should reject invalid URLs', () => {
    expect(() => NetworkConfigSchema.parse({ POLYGON_RPC_URL: 'not-a-url' })).toThrow();
  });

  it('should use default WS_URL', () => {
    const config = NetworkConfigSchema.parse({});
    expect(config.WS_URL).toBe('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  });

  it('should use safe CLOB signing defaults', () => {
    const config = NetworkConfigSchema.parse({});

    expect(config.POLYMARKET_CHAIN_ID).toBe(137);
    expect(config.POLYMARKET_SIGNATURE_TYPE).toBe(0);
    expect(config.POLYMARKET_FUNDER_ADDRESS).toBeUndefined();
    expect(config.POLYMARKET_DEFAULT_TICK_SIZE).toBeUndefined();
    expect(config.POLYMARKET_NEG_RISK).toBeUndefined();
  });
});

describe('LogConfigSchema', () => {
  it('should accept valid log levels', () => {
    expect(LogConfigSchema.parse({ LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug');
    expect(LogConfigSchema.parse({ LOG_LEVEL: 'info' }).LOG_LEVEL).toBe('info');
    expect(LogConfigSchema.parse({ LOG_LEVEL: 'warn' }).LOG_LEVEL).toBe('warn');
    expect(LogConfigSchema.parse({ LOG_LEVEL: 'error' }).LOG_LEVEL).toBe('error');
  });

  it('should reject invalid log level', () => {
    expect(() => LogConfigSchema.parse({ LOG_LEVEL: 'invalid' })).toThrow();
  });

  it('should parse SILENT boolean', () => {
    expect(LogConfigSchema.parse({ SILENT: true }).SILENT).toBe(true);
    expect(LogConfigSchema.parse({ SILENT: false }).SILENT).toBe(false);
  });
});

describe('RiskConfigSchema', () => {
  it('should validate positive numbers', () => {
    const config = RiskConfigSchema.parse({
      MAX_DAILY_LOSS: 1000,
      MAX_EXPOSURE: 10000,
    });

    expect(config.MAX_DAILY_LOSS).toBe(1000);
    expect(config.MAX_EXPOSURE).toBe(10000);
  });

  it('should reject negative values', () => {
    expect(() => RiskConfigSchema.parse({ MAX_DAILY_LOSS: -100 })).toThrow();
  });
});

describe('createDefaultConfig', () => {
  it('should create complete config with defaults', () => {
    const config = createDefaultConfig();

    expect(config.algorithm).toBeDefined();
    expect(config.trading).toBeDefined();
    expect(config.network).toBeDefined();
    expect(config.wallet).toBeDefined();
    expect(config.logging).toBeDefined();
    expect(config.kelly).toBeDefined();
    expect(config.risk).toBeDefined();
  });

  it('should have valid algorithm defaults', () => {
    const config = createDefaultConfig();

    expect(config.algorithm.ALPHA).toBeGreaterThan(0);
    expect(config.algorithm.ALPHA).toBeLessThan(1);
    expect(config.algorithm.MAX_ITERATIONS).toBeGreaterThan(0);
  });
});

describe('parseConfigFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should parse environment variables', () => {
    process.env.ALPHA = '0.8';
    process.env.MAX_ITERATIONS = '100';
    process.env.LOG_LEVEL = 'debug';

    const config = parseConfigFromEnv();

    expect(config.algorithm.ALPHA).toBe(0.8);
    expect(config.algorithm.MAX_ITERATIONS).toBe(100);
    expect(config.logging.LOG_LEVEL).toBe('debug');
  });

  it('should use defaults for missing vars', () => {
    delete process.env.ALPHA;
    delete process.env.LOG_LEVEL;

    const config = parseConfigFromEnv();

    expect(config.algorithm.ALPHA).toBe(0.9);
    expect(config.logging.LOG_LEVEL).toBe('info');
  });

  it('should treat empty optional secret and wallet env vars as unset', () => {
    process.env.PRIVATE_KEY = '';
    process.env.WALLET_ADDRESS = '';
    process.env.POLYMARKET_API_KEY = '';
    process.env.POLYMARKET_SECRET = '';
    process.env.POLYMARKET_PASSPHRASE = '';
    process.env.POLYMARKET_FUNDER_ADDRESS = '';
    process.env.POLYMARKET_DEFAULT_TICK_SIZE = '';
    process.env.POLYMARKET_NEG_RISK = '';

    const config = parseConfigFromEnv();

    expect(config.wallet.PRIVATE_KEY).toBeUndefined();
    expect(config.wallet.WALLET_ADDRESS).toBeUndefined();
    expect(config.network.POLYMARKET_API_KEY).toBeUndefined();
    expect(config.network.POLYMARKET_SECRET).toBeUndefined();
    expect(config.network.POLYMARKET_PASSPHRASE).toBeUndefined();
    expect(config.network.POLYMARKET_FUNDER_ADDRESS).toBeUndefined();
    expect(config.network.POLYMARKET_DEFAULT_TICK_SIZE).toBeUndefined();
    expect(config.network.POLYMARKET_NEG_RISK).toBeUndefined();
  });

  it('should parse CLOB signing environment variables', () => {
    process.env.POLYMARKET_CHAIN_ID = '80002';
    process.env.POLYMARKET_SIGNATURE_TYPE = '2';
    process.env.POLYMARKET_FUNDER_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.POLYMARKET_DEFAULT_TICK_SIZE = '0.001';
    process.env.POLYMARKET_NEG_RISK = 'true';

    const config = parseConfigFromEnv();

    expect(config.network.POLYMARKET_CHAIN_ID).toBe(80002);
    expect(config.network.POLYMARKET_SIGNATURE_TYPE).toBe(2);
    expect(config.network.POLYMARKET_FUNDER_ADDRESS).toBe(
      '0x1111111111111111111111111111111111111111'
    );
    expect(config.network.POLYMARKET_DEFAULT_TICK_SIZE).toBe('0.001');
    expect(config.network.POLYMARKET_NEG_RISK).toBe(true);
  });

  it('should reject invalid CLOB boolean environment variables', () => {
    process.env.POLYMARKET_NEG_RISK = 'yes';

    expect(() => parseConfigFromEnv()).toThrow(/POLYMARKET_NEG_RISK/);
  });

  it('should reject numeric environment values with trailing junk', () => {
    process.env.MAX_ITERATIONS = '150oops';

    expect(() => parseConfigFromEnv()).toThrow();
  });

  it('should reject misspelled boolean environment values', () => {
    process.env.CIRCUIT_BREAKER_ENABLED = 'tru';

    expect(() => parseConfigFromEnv()).toThrow(/CIRCUIT_BREAKER_ENABLED/);
  });
});
