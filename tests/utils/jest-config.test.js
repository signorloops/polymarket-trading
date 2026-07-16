import { describe, expect, it } from '@jest/globals';

import config from '../../jest.config.js';

describe('jest config', () => {
  it('ignores nested git worktrees during module discovery', () => {
    expect(config.modulePathIgnorePatterns).toEqual(
      expect.arrayContaining(['<rootDir>/.worktrees/'])
    );
  });

  it('does not force-exit and mask leaked async handles', () => {
    expect(config.forceExit).toBeUndefined();
  });

  it('enforces the measured project coverage floor', () => {
    expect(config.coverageThreshold?.global).toEqual({
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    });
  });
});
