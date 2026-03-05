/**
 * Unit tests for config encryption
 */

import { jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Set encryption key before importing module
process.env.CONFIG_ENCRYPTION_KEY = 'a'.repeat(64);

const {
  encryptValue,
  decryptValue,
  isEncrypted,
  verifyEncryptionKey,
  generateKey,
  checkFilePermissions,
  setSecurePermissions,
  encryptEnvFile,
  decryptEnvFile,
  encryptObjectFields,
  decryptObjectFields,
} = await import('../../src/utils/config-encryption.js');

describe('ConfigEncryption', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-encrypt-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('encryptValue / decryptValue', () => {
    it('should encrypt and decrypt a value', () => {
      const original = 'my-secret-api-key-12345';
      const encrypted = encryptValue(original);

      expect(encrypted).not.toBe(original);
      expect(encrypted).toContain('ENC:v1:');

      const decrypted = decryptValue(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should produce different ciphertexts for same plaintext', () => {
      const original = 'my-secret';
      const encrypted1 = encryptValue(original);
      const encrypted2 = encryptValue(original);

      expect(encrypted1).not.toBe(encrypted2);
      expect(decryptValue(encrypted1)).toBe(original);
      expect(decryptValue(encrypted2)).toBe(original);
    });

    it('should decrypt non-encrypted values as-is', () => {
      const plaintext = 'not-encrypted-value';
      const result = decryptValue(plaintext);
      expect(result).toBe(plaintext);
    });

    it('should fail with invalid key', () => {
      // Save original key
      const originalKey = process.env.CONFIG_ENCRYPTION_KEY;

      try {
        const encrypted = encryptValue('test');

        // Change key
        process.env.CONFIG_ENCRYPTION_KEY = 'b'.repeat(64);

        expect(() => decryptValue(encrypted)).toThrow('Decryption failed');
      } finally {
        // Restore original key
        process.env.CONFIG_ENCRYPTION_KEY = originalKey;
      }
    });
  });

  describe('isEncrypted', () => {
    it('should identify encrypted values', () => {
      expect(isEncrypted('ENC:v1:abc123')).toBe(true);
      expect(isEncrypted('plain-text')).toBe(false);
      expect(isEncrypted('')).toBe(false);
    });
  });

  describe('verifyEncryptionKey', () => {
    it('should verify valid key', () => {
      const result = verifyEncryptionKey();
      expect(result.valid).toBe(true);
    });

    it('should fail without key', () => {
      const originalKey = process.env.CONFIG_ENCRYPTION_KEY;

      try {
        delete process.env.CONFIG_ENCRYPTION_KEY;
        const result = verifyEncryptionKey();
        expect(result.valid).toBe(false);
      } finally {
        process.env.CONFIG_ENCRYPTION_KEY = originalKey;
      }
    });
  });

  describe('generateKey', () => {
    it('should generate 64-character hex string', () => {
      const key = generateKey();
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[a-f0-9]+$/);
    });

    it('should generate unique keys', () => {
      const key1 = generateKey();
      const key2 = generateKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe('file permissions', () => {
    it('should check file permissions', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'test content');
      await fs.chmod(testFile, 0o600);

      const result = await checkFilePermissions(testFile);
      expect(result.isSecure).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect insecure permissions', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'test content');
      await fs.chmod(testFile, 0o644);

      const result = await checkFilePermissions(testFile);
      expect(result.isSecure).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should set secure permissions', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'test content');
      await fs.chmod(testFile, 0o777);

      await setSecurePermissions(testFile);

      const stats = await fs.stat(testFile);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('encryptEnvFile / decryptEnvFile', () => {
    it('should encrypt sensitive fields in env file', async () => {
      const envFile = path.join(tempDir, '.env');
      const content = `PRIVATE_KEY=0xabc123
POLYMARKET_API_KEY=my-api-key
NON_SENSITIVE=plain-value
# This is a comment
`;
      await fs.writeFile(envFile, content);
      await fs.chmod(envFile, 0o600);

      const result = await encryptEnvFile(envFile);
      expect(result.encrypted).toBeGreaterThan(0);

      const encryptedContent = await fs.readFile(envFile, 'utf8');
      expect(encryptedContent).toContain('ENC:v1:');
      expect(encryptedContent).toContain('# This is a comment');
      expect(encryptedContent).toContain('NON_SENSITIVE=plain-value');
    });

    it('should not encrypt CONFIG_ENCRYPTION_KEY by default', async () => {
      const envFile = path.join(tempDir, '.env');
      const content = `CONFIG_ENCRYPTION_KEY=test-master-key
PRIVATE_KEY=0xabc123
`;
      await fs.writeFile(envFile, content);
      await fs.chmod(envFile, 0o600);

      await encryptEnvFile(envFile);

      const encryptedContent = await fs.readFile(envFile, 'utf8');
      expect(encryptedContent).toContain('CONFIG_ENCRYPTION_KEY=test-master-key');
      expect(encryptedContent).toMatch(/PRIVATE_KEY=ENC:v1:/);
    });

    it('should decrypt env file', async () => {
      const envFile = path.join(tempDir, '.env');
      const original = `PRIVATE_KEY=0xabc123
POLYMARKET_API_KEY=my-api-key
`;
      await fs.writeFile(envFile, original);
      await fs.chmod(envFile, 0o600);

      // First encrypt
      await encryptEnvFile(envFile);

      // Then decrypt
      const result = await decryptEnvFile(envFile);
      expect(result.decrypted).toBeGreaterThan(0);

      const decryptedContent = await fs.readFile(envFile, 'utf8');
      expect(decryptedContent).toContain('PRIVATE_KEY=0xabc123');
      expect(decryptedContent).toContain('POLYMARKET_API_KEY=my-api-key');
    });

    it('should skip already encrypted values', async () => {
      const envFile = path.join(tempDir, '.env');
      const content = `PRIVATE_KEY=${encryptValue('secret')}
`;
      await fs.writeFile(envFile, content);
      await fs.chmod(envFile, 0o600);

      const result = await encryptEnvFile(envFile);
      expect(result.skipped).toBe(1);
      expect(result.encrypted).toBe(0);
    });
  });

  describe('encryptObjectFields / decryptObjectFields', () => {
    it('should encrypt specified fields', () => {
      const obj = {
        name: 'Test Config',
        apiKey: 'secret-key-123',
        password: 'my-password',
        publicField: 'visible',
      };

      const encrypted = encryptObjectFields(obj, ['apiKey', 'password']);

      expect(isEncrypted(encrypted.apiKey)).toBe(true);
      expect(isEncrypted(encrypted.password)).toBe(true);
      expect(encrypted.publicField).toBe('visible');
      expect(encrypted.name).toBe('Test Config');
    });

    it('should decrypt specified fields', () => {
      const obj = {
        name: 'Test Config',
        apiKey: encryptValue('secret-key-123'),
        password: encryptValue('my-password'),
        publicField: 'visible',
      };

      const decrypted = decryptObjectFields(obj, ['apiKey', 'password']);

      expect(decrypted.apiKey).toBe('secret-key-123');
      expect(decrypted.password).toBe('my-password');
      expect(decrypted.publicField).toBe('visible');
      expect(decrypted.name).toBe('Test Config');
    });

    it('should not double encrypt', () => {
      const obj = {
        apiKey: encryptValue('secret'),
      };

      const encrypted = encryptObjectFields(obj, ['apiKey']);
      expect(encrypted.apiKey).toBe(obj.apiKey);
    });
  });
});
