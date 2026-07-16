import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createDockerSmokePlan, runDockerSmokeCheck } from '../../src/runtime/docker-smoke.js';

describe('createDockerSmokePlan', () => {
  it('builds the expected docker commands for container smoke verification', () => {
    const configPath = './config/trading-system.example.json';

    expect(
      createDockerSmokePlan({
        configPath,
        imageTag: 'polymarket:test',
        containerName: 'polymarket-smoke-test',
        hostPort: 3110,
      })
    ).toEqual({
      healthUrl: 'http://127.0.0.1:3110/health',
      imageTag: 'polymarket:test',
      containerName: 'polymarket-smoke-test',
      buildArgs: ['build', '--target', 'production', '-t', 'polymarket:test', '.'],
      runArgs: [
        'run',
        '--detach',
        '--name',
        'polymarket-smoke-test',
        '--publish',
        '3110:3000',
        '--mount',
        `type=bind,src=${resolve(configPath)},dst=/app/config/trading-system.example.json,readonly`,
        '--env',
        'HTTP_HOST=0.0.0.0',
        '--env',
        'HTTP_PORT=3000',
        '--env',
        'HTTP_METRICS_TOKEN=docker-smoke-metrics-token',
        '--env',
        'TRADING_SYSTEM_CONFIG_PATH=/app/config/trading-system.example.json',
        'polymarket:test',
      ],
      logArgs: ['logs', 'polymarket-smoke-test'],
      cleanupArgs: ['rm', '-f', 'polymarket-smoke-test'],
    });
  });
});

describe('runDockerSmokeCheck', () => {
  it('builds, runs, waits for health, and cleans up the container', async () => {
    const calls: { command: string; args: string[]; allowNonZeroExit?: boolean }[] = [];

    const result = await runDockerSmokeCheck(
      {
        configPath: './config/trading-system.example.json',
        imageTag: 'polymarket:test',
        containerName: 'polymarket-smoke-test',
        hostPort: 3110,
      },
      {
        commandRunner: async (command, args, options) => {
          calls.push({ command, args, allowNonZeroExit: options?.allowNonZeroExit });
          return { stdout: '', stderr: '' };
        },
        waitForHealth: async (healthUrl) => ({ healthUrl, ready: true }),
      }
    );

    expect(result).toEqual({
      healthUrl: 'http://127.0.0.1:3110/health',
      ready: true,
    });
    expect(calls).toEqual([
      {
        command: 'docker',
        args: ['build', '--target', 'production', '-t', 'polymarket:test', '.'],
        allowNonZeroExit: undefined,
      },
      {
        command: 'docker',
        args: [
          'run',
          '--detach',
          '--name',
          'polymarket-smoke-test',
          '--publish',
          '3110:3000',
          '--mount',
          `type=bind,src=${resolve('./config/trading-system.example.json')},dst=/app/config/trading-system.example.json,readonly`,
          '--env',
          'HTTP_HOST=0.0.0.0',
          '--env',
          'HTTP_PORT=3000',
          '--env',
          'HTTP_METRICS_TOKEN=docker-smoke-metrics-token',
          '--env',
          'TRADING_SYSTEM_CONFIG_PATH=/app/config/trading-system.example.json',
          'polymarket:test',
        ],
        allowNonZeroExit: undefined,
      },
      {
        command: 'docker',
        args: ['rm', '-f', 'polymarket-smoke-test'],
        allowNonZeroExit: true,
      },
    ]);
  });

  it('captures docker logs and still cleans up when the health check fails', async () => {
    const calls: { command: string; args: string[]; allowNonZeroExit?: boolean }[] = [];

    await expect(
      runDockerSmokeCheck(
        {
          configPath: './config/trading-system.example.json',
          imageTag: 'polymarket:test',
          containerName: 'polymarket-smoke-test',
          hostPort: 3111,
        },
        {
          commandRunner: async (command, args, options) => {
            calls.push({ command, args, allowNonZeroExit: options?.allowNonZeroExit });
            if (args[0] === 'logs') {
              return { stdout: 'fatal startup log', stderr: '' };
            }

            return { stdout: '', stderr: '' };
          },
          waitForHealth: async () => {
            throw new Error('health timeout');
          },
        }
      )
    ).rejects.toThrow(/fatal startup log/);

    expect(calls).toEqual([
      {
        command: 'docker',
        args: ['build', '--target', 'production', '-t', 'polymarket:test', '.'],
        allowNonZeroExit: undefined,
      },
      {
        command: 'docker',
        args: [
          'run',
          '--detach',
          '--name',
          'polymarket-smoke-test',
          '--publish',
          '3111:3000',
          '--mount',
          `type=bind,src=${resolve('./config/trading-system.example.json')},dst=/app/config/trading-system.example.json,readonly`,
          '--env',
          'HTTP_HOST=0.0.0.0',
          '--env',
          'HTTP_PORT=3000',
          '--env',
          'HTTP_METRICS_TOKEN=docker-smoke-metrics-token',
          '--env',
          'TRADING_SYSTEM_CONFIG_PATH=/app/config/trading-system.example.json',
          'polymarket:test',
        ],
        allowNonZeroExit: undefined,
      },
      {
        command: 'docker',
        args: ['logs', 'polymarket-smoke-test'],
        allowNonZeroExit: true,
      },
      {
        command: 'docker',
        args: ['rm', '-f', 'polymarket-smoke-test'],
        allowNonZeroExit: true,
      },
    ]);
  });

  it('creates deterministic defaults from process-local state', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'polymarket-docker-smoke-'));
    const plan = createDockerSmokePlan({
      configPath: join(workspace, 'trading-system.example.json'),
    });

    expect(plan.imageTag).toMatch(/^polymarket-daemon-smoke:/);
    expect(plan.containerName).toMatch(/^polymarket-daemon-smoke-/);
    expect(plan.healthUrl).toBe('http://127.0.0.1:3104/health');
  });
});
