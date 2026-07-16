/**
 * AES-256-GCM encryption primitives for configuration values.
 */

import crypto from 'crypto';
import { getLogger } from './logger.js';

const logger = getLogger().child({ module: 'ConfigEncryption' });

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

const ENCRYPTED_PREFIX = 'ENC:';
const FORMAT_VERSION = 'v1';

function getMasterKey(): Buffer {
  const envKey = process.env.CONFIG_ENCRYPTION_KEY;
  if (!envKey) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY not set. ' +
        "Generate a key with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  if (!/^[a-fA-F0-9]{64}$/.test(envKey)) {
    throw new Error('CONFIG_ENCRYPTION_KEY must be exactly 32 random bytes encoded as 64 hex');
  }
  return Buffer.from(envKey, 'hex');
}

function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(masterKey, salt, 100000, KEY_LENGTH, 'sha256');
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptValue(plaintext: string): string {
  try {
    const masterKey = getMasterKey();
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(masterKey, salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([salt, iv, authTag, encrypted]);

    return `${ENCRYPTED_PREFIX}${FORMAT_VERSION}:${combined.toString('base64')}`;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to encrypt value', { error: cause.message });
    const wrappedError = new Error('Encryption failed') as Error & { cause?: Error };
    wrappedError.cause = cause;
    throw wrappedError;
  }
}

export function decryptValue(encryptedValue: string): string {
  if (!isEncrypted(encryptedValue)) return encryptedValue;

  try {
    const masterKey = getMasterKey();
    const parts = encryptedValue.slice(ENCRYPTED_PREFIX.length).split(':');
    const [version, encodedData] = parts;
    if (parts.length !== 2 || version !== FORMAT_VERSION || !encodedData) {
      throw new Error('Invalid encrypted value format');
    }

    const combined = Buffer.from(encodedData, 'base64');

    let offset = 0;
    const salt = combined.subarray(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;
    const iv = combined.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const authTag = combined.subarray(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;
    const encrypted = combined.subarray(offset);

    const key = deriveKey(masterKey, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to decrypt value', { error: cause.message });
    const wrappedError = new Error('Decryption failed - invalid key or corrupted data') as Error & {
      cause?: Error;
    };
    wrappedError.cause = cause;
    throw wrappedError;
  }
}

export function verifyEncryptionKey(): { valid: boolean; error?: string } {
  try {
    const testValue = `test-${String(Date.now())}`;
    const encrypted = encryptValue(testValue);
    const decrypted = decryptValue(encrypted);
    if (decrypted === testValue) return { valid: true };
    return { valid: false, error: 'Encryption/decryption round-trip failed' };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function generateKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
