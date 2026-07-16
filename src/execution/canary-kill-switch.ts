import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';

export interface CanaryKillSwitchState {
  active: boolean;
  updatedAt: number;
  reason?: string;
}

export interface CanaryKillSwitchStatePort {
  loadState(): CanaryKillSwitchState;
  saveState(state: CanaryKillSwitchState): void;
}

export const DEFAULT_CANARY_KILL_SWITCH_PATH = path.join(
  process.cwd(),
  '.state',
  'canary-kill-switch.json'
);

export class CanaryKillSwitchPersistence implements CanaryKillSwitchStatePort {
  private readonly logger = getLogger().child({ module: 'CanaryKillSwitchPersistence' });

  constructor(
    private readonly stateFilePath: string = DEFAULT_CANARY_KILL_SWITCH_PATH,
    private readonly now: () => number = Date.now
  ) {}

  loadState(): CanaryKillSwitchState {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) {
      return {
        active: false,
        updatedAt: 0,
      };
    }

    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      if (!raw.trim()) {
        return this.createFailClosedState('Kill switch state file is empty');
      }

      const parsed = JSON.parse(raw) as unknown;
      if (isCanaryKillSwitchState(parsed)) {
        return parsed;
      }

      return this.createFailClosedState('Kill switch state file has an invalid schema');
    } catch (error) {
      this.logger.error('Failed to load canary kill switch state', {
        file: this.stateFilePath,
        error: getErrorMessage(error),
      });
      return this.createFailClosedState(
        `Kill switch state could not be loaded: ${getErrorMessage(error)}`
      );
    }
  }

  saveState(state: CanaryKillSwitchState): void {
    if (!this.stateFilePath) {
      throw new Error('Canary kill switch state path is required');
    }

    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      const tempPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (error) {
      this.logger.error('Failed to persist canary kill switch state', {
        file: this.stateFilePath,
        error: getErrorMessage(error),
      });
      throw new Error(`Failed to persist canary kill switch state: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
  }

  private createFailClosedState(reason: string): CanaryKillSwitchState {
    this.logger.error('Canary kill switch is failing closed', {
      file: this.stateFilePath,
      reason,
    });
    return {
      active: true,
      updatedAt: this.now(),
      reason,
    };
  }
}

function isCanaryKillSwitchState(value: unknown): value is CanaryKillSwitchState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const state = value as Partial<CanaryKillSwitchState>;
  return (
    typeof state.active === 'boolean' &&
    typeof state.updatedAt === 'number' &&
    Number.isFinite(state.updatedAt) &&
    state.updatedAt >= 0 &&
    (state.reason === undefined || typeof state.reason === 'string')
  );
}
