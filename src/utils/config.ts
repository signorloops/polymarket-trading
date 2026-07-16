/**
 * Centralized configuration management
 * Loads environment variables and provides typed configuration
 *
 * This module now uses Zod schemas for runtime validation.
 * See config-schema.ts for schema definitions.
 */

import dotenv from 'dotenv';
import { getLogger } from './logger.js';
import { parseConfigFromEnv, createDefaultConfig, type AppConfig } from './config-schema.js';

// Load environment variables
const result = dotenv.config();
if (result.error) {
  getLogger().warn('No .env file found, using default configuration');
}

// Invalid environment values must always fail closed. Silently replacing the
// entire configuration with defaults can hide a typo in a canary or operator
// command and makes the process run with settings the operator never approved.
const config = parseConfigFromEnv();

/**
 * Algorithm parameters for Frank-Wolfe and Bregman projection
 */
export const ALGORITHM_CONFIG = config.algorithm;

/**
 * Trading parameters
 */
export const TRADING_CONFIG = config.trading;

/**
 * Network and connection configuration
 */
export const NETWORK_CONFIG = config.network;

/**
 * Wallet configuration
 */
export const WALLET_CONFIG = config.wallet;

/**
 * Logging configuration
 */
export const LOG_CONFIG = config.logging;

/**
 * Kelly criterion parameters for position sizing
 */
export const KELLY_CONFIG = config.kelly;

/**
 * Risk management configuration
 */
export const RISK_CONFIG = config.risk;

// Re-export config types and utilities
export { createDefaultConfig, parseConfigFromEnv, type AppConfig };

/**
 * Validate configuration
 * Throws error if required configuration is missing
 * Note: Now performed automatically during module load via Zod schemas
 */
export function validateConfig(): void {
  const logger = getLogger();
  // Config is already validated during parseConfigFromEnv()
  logger.info('Configuration validated successfully (via Zod)');
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
    polygonRpcConfigured: !!NETWORK_CONFIG.POLYGON_RPC_URL,
    wsUrl: NETWORK_CONFIG.WS_URL,
    apiKeyConfigured: !!NETWORK_CONFIG.POLYMARKET_API_KEY,
    clobChainId: NETWORK_CONFIG.POLYMARKET_CHAIN_ID,
    signatureType: NETWORK_CONFIG.POLYMARKET_SIGNATURE_TYPE,
    funderConfigured: !!NETWORK_CONFIG.POLYMARKET_FUNDER_ADDRESS,
  });
  logger.info('Wallet:', {
    addressConfigured: !!WALLET_CONFIG.WALLET_ADDRESS,
  });
  logger.info('Logging:', {
    level: LOG_CONFIG.LOG_LEVEL,
    structured: LOG_CONFIG.STRUCTURED_LOGGING,
  });
  logger.info('===========================');
}
