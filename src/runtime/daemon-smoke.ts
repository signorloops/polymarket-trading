import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { getErrorMessage } from '../utils/errors.js';

export interface WaitForDaemonHealthOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DaemonSmokeOptions {
  configPath: string;
  entrypointPath?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  nodeEnv?: string;
}

export interface DaemonHealthReadyResult {
  healthUrl: string;
  ready: true;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3102;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const MAX_CAPTURED_OUTPUT_LENGTH = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (next.length <= MAX_CAPTURED_OUTPUT_LENGTH) {
    return next;
  }

  return next.slice(-MAX_CAPTURED_OUTPUT_LENGTH);
}

function createExitPromise(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      resolve(code);
    });
    child.once('error', reject);
  });
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exitPromise = createExitPromise(child).catch(() => null);
  child.kill('SIGTERM');

  const exitResult = await Promise.race([
    exitPromise,
    sleep(PROCESS_EXIT_TIMEOUT_MS).then(() => 'timeout' as const),
  ]);

  if (exitResult === 'timeout') {
    child.kill('SIGKILL');
    await exitPromise;
  }
}

export async function waitForDaemonHealth(
  healthUrl: string,
  options: WaitForDaemonHealthOptions = {}
): Promise<DaemonHealthReadyResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() <= deadline) {
    try {
      const response = await fetchImpl(healthUrl);
      if (response.ok) {
        return {
          healthUrl,
          ready: true,
        };
      }

      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = getErrorMessage(error);
    }

    if (Date.now() + pollIntervalMs > deadline) {
      break;
    }

    await sleep(pollIntervalMs);
  }

  const suffix = lastError ? ` (last error: ${lastError})` : '';
  throw new Error(
    `Daemon at ${healthUrl} did not become healthy within ${String(timeoutMs)}ms${suffix}`
  );
}

export async function runDaemonSmokeCheck(
  options: DaemonSmokeOptions
): Promise<DaemonHealthReadyResult> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const healthUrl = `http://${host}:${String(port)}/health`;
  const entrypointPath = resolve(options.entrypointPath ?? './dist/src/index.js');
  const configPath = resolve(options.configPath);
  const child = spawn(process.execPath, [entrypointPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTTP_HOST: host,
      HTTP_PORT: String(port),
      NODE_ENV: options.nodeEnv ?? 'production',
      SILENT: 'true',
      TRADING_SYSTEM_CONFIG_PATH: configPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = appendOutput(stderr, chunk);
  });

  try {
    const exitPromise = createExitPromise(child).then((code) => {
      throw new Error(
        `Daemon exited before becoming healthy (exit code: ${String(code)}).` +
          (stderr ? ` stderr: ${stderr}` : '') +
          (stdout ? ` stdout: ${stdout}` : '')
      );
    });

    const healthOptions: WaitForDaemonHealthOptions = {};
    if (options.timeoutMs !== undefined) {
      healthOptions.timeoutMs = options.timeoutMs;
    }
    if (options.pollIntervalMs !== undefined) {
      healthOptions.pollIntervalMs = options.pollIntervalMs;
    }

    const healthPromise = waitForDaemonHealth(healthUrl, healthOptions);

    const result = await Promise.race([healthPromise, exitPromise]);
    await stopChildProcess(child);
    return result;
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }
}
