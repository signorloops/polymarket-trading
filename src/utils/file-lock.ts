/**
 * Exclusive file lock with stale-lock recovery (EXEC-4).
 *
 * Uses O_EXCL (`wx`) for atomic claim. Lock files store the holder's pid so a
 * crash mid-critical-section leaves a recoverable marker instead of a permanent
 * deadlock. If the recorded pid is not alive, the stale lock is removed and
 * acquisition is retried once.
 */

import fs from 'node:fs';

export class FileLockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FileLockError';
  }
}

export interface AcquiredFileLock {
  fd: number;
  path: string;
  release: () => void;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    // EPERM means the process exists but we lack permission to signal it.
    return code === 'EPERM';
  }
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function tryRemoveStaleLock(lockPath: string): boolean {
  const pid = readLockPid(lockPath);
  if (pid !== undefined && isProcessAlive(pid)) {
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive lock file. Writes the current pid into the lock so
 * subsequent EEXIST failures can distinguish live holders from crash leftovers.
 */
export function acquireFileLock(lockPath: string): AcquiredFileLock {
  const openExclusive = (): number => fs.openSync(lockPath, 'wx', 0o600);

  let fd: number;
  try {
    fd = openExclusive();
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code !== 'EEXIST') {
      throw new FileLockError(`Failed to acquire lock ${lockPath}: ${String(error)}`, {
        cause: error,
      });
    }

    if (!tryRemoveStaleLock(lockPath)) {
      const holderPid = readLockPid(lockPath);
      throw new FileLockError(
        `Failed to acquire lock ${lockPath}: already held` +
          (holderPid !== undefined
            ? ` by live pid ${String(holderPid)}`
            : ' (could not remove lock file)'),
        { cause: error }
      );
    }

    try {
      fd = openExclusive();
    } catch (retryError) {
      throw new FileLockError(
        `Failed to acquire lock ${lockPath} after removing a stale lock: ${String(retryError)}`,
        { cause: retryError }
      );
    }
  }

  try {
    fs.writeFileSync(fd, `${String(process.pid)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Preserve the write failure.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Preserve the write failure.
    }
    throw new FileLockError(`Failed to write pid into lock ${lockPath}: ${String(error)}`, {
      cause: error,
    });
  }

  let released = false;
  return {
    fd,
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort close before unlink.
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Caller already finished the critical section.
      }
    },
  };
}
