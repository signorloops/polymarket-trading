import {
  CanaryKillSwitchPersistence,
  DEFAULT_CANARY_KILL_SWITCH_PATH,
  type CanaryKillSwitchState,
} from '../execution/canary-kill-switch.js';
import { getErrorMessage } from '../utils/errors.js';

function getStatePath(): string {
  return process.env.CANARY_KILL_SWITCH_PATH?.trim() ?? DEFAULT_CANARY_KILL_SWITCH_PATH;
}

function parseCommand(argv: string[]): {
  command: 'activate' | 'deactivate' | 'status';
  reason?: string;
} {
  const command = argv[2];

  if (command === 'activate') {
    return {
      command,
      reason: argv.slice(3).join(' ').trim() || 'manual stop',
    };
  }

  if (command === 'deactivate' || command === 'status') {
    return { command };
  }

  throw new Error(
    'Usage: node dist/src/scripts/canary-kill-switch.js <activate|deactivate|status> [reason]'
  );
}

function main(): Promise<void> {
  const { command, reason } = parseCommand(process.argv);
  const persistence = new CanaryKillSwitchPersistence(getStatePath());

  let state: CanaryKillSwitchState;
  switch (command) {
    case 'activate':
      state = {
        active: true,
        updatedAt: Date.now(),
        ...(reason ? { reason } : {}),
      };
      persistence.saveState(state);
      break;
    case 'deactivate':
      state = {
        active: false,
        updatedAt: Date.now(),
      };
      persistence.saveState(state);
      break;
    case 'status':
      state = persistence.loadState();
      break;
  }

  console.log(
    JSON.stringify(
      {
        path: getStatePath(),
        state,
      },
      null,
      2
    )
  );

  return Promise.resolve();
}

main().catch((error: unknown) => {
  console.error(`Canary kill switch command failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
