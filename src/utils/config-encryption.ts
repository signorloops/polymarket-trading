/**
 * Configuration encryption: .env file operations and CLI interface.
 */

import fs from 'fs/promises';
import path from 'node:path';
import { getLogger } from './logger.js';
import { getErrorMessage } from './errors.js';
import { isEncrypted, encryptValue, decryptValue } from './crypto-utils.js';

// Re-export primitives so existing imports keep working
export {
  isEncrypted,
  encryptValue,
  decryptValue,
  verifyEncryptionKey,
  generateKey,
} from './crypto-utils.js';

const logger = getLogger().child({ module: 'ConfigEncryption' });

export function encryptObjectFields<T extends Record<string, unknown>>(
  obj: T,
  fieldsToEncrypt: string[]
): T {
  const result: Record<string, unknown> = { ...obj };
  for (const field of fieldsToEncrypt) {
    const value = result[field];
    if (typeof value === 'string' && value && !isEncrypted(value)) {
      result[field] = encryptValue(value);
    }
  }
  return result as T;
}

export function decryptObjectFields<T extends Record<string, unknown>>(
  obj: T,
  fieldsToEncrypt: string[]
): T {
  const result: Record<string, unknown> = { ...obj };
  for (const field of fieldsToEncrypt) {
    const value = result[field];
    if (typeof value === 'string' && isEncrypted(value)) {
      try {
        result[field] = decryptValue(value);
      } catch (error) {
        logger.error(`Failed to decrypt field ${field}`, { error: getErrorMessage(error) });
        throw error;
      }
    }
  }
  return result as T;
}

export async function checkFilePermissions(filePath: string): Promise<{
  isSecure: boolean;
  mode: number;
  issues: string[];
}> {
  const issues: string[] = [];
  try {
    const stats = await fs.stat(filePath);
    const mode = stats.mode & 0o777;
    const isSecure = mode === 0o600;
    if (!isSecure) {
      if ((mode & 0o077) !== 0)
        issues.push(
          `File ${filePath} has permissions ${mode.toString(8)} - should be 600 (owner only)`
        );
      if ((mode & 0o040) !== 0) issues.push(`File ${filePath} is readable by group`);
      if ((mode & 0o004) !== 0) issues.push(`File ${filePath} is readable by others`);
      if ((mode & 0o020) !== 0) issues.push(`File ${filePath} is writable by group`);
      if ((mode & 0o002) !== 0) issues.push(`File ${filePath} is writable by others`);
    }
    return { isSecure, mode, issues };
  } catch (error) {
    issues.push(`Cannot stat file ${filePath}: ${getErrorMessage(error)}`);
    return { isSecure: false, mode: 0, issues };
  }
}

export async function setSecurePermissions(filePath: string): Promise<void> {
  try {
    await fs.chmod(filePath, 0o600);
    logger.info(`Set secure permissions (600) for ${filePath}`);
  } catch (error) {
    logger.error(`Failed to set permissions for ${filePath}`, { error: getErrorMessage(error) });
    throw error;
  }
}

export async function encryptEnvFile(
  filePath: string,
  fieldsToEncrypt?: string[]
): Promise<{
  encrypted: number;
  skipped: number;
}> {
  const defaultSensitiveFields = [
    'PRIVATE_KEY',
    'POLYMARKET_API_KEY',
    'POLYMARKET_SECRET',
    'POLYMARKET_PASSPHRASE',
    'RPC_URL',
    'WS_URL',
  ];
  const fields = fieldsToEncrypt ?? defaultSensitiveFields;

  try {
    const { isSecure, issues } = await checkFilePermissions(filePath);
    if (!isSecure) {
      logger.warn('File permissions issue', { issues });
      await setSecurePermissions(filePath);
    }

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    let encrypted = 0;
    let skipped = 0;

    const processedLines = lines.map((line) => {
      if (line.trim().startsWith('#') || !line.includes('=')) return line;
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=');
      if (!key || !value) return line;
      const trimmedKey = key.trim();

      if (isEncrypted(value.trim())) {
        skipped++;
        return line;
      }
      if (!fields.includes(trimmedKey)) return line;

      const encryptedValue = encryptValue(value.trim());
      encrypted++;
      return `${key}=${encryptedValue}`;
    });

    await writeFileAtomically(filePath, processedLines.join('\n'));
    logger.info(`Encrypted ${String(encrypted)} values in ${filePath}, skipped ${String(skipped)}`);
    return { encrypted, skipped };
  } catch (error) {
    logger.error(`Failed to encrypt env file ${filePath}`, { error: getErrorMessage(error) });
    throw error;
  }
}

export async function decryptEnvFile(filePath: string): Promise<{
  decrypted: number;
  skipped: number;
}> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    let decrypted = 0;
    let skipped = 0;

    const processedLines = lines.map((line) => {
      if (line.trim().startsWith('#') || !line.includes('=')) return line;
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=');
      if (!key || !value) return line;

      if (!isEncrypted(value.trim())) {
        skipped++;
        return line;
      }

      const decryptedValue = decryptValue(value.trim());
      decrypted++;
      return `${key}=${decryptedValue}`;
    });

    await writeFileAtomically(filePath, processedLines.join('\n'));
    logger.info(`Decrypted ${String(decrypted)} values in ${filePath}, skipped ${String(skipped)}`);
    return { decrypted, skipped };
  } catch (error) {
    logger.error(`Failed to decrypt env file ${filePath}`, { error: getErrorMessage(error) });
    throw error;
  }
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    const directoryHandle = await fs.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
