import { runDaemonSmokeCheck } from '../runtime/daemon-smoke.js';
import { getErrorMessage } from '../utils/errors.js';

interface DaemonSmokeCommand {
  configPath: string;
  host: string;
  port: number;
  timeoutMs: number;
  pollIntervalMs: number;
  entrypointPath?: string;
}

function parseNumberOption(name: string, value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseCommand(argv: string[]): DaemonSmokeCommand {
  const args = argv.slice(2);
  let configPath = './config/trading-system.example.json';
  let host = '127.0.0.1';
  let port = 3102;
  let timeoutMs = 15_000;
  let pollIntervalMs = 250;
  let entrypointPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === '--config') {
      if (!next) {
        throw new Error('Usage: --config requires a file path');
      }
      configPath = next;
      index += 1;
      continue;
    }

    if (arg === '--host') {
      if (!next) {
        throw new Error('Usage: --host requires a value');
      }
      host = next;
      index += 1;
      continue;
    }

    if (arg === '--port') {
      port = parseNumberOption('--port', next, port);
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      timeoutMs = parseNumberOption('--timeout-ms', next, timeoutMs);
      index += 1;
      continue;
    }

    if (arg === '--poll-interval-ms') {
      pollIntervalMs = parseNumberOption('--poll-interval-ms', next, pollIntervalMs);
      index += 1;
      continue;
    }

    if (arg === '--entrypoint') {
      if (!next) {
        throw new Error('Usage: --entrypoint requires a file path');
      }
      entrypointPath = next;
      index += 1;
      continue;
    }

    throw new Error(
      'Usage: node dist/src/scripts/daemon-smoke.js [--config path] [--host host] [--port port] [--timeout-ms ms] [--poll-interval-ms ms] [--entrypoint path]'
    );
  }

  return {
    configPath,
    host,
    port,
    timeoutMs,
    pollIntervalMs,
    ...(entrypointPath ? { entrypointPath } : {}),
  };
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  const result = await runDaemonSmokeCheck(command);
  console.log(
    JSON.stringify(
      {
        healthUrl: result.healthUrl,
        ready: result.ready,
      },
      null,
      2
    )
  );
}

void main().catch((error: unknown) => {
  console.error(`Daemon smoke command failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
