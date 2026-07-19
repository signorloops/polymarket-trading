/**
 * Configuration schema using Zod for type-safe validation
 *
 * Provides runtime validation and type inference for all configuration options.
 * This ensures configuration errors are caught early with clear error messages.
 */

import { z } from 'zod';

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalNumberEnv(name: string): number | undefined {
  const value = optionalEnv(name);
  return value === undefined ? undefined : Number(value);
}

function optionalBooleanEnv(name: string): boolean | undefined {
  const value = optionalEnv(name);
  if (value === undefined) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be "true" or "false" when provided`);
}

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

  /** Minimum KL incoherence lower-bound threshold (nats), not USD profit */
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
  /** Polygon mainnet RPC used only for read-only onchain balance reconciliation. */
  POLYGON_RPC_URL: z.string().url().optional(),

  /** WebSocket URL for real-time data */
  WS_URL: z.string().url().default('wss://ws-subscriptions-clob.polymarket.com/ws/market'),

  /** API key for Polymarket */
  POLYMARKET_API_KEY: z.string().optional(),

  /** API secret for Polymarket (used for request signing) */
  POLYMARKET_SECRET: z.string().optional(),

  /** API passphrase for Polymarket (used for request signing) */
  POLYMARKET_PASSPHRASE: z.string().optional(),

  /** Polygon chain id for CLOB signing */
  POLYMARKET_CHAIN_ID: z.union([z.literal(137), z.literal(80002)]).default(137),

  /** Signature type: 0=EOA, 1=Proxy, 2=Gnosis Safe, 3=EIP-1271 contract wallet */
  POLYMARKET_SIGNATURE_TYPE: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .default(0),

  /** Polymarket profile/proxy funder address, required for proxy wallet modes */
  POLYMARKET_FUNDER_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),

  /** Optional default order tick size; omitted lets the SDK fetch market metadata */
  POLYMARKET_DEFAULT_TICK_SIZE: z.enum(['0.1', '0.01', '0.001', '0.0001']).optional(),

  /** Optional negative-risk override; omitted lets the SDK fetch market metadata */
  POLYMARKET_NEG_RISK: z.boolean().optional(),

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
const WalletConfigSchema = z.object({
  /** Private key (hex string with or without 0x prefix) */
  PRIVATE_KEY: z
    .string()
    .regex(/^0x?[a-fA-F0-9]{64}$/)
    .optional(),

  /** Wallet address */
  WALLET_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
});

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
const KellyConfigSchema = z.object({
  /** Kelly fraction multiplier (conservative: 0.25, aggressive: 0.5) */
  KELLY_FRACTION: z.number().min(0).max(1).default(0.25),

  /** Minimum probability threshold for betting */
  MIN_PROBABILITY: z.number().min(0).max(1).default(0.51),

  /** Maximum bet size as fraction of capital */
  MAX_BET_FRACTION: z.number().min(0).max(1).default(0.1),
});

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
      ALPHA: optionalNumberEnv('ALPHA'),
      INITIAL_EPSILON: optionalNumberEnv('INITIAL_EPSILON'),
      CONVERGENCE_THRESHOLD: optionalNumberEnv('CONVERGENCE_THRESHOLD'),
      MAX_ITERATIONS: optionalNumberEnv('MAX_ITERATIONS'),
      MIN_PROFIT_THRESHOLD: optionalNumberEnv('MIN_PROFIT_THRESHOLD'),
      BARRIER_PARAMETER: optionalNumberEnv('BARRIER_PARAMETER'),
    }),
    trading: TradingConfigSchema.parse({
      MAX_POSITION_PCT: optionalNumberEnv('MAX_POSITION_PCT'),
      TIME_WINDOW_BLOCKS: optionalNumberEnv('TIME_WINDOW_BLOCKS'),
      SLIPPAGE_TOLERANCE: optionalNumberEnv('SLIPPAGE_TOLERANCE'),
      MAX_CONCURRENT_TRADES: optionalNumberEnv('MAX_CONCURRENT_TRADES'),
      MIN_ORDER_BOOK_DEPTH: optionalNumberEnv('MIN_ORDER_BOOK_DEPTH'),
    }),
    network: NetworkConfigSchema.parse({
      POLYGON_RPC_URL: optionalEnv('POLYGON_RPC_URL'),
      WS_URL: optionalEnv('WS_URL'),
      POLYMARKET_API_KEY: optionalEnv('POLYMARKET_API_KEY'),
      POLYMARKET_SECRET: optionalEnv('POLYMARKET_SECRET'),
      POLYMARKET_PASSPHRASE: optionalEnv('POLYMARKET_PASSPHRASE'),
      POLYMARKET_CHAIN_ID: optionalNumberEnv('POLYMARKET_CHAIN_ID'),
      POLYMARKET_SIGNATURE_TYPE: optionalNumberEnv('POLYMARKET_SIGNATURE_TYPE'),
      POLYMARKET_FUNDER_ADDRESS: optionalEnv('POLYMARKET_FUNDER_ADDRESS'),
      POLYMARKET_DEFAULT_TICK_SIZE: optionalEnv('POLYMARKET_DEFAULT_TICK_SIZE'),
      POLYMARKET_NEG_RISK: optionalBooleanEnv('POLYMARKET_NEG_RISK'),
      CONNECTION_TIMEOUT: optionalNumberEnv('CONNECTION_TIMEOUT'),
      RECONNECT_INTERVAL: optionalNumberEnv('RECONNECT_INTERVAL'),
      MAX_RECONNECT_ATTEMPTS: optionalNumberEnv('MAX_RECONNECT_ATTEMPTS'),
    }),
    wallet: WalletConfigSchema.parse({
      PRIVATE_KEY: optionalEnv('PRIVATE_KEY'),
      WALLET_ADDRESS: optionalEnv('WALLET_ADDRESS'),
    }),
    logging: LogConfigSchema.parse({
      LOG_LEVEL: optionalEnv('LOG_LEVEL'),
      SILENT: optionalBooleanEnv('SILENT'),
      STRUCTURED_LOGGING: optionalBooleanEnv('STRUCTURED_LOGGING'),
    }),
    kelly: KellyConfigSchema.parse({
      KELLY_FRACTION: optionalNumberEnv('KELLY_FRACTION'),
      MIN_PROBABILITY: optionalNumberEnv('MIN_PROBABILITY'),
      MAX_BET_FRACTION: optionalNumberEnv('MAX_BET_FRACTION'),
    }),
    risk: RiskConfigSchema.parse({
      MAX_DAILY_LOSS: optionalNumberEnv('MAX_DAILY_LOSS'),
      MAX_EXPOSURE: optionalNumberEnv('MAX_EXPOSURE'),
      EMERGENCY_STOP_THRESHOLD: optionalNumberEnv('EMERGENCY_STOP_THRESHOLD'),
      CIRCUIT_BREAKER_ENABLED: optionalBooleanEnv('CIRCUIT_BREAKER_ENABLED'),
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
