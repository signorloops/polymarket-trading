import { privateKeyToAccount } from 'viem/accounts';

import { getPolymarketClient } from '../api/polymarket-client.js';
import { createSignedClobTradingClientFromEnv } from '../api/signed-clob-client.js';
import { createPolymarketUserWebSocketFromEnv } from '../api/polymarket-user-ws.js';
import { CanaryTradePersistence } from '../execution/canary-trade-persistence.js';
import { OnchainBalanceReader } from '../execution/onchain-balance-reader.js';
import {
  compareThreeWayBalances,
  dynamicFeesAreFresh,
  parseOperatorAuditConfigFromEnv,
  summarizeCanaryEvidence,
} from '../execution/operator-readiness-audit.js';
import { getErrorMessage } from '../utils/errors.js';

async function main(): Promise<void> {
  const defaultWallet = resolveDefaultWalletAddress();
  const config = parseOperatorAuditConfigFromEnv(process.env, defaultWallet);
  const signedClient = createSignedClobTradingClientFromEnv();
  const publicClient = getPolymarketClient();
  const userStream = createPolymarketUserWebSocketFromEnv({ maxReconnectAttempts: 0 });
  userStream.connect();

  try {
    const [balances, collateral, openOrders, fees, onchain] = await Promise.all([
      signedClient.getBalances(config.tokenIds),
      signedClient.getCollateralBalance(),
      signedClient.getOpenOrders(),
      Promise.all(config.tokenIds.map((tokenId) => publicClient.getTakerFeeSchedule(tokenId))),
      new OnchainBalanceReader(config.polygonRpcUrl).read(config.walletAddress, config.tokenIds),
      userStream.waitUntilReady(),
    ]);
    const balanceComparisons = compareThreeWayBalances(
      config.tokenIds,
      balances,
      collateral,
      onchain,
      config.uiEvidence,
      config.toleranceAtomic
    );
    const canary = summarizeCanaryEvidence(
      new CanaryTradePersistence(config.canaryStatePath).loadRecords()
    );
    const checks = {
      authenticatedUserStreamReady: userStream.isReady(),
      dynamicFeesFresh: dynamicFeesAreFresh(fees, config.tokenIds),
      noOpenOrders: openOrders.length === 0,
      uiEvidenceProvided: config.uiEvidence !== undefined,
      clobUiOnchainBalancesMatch: balanceComparisons.every((comparison) => comparison.matches),
      fundedCanaryObserved: canary.fundedCanaryObserved,
      fundedCanaryTerminal: canary.fundedCanaryTerminal,
      multiLegAtomicExecutionAvailable: false,
    };
    const readyForFundedCanary =
      checks.authenticatedUserStreamReady &&
      checks.dynamicFeesFresh &&
      checks.noOpenOrders &&
      checks.clobUiOnchainBalancesMatch;
    const blockers = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          walletAddress: config.walletAddress,
          tokenIds: config.tokenIds,
          checks,
          readyForFundedCanary,
          readyForUnattendedAutomaticTrading: false,
          blockers,
          balanceComparisons,
          openOrderCount: openOrders.length,
          feeSchedules: fees,
          canary,
        },
        null,
        2
      )
    );
    if (!readyForFundedCanary) process.exitCode = 2;
  } finally {
    userStream.disconnect();
  }
}

function resolveDefaultWalletAddress(): string | undefined {
  const configured = firstNonEmpty(
    process.env.POLYMARKET_FUNDER_ADDRESS?.trim(),
    process.env.WALLET_ADDRESS?.trim(),
    process.env.OPERATOR_AUDIT_WALLET_ADDRESS?.trim()
  );
  if (configured) return configured;
  const privateKey = process.env.PRIVATE_KEY?.trim();
  if (!privateKey || !/^0x?[a-fA-F0-9]{64}$/.test(privateKey)) return undefined;
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  return privateKeyToAccount(normalized as `0x${string}`).address;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

main().catch((error: unknown) => {
  console.error(`Operator readiness audit failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
