import { parseUnits, type Address } from 'viem';

import type { TakerFeeSchedule } from '../api/polymarket-client.js';
import type { TradingBalance, TradingCollateralBalance } from '../api/trading-client.js';
import type { CanaryTradeRecord } from './canary-trade-persistence.js';
import type { OnchainBalanceSnapshot } from './onchain-balance-reader.js';

export interface UiBalanceEvidence {
  collateralAtomic: string;
  tokenBalances: Record<string, string>;
}

export interface OperatorAuditConfig {
  tokenIds: string[];
  walletAddress: Address;
  polygonRpcUrl: string;
  uiEvidence?: UiBalanceEvidence;
  toleranceAtomic: bigint;
  canaryStatePath: string;
}

export interface BalanceComparison {
  assetId: string;
  clobAtomic: string;
  onchainAtomic: string;
  uiAtomic?: string;
  clobVsOnchainDeltaAtomic: string;
  uiVsOnchainDeltaAtomic?: string;
  matches: boolean;
}

export function parseOperatorAuditConfigFromEnv(
  env: Record<string, string | undefined>,
  defaultWalletAddress?: string
): OperatorAuditConfig {
  const rawTokenIds = firstNonEmpty(
    env.OPERATOR_AUDIT_TOKEN_IDS?.trim(),
    env.CANARY_TOKEN_ID?.trim()
  );
  const tokenIds = [...new Set((rawTokenIds ?? '').split(',').map((value) => value.trim()))].filter(
    Boolean
  );
  if (tokenIds.length === 0 || tokenIds.some((tokenId) => !/^\d+$/.test(tokenId))) {
    throw new Error('OPERATOR_AUDIT_TOKEN_IDS must contain comma-separated numeric CLOB token ids');
  }
  const walletAddress = firstNonEmpty(
    env.OPERATOR_AUDIT_WALLET_ADDRESS?.trim(),
    defaultWalletAddress
  );
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new Error('OPERATOR_AUDIT_WALLET_ADDRESS must be a valid Polygon address');
  }
  const polygonRpcUrl = env.POLYGON_RPC_URL?.trim();
  if (!polygonRpcUrl) throw new Error('POLYGON_RPC_URL is required for onchain reconciliation');
  const tolerance = firstNonEmpty(env.OPERATOR_AUDIT_TOLERANCE_ATOMIC_UNITS?.trim(), '1');
  if (tolerance === undefined) throw new Error('Operator audit tolerance is unavailable');
  if (!/^\d+$/.test(tolerance)) {
    throw new Error('OPERATOR_AUDIT_TOLERANCE_ATOMIC_UNITS must be a non-negative integer');
  }
  const uiCollateral = env.OPERATOR_AUDIT_UI_COLLATERAL?.trim();
  const uiTokensJson = env.OPERATOR_AUDIT_UI_TOKEN_BALANCES_JSON?.trim();
  if ((uiCollateral && !uiTokensJson) || (!uiCollateral && uiTokensJson)) {
    throw new Error('UI collateral and token balance evidence must be provided together');
  }

  return {
    tokenIds,
    walletAddress: walletAddress as Address,
    polygonRpcUrl,
    ...(uiCollateral && uiTokensJson
      ? { uiEvidence: parseUiEvidence(uiCollateral, uiTokensJson, tokenIds) }
      : {}),
    toleranceAtomic: BigInt(tolerance),
    canaryStatePath:
      firstNonEmpty(env.CANARY_STATE_PATH?.trim(), '.state/canary-trades.json') ??
      '.state/canary-trades.json',
  };
}

export function compareThreeWayBalances(
  tokenIds: readonly string[],
  clobBalances: readonly TradingBalance[],
  clobCollateral: TradingCollateralBalance,
  onchain: OnchainBalanceSnapshot,
  uiEvidence: UiBalanceEvidence | undefined,
  toleranceAtomic: bigint
): BalanceComparison[] {
  const clobByToken = new Map(clobBalances.map((balance) => [balance.assetId, balance.size]));
  const chainByToken = new Map(
    onchain.tokenBalances.map((balance) => [balance.tokenId, balance.atomic])
  );
  return [
    compareAsset(
      'pUSD',
      decimalNumberToAtomic(clobCollateral.size),
      onchain.collateralAtomic,
      uiEvidence?.collateralAtomic,
      toleranceAtomic
    ),
    ...tokenIds.map((tokenId) => {
      const clob = clobByToken.get(tokenId);
      const chain = chainByToken.get(tokenId);
      if (clob === undefined || chain === undefined) {
        throw new Error(`Balance audit is missing token ${tokenId}`);
      }
      return compareAsset(
        tokenId,
        decimalNumberToAtomic(clob),
        chain,
        uiEvidence?.tokenBalances[tokenId],
        toleranceAtomic
      );
    }),
  ];
}

export function summarizeCanaryEvidence(records: readonly CanaryTradeRecord[]): {
  fundedCanaryObserved: boolean;
  fundedCanaryTerminal: boolean;
  latest?: Pick<
    CanaryTradeRecord,
    'runId' | 'updatedAt' | 'tokenId' | 'status' | 'submitted' | 'orderId'
  >;
} {
  const funded = records
    .filter((record) => !record.dryRun && record.submitted)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const latest = funded[0];
  const terminal =
    latest?.status === 'filled' || latest?.status === 'cancelled' || latest?.status === 'rejected';
  return {
    fundedCanaryObserved: latest !== undefined,
    fundedCanaryTerminal: terminal,
    ...(latest
      ? {
          latest: {
            runId: latest.runId,
            updatedAt: latest.updatedAt,
            tokenId: latest.tokenId,
            status: latest.status,
            submitted: latest.submitted,
            ...(latest.orderId ? { orderId: latest.orderId } : {}),
          },
        }
      : {}),
  };
}

export function dynamicFeesAreFresh(
  schedules: readonly TakerFeeSchedule[],
  tokenIds: readonly string[],
  now = Date.now(),
  maxAgeMs = 10 * 60 * 1000
): boolean {
  const byToken = new Map(schedules.map((schedule) => [schedule.tokenId, schedule]));
  return tokenIds.every((tokenId) => {
    const schedule = byToken.get(tokenId);
    return (
      schedule !== undefined && schedule.fetchedAt <= now && now - schedule.fetchedAt <= maxAgeMs
    );
  });
}

function parseUiEvidence(
  collateral: string,
  tokenBalancesJson: string,
  tokenIds: readonly string[]
): UiBalanceEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tokenBalancesJson);
  } catch (error) {
    throw new Error('OPERATOR_AUDIT_UI_TOKEN_BALANCES_JSON is invalid JSON', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('UI token balance evidence must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const tokenBalances: Record<string, string> = {};
  for (const tokenId of tokenIds) {
    const value = record[tokenId];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`UI token balance evidence is missing token ${tokenId}`);
    }
    tokenBalances[tokenId] = decimalStringToAtomic(String(value));
  }
  return {
    collateralAtomic: decimalStringToAtomic(collateral),
    tokenBalances,
  };
}

function compareAsset(
  assetId: string,
  clobAtomic: string,
  onchainAtomic: string,
  uiAtomic: string | undefined,
  tolerance: bigint
): BalanceComparison {
  const clobDelta = absolute(BigInt(clobAtomic) - BigInt(onchainAtomic));
  const uiDelta =
    uiAtomic === undefined ? undefined : absolute(BigInt(uiAtomic) - BigInt(onchainAtomic));
  return {
    assetId,
    clobAtomic,
    onchainAtomic,
    ...(uiAtomic !== undefined ? { uiAtomic } : {}),
    clobVsOnchainDeltaAtomic: clobDelta.toString(),
    ...(uiDelta !== undefined ? { uiVsOnchainDeltaAtomic: uiDelta.toString() } : {}),
    matches: clobDelta <= tolerance && uiDelta !== undefined && uiDelta <= tolerance,
  };
}

function decimalNumberToAtomic(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('CLOB balance is invalid');
  const scaled = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(scaled) || Math.abs(value - scaled / 1_000_000) > 1e-9) {
    throw new Error('CLOB balance cannot be represented safely at six decimals');
  }
  return BigInt(scaled).toString();
}

function decimalStringToAtomic(value: string): string {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new Error('UI balances must be non-negative decimal strings with at most six decimals');
  }
  return parseUnits(value, 6).toString();
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}
