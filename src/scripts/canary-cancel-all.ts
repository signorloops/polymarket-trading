import { createSignedClobTradingClientFromEnv } from '../api/signed-clob-client.js';
import {
  cancelAllCanaryOrders,
  type CanaryCancelableOrderRecord,
} from '../execution/canary-cancel-all.js';
import {
  CanaryTradePersistence,
  DEFAULT_CANARY_STATE_FILE_PATH,
} from '../execution/canary-trade-persistence.js';
import { getErrorMessage } from '../utils/errors.js';

function getStatePath(): string {
  return process.env.CANARY_STATE_PATH?.trim() ?? DEFAULT_CANARY_STATE_FILE_PATH;
}

function isCancelableRecord(record: CanaryCancelableOrderRecord): boolean {
  return (
    !!record.orderId &&
    record.status !== 'dry-run' &&
    record.status !== 'filled' &&
    record.status !== 'cancelled' &&
    record.status !== 'rejected' &&
    record.status !== 'failed'
  );
}

function main(): Promise<void> {
  const statePath = getStatePath();
  const persistence = new CanaryTradePersistence(statePath);
  const records = persistence.loadRecords();
  const cancellableRecords = records.filter(isCancelableRecord);

  if (cancellableRecords.length === 0) {
    console.log(
      JSON.stringify(
        {
          path: statePath,
          cancelled: [],
          failed: [],
          skipped: records.map((record) => ({
            orderId: record.orderId,
            reason: record.orderId ? `terminal-status:${record.status}` : 'missing-order-id',
          })),
        },
        null,
        2
      )
    );
    return Promise.resolve();
  }

  const tradingClient = createSignedClobTradingClientFromEnv();

  return cancelAllCanaryOrders(records, tradingClient, {
    saveRecord: (record) => {
      persistence.saveRecord(record);
    },
  }).then((result) => {
    console.log(
      JSON.stringify(
        {
          path: statePath,
          cancelled: result.cancelled.map((record) => ({
            runId: record.runId,
            orderId: record.orderId,
            status: record.status,
            cancelAttempted: record.cancelAttempted,
            cancelSucceeded: record.cancelSucceeded,
            cancelConfirmed: record.cancelConfirmed,
            manualInterventionRequired: record.manualInterventionRequired,
          })),
          failed: result.failed,
          skipped: result.skipped,
        },
        null,
        2
      )
    );
  });
}

main().catch((error: unknown) => {
  console.error(`Canary cancel-all failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
