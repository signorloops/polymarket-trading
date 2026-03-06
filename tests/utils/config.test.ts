/**
 * Tests for config module — exported constants and helper functions.
 */

import {
  ALGORITHM_CONFIG,
  TRADING_CONFIG,
  NETWORK_CONFIG,
  LOG_CONFIG,
  KELLY_CONFIG,
  RISK_CONFIG,
  validateConfig,
  printConfigSummary,
} from '../../src/utils/config.js';

describe('config exports', () => {
  it('should export ALGORITHM_CONFIG with required fields', () => {
    expect(ALGORITHM_CONFIG).toBeDefined();
    expect(typeof ALGORITHM_CONFIG.ALPHA).toBe('number');
    expect(typeof ALGORITHM_CONFIG.MAX_ITERATIONS).toBe('number');
    expect(typeof ALGORITHM_CONFIG.INITIAL_EPSILON).toBe('number');
    expect(typeof ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD).toBe('number');
  });

  it('should export TRADING_CONFIG with required fields', () => {
    expect(TRADING_CONFIG).toBeDefined();
    expect(typeof TRADING_CONFIG.MAX_POSITION_PCT).toBe('number');
    expect(typeof TRADING_CONFIG.SLIPPAGE_TOLERANCE).toBe('number');
  });

  it('should export NETWORK_CONFIG with required fields', () => {
    expect(NETWORK_CONFIG).toBeDefined();
    expect(typeof NETWORK_CONFIG.WS_URL).toBe('string');
  });

  it('should export LOG_CONFIG with required fields', () => {
    expect(LOG_CONFIG).toBeDefined();
    expect(typeof LOG_CONFIG.LOG_LEVEL).toBe('string');
  });

  it('should export KELLY_CONFIG', () => {
    expect(KELLY_CONFIG).toBeDefined();
  });

  it('should export RISK_CONFIG', () => {
    expect(RISK_CONFIG).toBeDefined();
  });
});

describe('validateConfig', () => {
  it('should not throw', () => {
    expect(() => validateConfig()).not.toThrow();
  });
});

describe('printConfigSummary', () => {
  it('should not throw', () => {
    expect(() => printConfigSummary()).not.toThrow();
  });
});
