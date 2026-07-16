import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { TradingSystemConfig } from '../index.js';

const EventMarketConfigSchema = z.object({
  id: z.string().min(1),
  outcome: z.enum(['YES', 'NO']),
  price: z.number().min(0).max(1),
});

const TradingEventConfigSchema = z.object({
  id: z.string().min(1),
  markets: z.array(EventMarketConfigSchema).min(1),
});

const CrossMarketPayoffModelSchema = z.object({
  id: z.string().min(1),
  marketIds: z.array(z.string().min(1)).min(2),
  feeBufferBps: z.number().nonnegative(),
  targetPayoutUsd: z.number().positive().optional(),
  minGuaranteedProfitUsd: z.number().nonnegative().optional(),
  scenarios: z
    .array(
      z.object({
        id: z.string().min(1),
        payouts: z.array(z.number().min(0).max(1)).min(2),
      })
    )
    .min(2),
});

const TradingSystemRuntimeConfigSchema = z
  .object({
    liveTrading: z.boolean(),
    markets: z.array(z.string().min(1)).min(1),
    events: z.array(TradingEventConfigSchema).min(1),
    payoffModels: z.array(CrossMarketPayoffModelSchema).optional(),
  })
  .superRefine((config, ctx) => {
    const configuredMarketIds = new Set(config.markets);
    if (configuredMarketIds.size !== config.markets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'top-level markets list contains duplicate ids',
        path: ['markets'],
      });
    }

    const eventIds = new Set<string>();
    const marketOwners = new Map<string, string>();

    for (const [eventIndex, event] of config.events.entries()) {
      if (eventIds.has(event.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate event id ${event.id}`,
          path: ['events', eventIndex, 'id'],
        });
      }
      eventIds.add(event.id);
      const localMarketIds = new Set(event.markets.map((market) => market.id));
      const outcomes = new Set(event.markets.map((market) => market.outcome));
      if (
        event.markets.length !== 2 ||
        localMarketIds.size !== 2 ||
        outcomes.size !== 2 ||
        !outcomes.has('YES') ||
        !outcomes.has('NO')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `event ${event.id} must contain exactly one YES and one NO market`,
          path: ['events', eventIndex, 'markets'],
        });
      }
      for (const market of event.markets) {
        if (!configuredMarketIds.has(market.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `event market ${market.id} is missing from the top-level markets list`,
            path: ['markets'],
          });
        }
        const owner = marketOwners.get(market.id);
        if (owner && owner !== event.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `market ${market.id} belongs to multiple events (${owner}, ${event.id})`,
            path: ['events', eventIndex, 'markets'],
          });
        }
        marketOwners.set(market.id, event.id);
      }
    }

    for (const [marketIndex, marketId] of config.markets.entries()) {
      if (!marketOwners.has(marketId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `top-level market ${marketId} is not assigned to an event`,
          path: ['markets', marketIndex],
        });
      }
    }

    const eventByMarketId = new Map(
      config.events.flatMap((event) =>
        event.markets.map((market) => [market.id, event.id] as const)
      )
    );
    const payoffModelIds = new Set<string>();
    for (const [modelIndex, model] of (config.payoffModels ?? []).entries()) {
      if (payoffModelIds.has(model.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate payoff model id ${model.id}`,
          path: ['payoffModels', modelIndex, 'id'],
        });
      }
      payoffModelIds.add(model.id);
      if (new Set(model.marketIds).size !== model.marketIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `payoff model ${model.id} contains duplicate market ids`,
          path: ['payoffModels', modelIndex, 'marketIds'],
        });
      }
      const eventIds = new Set<string>();
      for (const marketId of model.marketIds) {
        const eventId = eventByMarketId.get(marketId);
        if (!eventId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `payoff model ${model.id} references unknown market ${marketId}`,
            path: ['payoffModels', modelIndex, 'marketIds'],
          });
        } else {
          eventIds.add(eventId);
        }
      }
      if (eventIds.size < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `payoff model ${model.id} must span at least two events`,
          path: ['payoffModels', modelIndex, 'marketIds'],
        });
      }
      const scenarioIds = new Set<string>();
      const payoutVectors = new Set<string>();
      for (const [scenarioIndex, scenario] of model.scenarios.entries()) {
        if (scenarioIds.has(scenario.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `payoff model ${model.id} contains duplicate scenario ${scenario.id}`,
            path: ['payoffModels', modelIndex, 'scenarios', scenarioIndex, 'id'],
          });
        }
        scenarioIds.add(scenario.id);
        const payoutKey = scenario.payouts.join('|');
        if (payoutVectors.has(payoutKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `payoff model ${model.id} contains duplicate terminal payout vectors`,
            path: ['payoffModels', modelIndex, 'scenarios', scenarioIndex, 'payouts'],
          });
        }
        payoutVectors.add(payoutKey);
        if (scenario.payouts.length !== model.marketIds.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `payoff model ${model.id} scenario ${scenario.id} has the wrong dimension`,
            path: ['payoffModels', modelIndex, 'scenarios', scenarioIndex, 'payouts'],
          });
        }
      }
    }
  });

const RuntimeServerConfigSchema = z
  .object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().positive().max(65_535).default(3000),
    riskStatusToken: z.string().min(16).optional(),
    metricsToken: z.string().min(16).optional(),
  })
  .superRefine((config, ctx) => {
    if (!isLoopbackHost(config.host) && !config.metricsToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'HTTP_METRICS_TOKEN is required when HTTP_HOST binds outside loopback',
        path: ['metricsToken'],
      });
    }
  });

export interface RuntimeServerConfig {
  host: string;
  port: number;
  riskStatusToken?: string;
  metricsToken?: string;
}

export interface RuntimeEnv extends NodeJS.ProcessEnv {
  TRADING_SYSTEM_CONFIG_JSON?: string;
  TRADING_SYSTEM_CONFIG_PATH?: string;
  HTTP_HOST?: string;
  HTTP_PORT?: string;
  HTTP_RISK_STATUS_TOKEN?: string;
  HTTP_METRICS_TOKEN?: string;
  HTTP_METRICS_TOKEN_FILE?: string;
  RECONCILE_ON_STARTUP?: string;
  HOST?: string;
  PORT?: string;
}

export function shouldReconcileOnStartup(env: RuntimeEnv = process.env): boolean {
  const value = env.RECONCILE_ON_STARTUP?.trim().toLowerCase();
  if (!value) {
    return false;
  }
  if (value !== 'true' && value !== 'false') {
    throw new Error('RECONCILE_ON_STARTUP must be "true" or "false"');
  }
  return value === 'true';
}

export interface TradingSystemConfigSummary {
  liveTrading: boolean;
  configuredMarkets: number;
  configuredEvents: number;
}

export interface ValidatedTradingSystemConfigFile {
  path: string;
  config: TradingSystemConfig;
  summary: TradingSystemConfigSummary;
}

export function createExampleTradingSystemConfig(): TradingSystemConfig {
  return {
    liveTrading: false,
    markets: ['market-yes', 'market-no'],
    events: [
      {
        id: 'sample-event',
        markets: [
          { id: 'market-yes', outcome: 'YES', price: 0.55 },
          { id: 'market-no', outcome: 'NO', price: 0.4 },
        ],
      },
    ],
  };
}

export function parseTradingSystemConfig(rawConfig: string): TradingSystemConfig {
  const parsed = JSON.parse(rawConfig) as unknown;
  const config = TradingSystemRuntimeConfigSchema.parse(parsed);

  if (config.liveTrading) {
    throw new Error(
      'Runtime config with liveTrading=true is not supported for the production paper/canary daemon'
    );
  }

  return {
    liveTrading: config.liveTrading,
    markets: config.markets,
    events: config.events,
    ...(config.payoffModels
      ? {
          payoffModels: config.payoffModels.map((model) => ({
            id: model.id,
            marketIds: model.marketIds,
            scenarios: model.scenarios,
            feeBufferBps: model.feeBufferBps,
            ...(model.targetPayoutUsd !== undefined
              ? { targetPayoutUsd: model.targetPayoutUsd }
              : {}),
            ...(model.minGuaranteedProfitUsd !== undefined
              ? { minGuaranteedProfitUsd: model.minGuaranteedProfitUsd }
              : {}),
          })),
        }
      : {}),
  };
}

export function summarizeTradingSystemConfig(
  config: TradingSystemConfig
): TradingSystemConfigSummary {
  return {
    liveTrading: config.liveTrading,
    configuredMarkets: config.markets.length,
    configuredEvents: config.events.length,
  };
}

export function loadTradingSystemConfigFile(configPath: string): TradingSystemConfig {
  return parseTradingSystemConfig(readFileSync(configPath, 'utf8'));
}

function getRawTradingSystemConfig(env: RuntimeEnv): string | undefined {
  const inlineJson = env.TRADING_SYSTEM_CONFIG_JSON?.trim();
  if (inlineJson) {
    return inlineJson;
  }

  const configPath = env.TRADING_SYSTEM_CONFIG_PATH?.trim();
  if (configPath) {
    return readFileSync(configPath, 'utf8');
  }

  return undefined;
}

export function loadTradingSystemConfigFromEnv(env: RuntimeEnv = process.env): TradingSystemConfig {
  const rawConfig = getRawTradingSystemConfig(env);

  if (!rawConfig) {
    throw new Error(
      'TRADING_SYSTEM_CONFIG_JSON or TRADING_SYSTEM_CONFIG_PATH must be set for daemon startup'
    );
  }

  return parseTradingSystemConfig(rawConfig);
}

export function validateTradingSystemConfigFile(
  configPath: string
): ValidatedTradingSystemConfigFile {
  const config = loadTradingSystemConfigFile(configPath);
  return {
    path: configPath,
    config,
    summary: summarizeTradingSystemConfig(config),
  };
}

export function writeExampleTradingSystemConfig(
  targetPath: string,
  options: { force?: boolean } = {}
): TradingSystemConfig {
  if (existsSync(targetPath) && !options.force) {
    throw new Error(`Runtime config already exists at ${targetPath}. Use --force to overwrite.`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const config = createExampleTradingSystemConfig();
  writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}

export function parseRuntimeServerConfigFromEnv(
  env: RuntimeEnv = process.env
): RuntimeServerConfig {
  const configuredHost = env.HTTP_HOST?.trim();
  const fallbackHost = env.HOST?.trim();
  const riskStatusToken = env.HTTP_RISK_STATUS_TOKEN?.trim();
  const metricsToken = readOptionalSecret(
    env.HTTP_METRICS_TOKEN,
    env.HTTP_METRICS_TOKEN_FILE,
    'HTTP_METRICS_TOKEN'
  );
  const parsed = RuntimeServerConfigSchema.parse({
    host:
      configuredHost && configuredHost.length > 0
        ? configuredHost
        : fallbackHost && fallbackHost.length > 0
          ? fallbackHost
          : '127.0.0.1',
    port: Number(env.HTTP_PORT ?? env.PORT ?? '3000'),
    ...(riskStatusToken ? { riskStatusToken } : {}),
    ...(metricsToken ? { metricsToken } : {}),
  });
  return {
    host: parsed.host,
    port: parsed.port,
    ...(parsed.riskStatusToken ? { riskStatusToken: parsed.riskStatusToken } : {}),
    ...(parsed.metricsToken ? { metricsToken: parsed.metricsToken } : {}),
  };
}

function readOptionalSecret(
  inlineValue: string | undefined,
  filePath: string | undefined,
  name: string
): string | undefined {
  const inline = inlineValue?.trim();
  const configuredFile = filePath?.trim();
  if (inline && configuredFile) {
    throw new Error(`${name} and ${name}_FILE cannot both be set`);
  }
  if (inline) {
    return inline;
  }
  if (!configuredFile) {
    return undefined;
  }
  const secret = readFileSync(configuredFile, 'utf8').trim();
  if (!secret) {
    throw new Error(`${name}_FILE is empty`);
  }
  return secret;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') {
    return true;
  }
  return isIP(normalized) === 4 && normalized.split('.')[0] === '127';
}
