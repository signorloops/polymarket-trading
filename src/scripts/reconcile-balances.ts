import { createSignedClobTradingClientFromEnv } from '../api/signed-clob-client.js';
import { reconcileConfiguredBalances } from '../execution/balance-reconciliation.js';
import { getRiskManager } from '../execution/risk-manager.js';
import { loadTradingSystemConfigFromEnv } from '../runtime/runtime-config.js';
import { getErrorMessage } from '../utils/errors.js';

async function main(): Promise<void> {
  const config = loadTradingSystemConfigFromEnv();
  const report = await reconcileConfiguredBalances(
    getRiskManager(),
    createSignedClobTradingClientFromEnv(),
    config.markets
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(`Balance reconciliation failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
