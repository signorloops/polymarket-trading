/**
 * Configuration encryption: .env file operations and CLI interface.
 */

import fs from 'fs/promises';
import { getLogger } from './logger.js';
import { getErrorMessage } from './errors.js';
import {
  isEncrypted,
  encryptValue,
  decryptValue,
  verifyEncryptionKey,
  generateKey,
} from './crypto-utils.js';

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
      if ((mode & 0o077) !== 0) issues.push(`File ${filePath} has permissions ${mode.toString(8)} - should be 600 (owner only)`);
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

export async function encryptEnvFile(filePath: string, fieldsToEncrypt?: string[]): Promise<{
  encrypted: number;
  skipped: number;
}> {
  const defaultSensitiveFields = [
    'PRIVATE_KEY', 'POLYMARKET_API_KEY', 'POLYMARKET_SECRET',
    'POLYMARKET_PASSPHRASE', 'RPC_URL', 'WS_URL',
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

      if (isEncrypted(value.trim())) { skipped++; return line; }
      if (!fields.includes(trimmedKey)) return line;

      try {
        const encryptedValue = encryptValue(value.trim());
        encrypted++;
        return `${key}=${encryptedValue}`;
      } catch {
        logger.warn(`Failed to encrypt ${trimmedKey}, leaving as-is`);
        skipped++;
        return line;
      }
    });

    await fs.writeFile(filePath, processedLines.join('\n'), 'utf8');
    await setSecurePermissions(filePath);
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

      if (!isEncrypted(value.trim())) { skipped++; return line; }

      try {
        const decryptedValue = decryptValue(value.trim());
        decrypted++;
        return `${key}=${decryptedValue}`;
      } catch {
        logger.warn(`Failed to decrypt value for ${key.trim()}, leaving as-is`);
        skipped++;
        return line;
      }
    });

    await fs.writeFile(filePath, processedLines.join('\n'), 'utf8');
    logger.info(`Decrypted ${String(decrypted)} values in ${filePath}, skipped ${String(skipped)}`);
    return { decrypted, skipped };
  } catch (error) {
    logger.error(`Failed to decrypt env file ${filePath}`, { error: getErrorMessage(error) });
    throw error;
  }
}

export async function runCli(args: string[]): Promise<void> {
  const command = args[0];
  switch (command) {
    case 'encrypt': {
      const value = args[1];
      if (!value) { console.error('Usage: config-encryption encrypt <value>'); process.exit(1); }
      console.log(encryptValue(value));
      break;
    }
    case 'decrypt': {
      const value = args[1];
      if (!value) { console.error('Usage: config-encryption decrypt <value>'); process.exit(1); }
      console.log(decryptValue(value));
      break;
    }
    case 'encrypt-file': {
      const filePath = args[1] ?? '.env';
      const result = await encryptEnvFile(filePath);
      console.log(`Encrypted ${String(result.encrypted)} values, skipped ${String(result.skipped)}`);
      break;
    }
    case 'decrypt-file': {
      const filePath = args[1] ?? '.env';
      const result = await decryptEnvFile(filePath);
      console.log(`Decrypted ${String(result.decrypted)} values, skipped ${String(result.skipped)}`);
      break;
    }
    case 'check': {
      const filePath = args[1] ?? '.env';
      const { isSecure, mode, issues } = await checkFilePermissions(filePath);
      console.log(`File: ${filePath}`);
      console.log(`Permissions: ${mode.toString(8)}`);
      console.log(`Secure: ${isSecure ? 'Yes' : 'No'}`);
      if (issues.length > 0) { console.log('Issues:'); issues.forEach((issue) => { console.log(`  - ${issue}`); }); }
      break;
    }
    case 'fix-permissions': {
      const filePath = args[1] ?? '.env';
      await setSecurePermissions(filePath);
      console.log(`Set secure permissions for ${filePath}`);
      break;
    }
    case 'verify': {
      const result = verifyEncryptionKey();
      if (result.valid) { console.log('Encryption key is valid'); }
      else { console.error(`Encryption key verification failed: ${result.error ?? 'unknown error'}`); process.exit(1); }
      break;
    }
    case 'generate-key': { console.log(generateKey()); break; }
    default:
      console.log(`
Usage: config-encryption <command> [options]

Commands:
  encrypt <value>              Encrypt a single value
  decrypt <value>              Decrypt a single value
  encrypt-file [file]          Encrypt .env file (default: .env)
  decrypt-file [file]          Decrypt .env file (default: .env)
  check [file]                 Check file permissions
  fix-permissions [file]       Set secure file permissions
  verify                       Verify encryption key is configured correctly
  generate-key                 Generate a new encryption key

Environment:
  CONFIG_ENCRYPTION_KEY        Master encryption key (hex string, 64 characters)
`);
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === `file://${scriptPath}`) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
