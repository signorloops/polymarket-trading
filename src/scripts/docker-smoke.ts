import { createDockerSmokePlan, runDockerSmokeCheck } from '../runtime/docker-smoke.js';
import { getErrorMessage } from '../utils/errors.js';

interface DockerSmokeCommand {
  configPath: string;
  imageTag?: string;
  containerName?: string;
  hostPort: number;
  timeoutMs: number;
  pollIntervalMs: number;
  dockerBin?: string;
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

function parseCommand(argv: string[]): DockerSmokeCommand {
  const args = argv.slice(2);
  let configPath = './config/trading-system.example.json';
  let imageTag: string | undefined;
  let containerName: string | undefined;
  let hostPort = 3104;
  let timeoutMs = 15_000;
  let pollIntervalMs = 250;
  let dockerBin: string | undefined;

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

    if (arg === '--image-tag') {
      if (!next) {
        throw new Error('Usage: --image-tag requires a value');
      }
      imageTag = next;
      index += 1;
      continue;
    }

    if (arg === '--container-name') {
      if (!next) {
        throw new Error('Usage: --container-name requires a value');
      }
      containerName = next;
      index += 1;
      continue;
    }

    if (arg === '--host-port') {
      hostPort = parseNumberOption('--host-port', next, hostPort);
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

    if (arg === '--docker-bin') {
      if (!next) {
        throw new Error('Usage: --docker-bin requires a value');
      }
      dockerBin = next;
      index += 1;
      continue;
    }

    throw new Error(
      'Usage: node dist/src/scripts/docker-smoke.js [--config path] [--image-tag tag] [--container-name name] [--host-port port] [--timeout-ms ms] [--poll-interval-ms ms] [--docker-bin path]'
    );
  }

  return {
    configPath,
    hostPort,
    timeoutMs,
    pollIntervalMs,
    ...(imageTag ? { imageTag } : {}),
    ...(containerName ? { containerName } : {}),
    ...(dockerBin ? { dockerBin } : {}),
  };
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  const plan = createDockerSmokePlan(command);
  const result = await runDockerSmokeCheck(command);

  console.log(
    JSON.stringify(
      {
        imageTag: plan.imageTag,
        containerName: plan.containerName,
        healthUrl: result.healthUrl,
        ready: result.ready,
      },
      null,
      2
    )
  );
}

void main().catch((error: unknown) => {
  console.error(`Docker smoke command failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
