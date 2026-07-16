import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { getErrorMessage } from '../utils/errors.js';
import {
  type DaemonHealthReadyResult,
  waitForDaemonHealth,
  type WaitForDaemonHealthOptions,
} from './daemon-smoke.js';

export interface DockerSmokeOptions {
  configPath: string;
  imageTag?: string;
  containerName?: string;
  hostPort?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  dockerBin?: string;
}

export interface DockerSmokePlan {
  healthUrl: string;
  imageTag: string;
  containerName: string;
  buildArgs: string[];
  runArgs: string[];
  logArgs: string[];
  cleanupArgs: string[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunnerOptions {
  allowNonZeroExit?: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandRunnerOptions
) => Promise<CommandResult>;

export interface DockerSmokeDependencies {
  commandRunner?: CommandRunner;
  waitForHealth?: (
    healthUrl: string,
    options?: WaitForDaemonHealthOptions
  ) => Promise<DaemonHealthReadyResult>;
}

const DEFAULT_DOCKER_BIN = 'docker';
const DEFAULT_HOST_PORT = 3104;
const CONTAINER_PORT = 3000;
const CONTAINER_CONFIG_PATH = '/app/config/trading-system.example.json';

function defaultImageTag(): string {
  return `polymarket-daemon-smoke:${String(process.pid)}`;
}

function defaultContainerName(): string {
  return `polymarket-daemon-smoke-${String(process.pid)}`;
}

function runCommand(
  command: string,
  args: string[],
  options: CommandRunnerOptions = {}
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 || options.allowNonZeroExit) {
        resolvePromise({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `Command failed: ${command} ${args.join(' ')} (exit code: ${String(code)})` +
            (stderr.trim() ? ` stderr: ${stderr.trim()}` : '') +
            (stdout.trim() ? ` stdout: ${stdout.trim()}` : '')
        )
      );
    });
  });
}

export function createDockerSmokePlan(options: DockerSmokeOptions): DockerSmokePlan {
  const imageTag = options.imageTag ?? defaultImageTag();
  const containerName = options.containerName ?? defaultContainerName();
  const hostPort = options.hostPort ?? DEFAULT_HOST_PORT;
  const configPath = resolve(options.configPath);

  return {
    healthUrl: `http://127.0.0.1:${String(hostPort)}/health`,
    imageTag,
    containerName,
    buildArgs: ['build', '--target', 'production', '-t', imageTag, '.'],
    runArgs: [
      'run',
      '--detach',
      '--name',
      containerName,
      '--publish',
      `${String(hostPort)}:${String(CONTAINER_PORT)}`,
      '--mount',
      `type=bind,src=${configPath},dst=${CONTAINER_CONFIG_PATH},readonly`,
      '--env',
      'HTTP_HOST=0.0.0.0',
      '--env',
      `HTTP_PORT=${String(CONTAINER_PORT)}`,
      '--env',
      'HTTP_METRICS_TOKEN=docker-smoke-metrics-token',
      '--env',
      `TRADING_SYSTEM_CONFIG_PATH=${CONTAINER_CONFIG_PATH}`,
      imageTag,
    ],
    logArgs: ['logs', containerName],
    cleanupArgs: ['rm', '-f', containerName],
  };
}

export async function runDockerSmokeCheck(
  options: DockerSmokeOptions,
  dependencies: DockerSmokeDependencies = {}
): Promise<DaemonHealthReadyResult> {
  const dockerBin = options.dockerBin ?? DEFAULT_DOCKER_BIN;
  const commandRunner = dependencies.commandRunner ?? runCommand;
  const waitForHealth = dependencies.waitForHealth ?? waitForDaemonHealth;
  const plan = createDockerSmokePlan(options);
  const healthOptions: WaitForDaemonHealthOptions = {};
  let containerStarted = false;

  if (options.timeoutMs !== undefined) {
    healthOptions.timeoutMs = options.timeoutMs;
  }
  if (options.pollIntervalMs !== undefined) {
    healthOptions.pollIntervalMs = options.pollIntervalMs;
  }

  await commandRunner(dockerBin, plan.buildArgs);

  try {
    await commandRunner(dockerBin, plan.runArgs);
    containerStarted = true;
    return await waitForHealth(plan.healthUrl, healthOptions);
  } catch (error) {
    let dockerLogs = '';

    if (containerStarted) {
      const logResult = await commandRunner(dockerBin, plan.logArgs, {
        allowNonZeroExit: true,
      });
      dockerLogs = (logResult.stdout || logResult.stderr).trim();
    }

    const wrappedError = new Error(
      `Docker smoke check failed: ${getErrorMessage(error)}` +
        (dockerLogs ? ` docker logs: ${dockerLogs}` : '')
    );
    (wrappedError as Error & { cause?: unknown }).cause = error;
    throw wrappedError;
  } finally {
    await commandRunner(dockerBin, plan.cleanupArgs, { allowNonZeroExit: true });
  }
}
