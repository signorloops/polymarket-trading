/**
 * Exclusive file-lock tests (EXEC-4).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireFileLock, FileLockError } from '../../src/utils/file-lock.js';

describe('acquireFileLock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('acquires and releases an exclusive lock', () => {
    const lockPath = path.join(tempDir, 'state.lock');
    const lock = acquireFileLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('recovers a stale lock left by a dead pid (EXEC-4)', () => {
    const lockPath = path.join(tempDir, 'state.lock');
    fs.writeFileSync(lockPath, '999999999\n', { encoding: 'utf8', mode: 0o600 });

    const lock = acquireFileLock(lockPath);
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    lock.release();
  });

  it('rejects when the lock is held by a live process', () => {
    const lockPath = path.join(tempDir, 'state.lock');
    const held = acquireFileLock(lockPath);
    try {
      expect(() => acquireFileLock(lockPath)).toThrow(FileLockError);
      expect(() => acquireFileLock(lockPath)).toThrow(/live pid/);
    } finally {
      held.release();
    }
  });
});
