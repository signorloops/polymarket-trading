/**
 * Centralized configuration management
 * Loads environment variables and provides typed configuration
 */

import dotenv from 'dotenv';
import { getLogger } from './logger.js';

// Load environment variables
const result = dotenv.config();
if (result.error) {
  getLogger().warn('No .env file found, using default configuration');
}

/**
 * Algorithm parameters for Frank-Wolfe and Bregman projection
 */
export const ALGORITHM_CONFIG = {
  /** Alpha-extraction: capture at least (1 - ALPHA) of available arbitrage */
  ALPHA: parseFloat(process.env['ALPHA'] ?? '0.9'),

  /** Initial epsilon for barrier function shrinkage */
  INITIAL_EPSILON: parseFloat(process.env['INITIAL_EPSILON'] ?? '0.1'),

  /** Convergence threshold for stopping criterion */
  CONVERGENCE_THRESHOLD: parseFloat(process.env['CONVERGENCE_THRESHOLD'] ?? '1e-6'),

  /** Maximum iterations for Frank-Wolfe */
  MAX_ITERATIONS: parseInt(process.env['MAX_ITERATIONS'] ?? '150', 10),

  /** Minimum profit threshold in USD */
  MIN_PROFIT_THRESHOLD: parseFloat(process.env['MIN_PROFIT_THRESHOLD'] ?? '0.05'),

  /** Barrier function parameter for LMSR gradient handling */
  BARRIER_PARAMETER: parseFloat(process.env['BARRIER_PARAMETER'] ?? '1.0'),
} as const;

/**
 * Trading parameters
 */
export const TRADING_CONFIG = {
  /** Maximum position size as fraction of order book depth */
  MAX_POSITION_PCT: parseFloat(process.env['MAX_POSITION_PCT'] ?? '0.5'),

  /** Time window for trade validity in blocks (~1 hour) */
  TIME_WINDOW_BLOCKS: parseInt(process.env['TIME_WINDOW_BLOCKS'] ?? '950', 10),

  /** Slippage tolerance percentage */
  SLIPPAGE_TOLERANCE: parseFloat(process.env['SLIPPAGE_TOLERANCE'] ?? '0.02'),

  /** Maximum concurrent trades */
  MAX_CONCURRENT_TRADES: parseInt(process.env['MAX_CONCURRENT_TRADES'] ?? '5', 10),

  /** Minimum order book depth for trading */
  MIN_ORDER_BOOK_DEPTH: parseFloat(process.env['MIN_ORDER_BOOK_DEPTH'] ?? '100'),
} as const;

/**
 * Network and connection configuration
 */
export const NETWORK_CONFIG = {
  /** RPC URL for blockchain connection */
  RPC_URL: process.env['RPC_URL'] ?? '',

  /** WebSocket URL for real-time data */
  WS_URL: process.env['WS_URL'] ?? 'wss://ws.polymarket.com',

  /** API key for Polymarket */
  POLYMARKET_API_KEY: process.env['POLYMARKET_API_KEY'] ?? '',

  /** Connection timeout in milliseconds */
  CONNECTION_TIMEOUT: parseInt(process.env['CONNECTION_TIMEOUT'] ?? '30000', 10),

  /** Reconnect interval in milliseconds */
  RECONNECT_INTERVAL: parseInt(process.env['RECONNECT_INTERVAL'] ?? '5000', 10),

  /** Maximum reconnection attempts */
  MAX_RECONNECT_ATTEMPTS: parseInt(process.env['MAX_RECONNECT_ATTEMPTS'] ?? '10', 10),
} as const;

/**
 * Wallet configuration
 */
export const WALLET_CONFIG = {
  /** Private key (should be loaded from secure storage in production) */
  PRIVATE_KEY: process.env['PRIVATE_KEY'] ?? '',

  /** Wallet address */
  WALLET_ADDRESS: process.env['WALLET_ADDRESS'] ?? '',
} as const;

/**
 * Logging configuration
 */
export const LOG_CONFIG = {
  /** Log level: debug, info, warn, error */
  LOG_LEVEL: (process.env['LOG_LEVEL'] ?? 'info') as 'debug' | 'info' | 'warn' | 'error',

  /** Enable silent mode (no console output) */
  SILENT: process.env['SILENT'] === 'true',
} as const;

/**
 * Kelly criterion parameters for position sizing
 */
export const KELLY_CONFIG = {
  /** Kelly fraction multiplier (conservative: 0.25, aggressive: 0.5) */
  KELLY_FRACTION: parseFloat(process.env['KELLY_FRACTION'] ?? '0.25'),

  /** Minimum probability threshold for betting */
  MIN_PROBABILITY: parseFloat(process.env['MIN_PROBABILITY'] ?? '0.51'),

  /** Maximum bet size as fraction of capital */
  MAX_BET_FRACTION: parseFloat(process.env['MAX_BET_FRACTION'] ?? '0.1'),
} as const;

/**
 * Risk management configuration
 */
export const RISK_CONFIG = {
  /** Maximum daily loss in USD */
  MAX_DAILY_LOSS: parseFloat(process.env['MAX_DAILY_LOSS'] ?? '1000'),

  /** Maximum total exposure in USD */
  MAX_EXPOSURE: parseFloat(process.env['MAX_EXPOSURE'] ?? '10000'),

  /** Emergency stop threshold (unrealized loss) */
  EMERGENCY_STOP_THRESHOLD: parseFloat(process.env['EMERGENCY_STOP_THRESHOLD'] ?? '500'),

  /** Enable circuit breaker */
  CIRCUIT_BREAKER_ENABLED: process.env['CIRCUIT_BREAKER_ENABLED'] !== 'false',
} as const;

/**
 * Validate configuration
 * Throws error if required configuration is missing
 */
export function validateConfig(): void {
  const logger = getLogger();
  const errors: string[] = [];

  // Validate algorithm parameters
  if (ALGORITHM_CONFIG.ALPHA <= 0 || ALGORITHM_CONFIG.ALPHA >= 1) {
    errors.push('ALPHA must be between 0 and 1');
  }

  if (ALGORITHM_CONFIG.INITIAL_EPSILON <= 0) {
    errors.push('INITIAL_EPSILON must be positive');
  }

  if (ALGORITHM_CONFIG.MAX_ITERATIONS <= 0) {
    errors.push('MAX_ITERATIONS must be positive');
  }

  // Validate trading parameters
  if (TRADING_CONFIG.MAX_POSITION_PCT <= 0 || TRADING_CONFIG.MAX_POSITION_PCT > 1) {
    errors.push('MAX_POSITION_PCT must be between 0 and 1');
  }

  // Validate network configuration (only in production)
  if (process.env['NODE_ENV'] === 'production') {
    if (!NETWORK_CONFIG.RPC_URL) {
      errors.push('RPC_URL is required in production');
    }
    if (!NETWORK_CONFIG.POLYMARKET_API_KEY) {
      errors.push('POLYMARKET_API_KEY is required in production');
    }
    if (!WALLET_CONFIG.PRIVATE_KEY) {
      errors.push('PRIVATE_KEY is required in production');
    }
  }

  if (errors.length > 0) {
    logger.error('Configuration validation failed', { errors });
    throw new Error(`Configuration errors: ${errors.join(', ')}`);
  }

  logger.info('Configuration validated successfully');
}

/**
 * Print configuration summary (excluding sensitive values)
 */
export function printConfigSummary(): void {
  const logger = getLogger();

  logger.info('=== Configuration Summary ===');
  logger.info('Algorithm:', {
    alpha: ALGORITHM_CONFIG.ALPHA,
    initialEpsilon: ALGORITHM_CONFIG.INITIAL_EPSILON,
    maxIterations: ALGORITHM_CONFIG.MAX_ITERATIONS,
    minProfit: ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD,
  });
  logger.info('Trading:', {
    maxPositionPct: TRADING_CONFIG.MAX_POSITION_PCT,
    slippageTolerance: TRADING_CONFIG.SLIPPAGE_TOLERANCE,
    timeWindowBlocks: TRADING_CONFIG.TIME_WINDOW_BLOCKS,
  });
  logger.info('Network:', {
    rpcConfigured: !!NETWORK_CONFIG.RPC_URL,
    wsUrl: NETWORK_CONFIG.WS_URL,
    apiKeyConfigured: !!NETWORK_CONFIG.POLYMARKET_API_KEY,
  });
  logger.info('Wallet:', {
    addressConfigured: !!WALLET_CONFIG.WALLET_ADDRESS,
  });
  logger.info('===========================');
}
