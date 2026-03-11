import { describe, expect, it } from '@jest/globals';

import config from '../../jest.config.js';

describe('jest config', () => {
  it('ignores nested git worktrees during module discovery', () => {
    expect(config.modulePathIgnorePatterns).toEqual(
      expect.arrayContaining(['<rootDir>/.worktrees/']),
    );
  });
});
