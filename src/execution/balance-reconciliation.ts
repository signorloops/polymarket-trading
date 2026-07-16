import type { TradingBalanceClient } from '../api/trading-client.js';
import type { ReconcileResult, RiskManager } from './risk-manager.js';

export interface BalanceReconciliationReport extends ReconcileResult {
  checkedAssetIds: string[];
  exchangeBalances: { assetId: string; size: number }[];
}

/**
 * Fetch every configured conditional-token balance before allowing execution,
 * then treat the exchange response as the authoritative position size.
 * Any fetch/parse error rejects the whole reconciliation; partial snapshots are
 * never applied to the risk manager.
 */
export async function reconcileConfiguredBalances(
  riskManager: RiskManager,
  client: TradingBalanceClient,
  assetIds: readonly string[]
): Promise<BalanceReconciliationReport> {
  const checkedAssetIds = [...new Set(assetIds)];
  if (checkedAssetIds.length === 0) {
    throw new Error('At least one token id is required for balance reconciliation');
  }

  const exchangeBalances = await client.getBalances(checkedAssetIds);
  const returnedIds = new Set(exchangeBalances.map((balance) => balance.assetId));
  const missing = checkedAssetIds.filter((assetId) => !returnedIds.has(assetId));
  if (missing.length > 0) {
    throw new Error(`Balance reconciliation response omitted token ids: ${missing.join(', ')}`);
  }
  for (const balance of exchangeBalances) {
    if (!Number.isFinite(balance.size) || balance.size < 0) {
      throw new Error(`Balance reconciliation returned an invalid size for ${balance.assetId}`);
    }
  }

  const result = riskManager.reconcile(exchangeBalances);
  return {
    checkedAssetIds,
    exchangeBalances,
    ...result,
  };
}
