import { createSignedClobTradingClientFromEnv } from '../api/signed-clob-client.js';
import { parseCanaryTradeConfigFromEnv, runCanaryTrade } from '../execution/canary-trade.js';
import {
  CanaryKillSwitchPersistence,
  DEFAULT_CANARY_KILL_SWITCH_PATH,
} from '../execution/canary-kill-switch.js';
import { getErrorMessage } from '../utils/errors.js';

async function main(): Promise<void> {
  const config = parseCanaryTradeConfigFromEnv();
  const killSwitchPath =
    process.env.CANARY_KILL_SWITCH_PATH?.trim() ?? DEFAULT_CANARY_KILL_SWITCH_PATH;
  const killSwitch = new CanaryKillSwitchPersistence(killSwitchPath);
  const tradingClient =
    config.dryRun || killSwitch.loadState().active
      ? undefined
      : createSignedClobTradingClientFromEnv();
  const result = await runCanaryTrade(config, tradingClient, {
    killSwitch,
  });

  console.log(
    JSON.stringify(
      {
        submitted: result.submitted,
        dryRun: result.dryRun,
        notionalUsd: result.notionalUsd,
        orderRequest: result.orderRequest,
        order: result.order
          ? {
              id: result.order.id,
              status: result.order.status,
              marketId: result.order.marketId,
              side: result.order.side,
              size: result.order.size,
              price: result.order.price,
            }
          : undefined,
        record: {
          status: result.record.status,
          submitted: result.record.submitted,
          cancelAttempted: result.record.cancelAttempted,
          cancelSucceeded: result.record.cancelSucceeded,
          cancelConfirmed: result.record.cancelConfirmed,
          cancelError: result.record.cancelError,
          manualInterventionRequired: result.record.manualInterventionRequired,
          manualInterventionReason: result.record.manualInterventionReason,
        },
        reason: result.reason,
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(`Canary trade failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
