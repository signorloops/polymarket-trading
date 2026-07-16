import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CanaryKillSwitchPersistence,
  type CanaryKillSwitchState,
} from '../../src/execution/canary-kill-switch.js';

describe('CanaryKillSwitchPersistence', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-kill-switch-'));
    statePath = path.join(tempDir, 'kill-switch.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists and reloads an active kill switch state', () => {
    const persistence = new CanaryKillSwitchPersistence(statePath);
    const state: CanaryKillSwitchState = {
      active: true,
      updatedAt: 1_000,
      reason: 'manual stop',
    };

    persistence.saveState(state);

    expect(new CanaryKillSwitchPersistence(statePath).loadState()).toEqual(state);
  });

  it('fails closed when the file does not exist', () => {
    const persistence = new CanaryKillSwitchPersistence(statePath, () => 500);

    expect(persistence.loadState()).toEqual({
      active: true,
      updatedAt: 500,
      reason: 'Kill switch state file is missing; explicitly deactivate it before a real canary',
    });
  });

  it('fails closed when an existing state file is corrupt', () => {
    fs.writeFileSync(statePath, '{not-json', 'utf8');
    const persistence = new CanaryKillSwitchPersistence(statePath, () => 2_000);

    expect(persistence.loadState()).toEqual({
      active: true,
      updatedAt: 2_000,
      reason: expect.stringMatching(/could not be loaded/i),
    });
  });

  it('fails closed when an existing state file is empty or has an invalid schema', () => {
    const persistence = new CanaryKillSwitchPersistence(statePath, () => 3_000);

    fs.writeFileSync(statePath, '', 'utf8');
    expect(persistence.loadState()).toMatchObject({
      active: true,
      updatedAt: 3_000,
      reason: 'Kill switch state file is empty',
    });

    fs.writeFileSync(statePath, JSON.stringify({ active: false, updatedAt: null }), 'utf8');
    expect(persistence.loadState()).toMatchObject({
      active: true,
      updatedAt: 3_000,
      reason: 'Kill switch state file has an invalid schema',
    });
  });

  it('throws when the state cannot be persisted', () => {
    const blockingFile = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(blockingFile, 'blocked', 'utf8');
    const persistence = new CanaryKillSwitchPersistence(path.join(blockingFile, 'state.json'));

    expect(() =>
      persistence.saveState({ active: true, updatedAt: 1_000, reason: 'manual stop' })
    ).toThrow(/Failed to persist canary kill switch state/);
  });
});
