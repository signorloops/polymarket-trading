/**
 * Configuration schema using Zod for type-safe validation
 *
 * Provides runtime validation and type inference for all configuration options.
 * This ensures configuration errors are caught early with clear error messages.
 */

import { z } from 'zod';

/**
 * Algorithm configuration schema
 * Controls Frank-Wolfe and Bregman projection parameters
 */
export const AlgorithmConfigSchema = z.object({
  /** Alpha-extraction: capture at least (1 - ALPHA) of available arbitrage (0-1) */
  ALPHA: z.number().min(0).max(1).default(0.9),

  /** Initial epsilon for barrier function shrinkage */
  INITIAL_EPSILON: z.number().positive().default(0.1),

  /** Convergence threshold for stopping criterion */
  CONVERGENCE_THRESHOLD: z.number().positive().default(1e-6),

  /** Maximum iterations for Frank-Wolfe */
  MAX_ITERATIONS: z.number().int().positive().default(150),

  /** Minimum guaranteed-profit threshold (divergence units) */
  MIN_PROFIT_THRESHOLD: z.number().nonnegative().default(0.05),

  /** Barrier function parameter for LMSR gradient handling */
  BARRIER_PARAMETER: z.number().positive().default(1.0),
});

export type AlgorithmConfig = z.infer<typeof AlgorithmConfigSchema>;

/**
 * Trading configuration schema
 * Controls order execution and position sizing
 */
export const TradingConfigSchema = z.object({
  /** Maximum position size as fraction of order book depth (0-1) */
  MAX_POSITION_PCT: z.number().min(0).max(1).default(0.5),

  /** Time window for trade validity in blocks (~1 hour) */
  TIME_WINDOW_BLOCKS: z.number().int().positive().default(950),

  /** Slippage tolerance percentage */
  SLIPPAGE_TOLERANCE: z.number().nonnegative().default(0.02),

  /** Maximum concurrent trades */
  MAX_CONCURRENT_TRADES: z.number().int().positive().default(5),

  /** Minimum order book depth for trading */
  MIN_ORDER_BOOK_DEPTH: z.number().positive().default(100),
});

export type TradingConfig = z.infer<typeof TradingConfigSchema>;

/**
 * Network configuration schema
 * API endpoints and connection settings
 */
export const NetworkConfigSchema = z.object({
  /** RPC URL for blockchain connection */
  RPC_URL: z.string().url().optional(),

  /** WebSocket URL for real-time data */
  WS_URL: z.string().url().default('wss://ws.polymarket.com'),

  /** API key for Polymarket */
  POLYMARKET_API_KEY: z.string().optional(),

  /** API secret for Polymarket (used for request signing) */
  POLYMARKET_SECRET: z.string().optional(),

  /** API passphrase for Polymarket (used for request signing) */
  POLYMARKET_PASSPHRASE: z.string().optional(),

  /** Connection timeout in milliseconds */
  CONNECTION_TIMEOUT: z.number().int().positive().default(30000),

  /** Reconnect interval in milliseconds */
  RECONNECT_INTERVAL: z.number().int().positive().default(5000),

  /** Maximum reconnection attempts */
  MAX_RECONNECT_ATTEMPTS: z.number().int().nonnegative().default(10),
});

export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

/**
 * Wallet configuration schema
 * Trading wallet settings (sensitive)
 */
export const WalletConfigSchema = z.object({
  /** Private key (hex string with or without 0x prefix) */
  PRIVATE_KEY: z
    .string()
    .regex(/^0x?[a-fA-F0-9]{64}$/)
    .optional(),

  /** Wallet address */
  WALLET_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
});

export type WalletConfig = z.infer<typeof WalletConfigSchema>;

/**
 * Logging configuration schema
 */
export const LogConfigSchema = z.object({
  /** Log level */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Enable silent mode (no console output) */
  SILENT: z.boolean().default(false),

  /** Enable structured JSON logging */
  STRUCTURED_LOGGING: z.boolean().default(false),
});

export type LogConfig = z.infer<typeof LogConfigSchema>;

/**
 * Kelly criterion configuration schema
 * Position sizing parameters
 */
export const KellyConfigSchema = z.object({
  /** Kelly fraction multiplier (conservative: 0.25, aggressive: 0.5) */
  KELLY_FRACTION: z.number().min(0).max(1).default(0.25),

  /** Minimum probability threshold for betting */
  MIN_PROBABILITY: z.number().min(0).max(1).default(0.51),

  /** Maximum bet size as fraction of capital */
  MAX_BET_FRACTION: z.number().min(0).max(1).default(0.1),
});

export type KellyConfig = z.infer<typeof KellyConfigSchema>;

/**
 * Risk management configuration schema
 */
export const RiskConfigSchema = z.object({
  /** Maximum daily loss in USD */
  MAX_DAILY_LOSS: z.number().positive().default(1000),

  /** Maximum total exposure in USD */
  MAX_EXPOSURE: z.number().positive().default(10000),

  /** Emergency stop threshold (unrealized loss) */
  EMERGENCY_STOP_THRESHOLD: z.number().positive().default(500),

  /** Enable circuit breaker */
  CIRCUIT_BREAKER_ENABLED: z.boolean().default(true),
});

export type RiskConfig = z.infer<typeof RiskConfigSchema>;

/**
 * Complete application configuration schema
 */
export const AppConfigSchema = z.object({
  algorithm: AlgorithmConfigSchema,
  trading: TradingConfigSchema,
  network: NetworkConfigSchema,
  wallet: WalletConfigSchema,
  logging: LogConfigSchema,
  kelly: KellyConfigSchema,
  risk: RiskConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Parse environment variables into typed configuration
 */
export function parseConfigFromEnv(): AppConfig {
  return {
    algorithm: AlgorithmConfigSchema.parse({
      ALPHA: parseFloat(process.env.ALPHA ?? '0.9'),
      INITIAL_EPSILON: parseFloat(process.env.INITIAL_EPSILON ?? '0.1'),
      CONVERGENCE_THRESHOLD: parseFloat(process.env.CONVERGENCE_THRESHOLD ?? '1e-6'),
      MAX_ITERATIONS: parseInt(process.env.MAX_ITERATIONS ?? '150', 10),
      MIN_PROFIT_THRESHOLD: parseFloat(process.env.MIN_PROFIT_THRESHOLD ?? '0.05'),
      BARRIER_PARAMETER: parseFloat(process.env.BARRIER_PARAMETER ?? '1.0'),
    }),
    trading: TradingConfigSchema.parse({
      MAX_POSITION_PCT: parseFloat(process.env.MAX_POSITION_PCT ?? '0.5'),
      TIME_WINDOW_BLOCKS: parseInt(process.env.TIME_WINDOW_BLOCKS ?? '950', 10),
      SLIPPAGE_TOLERANCE: parseFloat(process.env.SLIPPAGE_TOLERANCE ?? '0.02'),
      MAX_CONCURRENT_TRADES: parseInt(process.env.MAX_CONCURRENT_TRADES ?? '5', 10),
      MIN_ORDER_BOOK_DEPTH: parseFloat(process.env.MIN_ORDER_BOOK_DEPTH ?? '100'),
    }),
    network: NetworkConfigSchema.parse({
      RPC_URL: process.env.RPC_URL,
      WS_URL: process.env.WS_URL,
      POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY,
      POLYMARKET_SECRET: process.env.POLYMARKET_SECRET,
      POLYMARKET_PASSPHRASE: process.env.POLYMARKET_PASSPHRASE,
      CONNECTION_TIMEOUT: parseInt(process.env.CONNECTION_TIMEOUT ?? '30000', 10),
      RECONNECT_INTERVAL: parseInt(process.env.RECONNECT_INTERVAL ?? '5000', 10),
      MAX_RECONNECT_ATTEMPTS: parseInt(process.env.MAX_RECONNECT_ATTEMPTS ?? '10', 10),
    }),
    wallet: WalletConfigSchema.parse({
      PRIVATE_KEY: process.env.PRIVATE_KEY,
      WALLET_ADDRESS: process.env.WALLET_ADDRESS,
    }),
    logging: LogConfigSchema.parse({
      LOG_LEVEL: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
      SILENT: process.env.SILENT === 'true',
      STRUCTURED_LOGGING: process.env.STRUCTURED_LOGGING === 'true',
    }),
    kelly: KellyConfigSchema.parse({
      KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION ?? '0.25'),
      MIN_PROBABILITY: parseFloat(process.env.MIN_PROBABILITY ?? '0.51'),
      MAX_BET_FRACTION: parseFloat(process.env.MAX_BET_FRACTION ?? '0.1'),
    }),
    risk: RiskConfigSchema.parse({
      MAX_DAILY_LOSS: parseFloat(process.env.MAX_DAILY_LOSS ?? '1000'),
      MAX_EXPOSURE: parseFloat(process.env.MAX_EXPOSURE ?? '10000'),
      EMERGENCY_STOP_THRESHOLD: parseFloat(process.env.EMERGENCY_STOP_THRESHOLD ?? '500'),
      CIRCUIT_BREAKER_ENABLED: process.env.CIRCUIT_BREAKER_ENABLED !== 'false',
    }),
  };
}

/**
 * Create default configuration (for testing/development)
 */
export function createDefaultConfig(): AppConfig {
  return {
    algorithm: AlgorithmConfigSchema.parse({}),
    trading: TradingConfigSchema.parse({}),
    network: NetworkConfigSchema.parse({}),
    wallet: WalletConfigSchema.parse({}),
    logging: LogConfigSchema.parse({}),
    kelly: KellyConfigSchema.parse({}),
    risk: RiskConfigSchema.parse({}),
  };
}
