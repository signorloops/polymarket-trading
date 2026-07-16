/**
 * API Security Tests
 */

import { jest } from '@jest/globals';
import {
  ApiKeyManager,
  RequestSigner,
  RateLimiter,
  AnomalyDetector,
  generateNonce,
  hashSensitive,
} from '../../src/security/api-security.js';

describe('ApiKeyManager', () => {
  let manager: ApiKeyManager;

  beforeEach(() => {
    manager = new ApiKeyManager();
  });

  describe('registerKey', () => {
    it('should register a key', () => {
      manager.registerKey('key1', 'api-key-1', 'secret-1');
      expect(manager.setCurrentKey('key1')).toBe(true);
    });

    it('should register key with expiration', () => {
      const expiresAt = Date.now() + 3600000;
      manager.registerKey('key1', 'api-key-1', 'secret-1', expiresAt);
      expect(manager.isCurrentKeyExpired()).toBe(false);
    });

    it('returns a defensive credentials copy', () => {
      manager.registerKey('key1', 'api-key-1', 'secret-1');
      manager.setCurrentKey('key1');
      const credentials = manager.getCurrentCredentials();
      if (credentials) credentials.apiSecret = 'mutated';

      expect(manager.getCurrentCredentials()?.apiSecret).toBe('secret-1');
    });
  });

  describe('rotateKey', () => {
    it('should rotate between keys', () => {
      manager.registerKey('key1', 'api-key-1', 'secret-1');
      manager.registerKey('key2', 'api-key-2', 'secret-2');
      manager.setCurrentKey('key1');

      expect(manager.rotateKey()).toBe(true);
      const creds = manager.getCurrentCredentials();
      expect(creds?.apiKey).toBe('api-key-2');
    });

    it('should fail with only one key', () => {
      manager.registerKey('key1', 'api-key-1', 'secret-1');
      manager.setCurrentKey('key1');

      expect(manager.rotateKey()).toBe(false);
    });
  });

  describe('isCurrentKeyExpired', () => {
    it('should detect expired key', () => {
      manager.registerKey('key1', 'api-key-1', 'secret-1', Date.now() - 1000);
      manager.setCurrentKey('key1');

      expect(manager.isCurrentKeyExpired()).toBe(true);
    });
  });

  describe('removeKey', () => {
    it('should remove inactive key', () => {
      manager.registerKey('key1', 'api-key-1', 'secret-1');
      manager.registerKey('key2', 'api-key-2', 'secret-2');
      manager.setCurrentKey('key1');

      expect(manager.removeKey('key2')).toBe(true);
      expect(manager.setCurrentKey('key2')).toBe(false);
    });

    it('should not remove active key', () => {
      manager.registerKey('key1', 'api-key-1', 'secret-1');
      manager.setCurrentKey('key1');

      expect(manager.removeKey('key1')).toBe(false);
    });
  });
});

describe('RequestSigner', () => {
  let signer: RequestSigner;

  beforeEach(() => {
    signer = new RequestSigner('test-secret');
  });

  describe('sign', () => {
    it('should create valid signature', () => {
      const payload = { marketId: 'test', size: 100 };
      const signed = signer.sign(payload);

      expect(signed.timestamp).toBeDefined();
      expect(signed.signature).toBeDefined();
      expect(signed.signature.length).toBe(64); // hex sha256
    });
  });

  describe('verify', () => {
    it('should verify valid signature', () => {
      const payload = { marketId: 'test', size: 100 };
      const signed = signer.sign(payload);

      expect(signer.verify(signed)).toBe(true);
    });

    it('should reject tampered payload', () => {
      const payload = { marketId: 'test', size: 100 };
      const signed = signer.sign(payload);
      signed.payload = '{"tampered": true}';

      expect(signer.verify(signed)).toBe(false);
    });

    it('should reject old timestamp', () => {
      const signed = {
        timestamp: Date.now() - 6 * 60 * 1000, // 6 minutes ago
        signature: 'test',
        payload: '{}',
      };

      expect(signer.verify(signed)).toBe(false);
    });
  });
});

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 60000); // 3 requests per minute
  });

  describe('isAllowed', () => {
    it('should allow requests within limit', () => {
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
    });

    it('should block requests over limit', () => {
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');

      expect(limiter.isAllowed('user1')).toBe(false);
    });

    it('should track different keys separately', () => {
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');

      expect(limiter.isAllowed('user2')).toBe(true);
    });

    it('evicts expired entries to bound memory under high cardinality', () => {
      jest.useFakeTimers();
      const base = 1_000_000;
      jest.setSystemTime(base);
      try {
        const limiter = new RateLimiter(5, 1000); // 1s window
        for (let i = 0; i < 10; i++) {
          limiter.isAllowed(`k${String(i)}`);
        }
        const map = (limiter as unknown as { limits: Map<string, unknown> }).limits;
        expect(map.size).toBe(10);

        // Advance well past both the window (1s) and the sweep interval (60s); the
        // next call triggers a sweep that drops every expired entry, bounding memory
        // instead of growing forever.
        jest.setSystemTime(base + 120000);
        limiter.isAllowed('after');
        expect(map.size).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('fails closed for new keys when the cardinality cap is exhausted', () => {
      const map = (limiter as unknown as { limits: Map<string, unknown> }).limits;
      for (let i = 0; i < 10000; i++) map.set(`k${String(i)}`, { count: 1, resetTime: Infinity });

      expect(limiter.isAllowed('overflow')).toBe(false);
      expect(map.size).toBe(10000);
    });
  });

  describe('getRemaining', () => {
    it('should return remaining requests', () => {
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');

      expect(limiter.getRemaining('user1')).toBe(1);
    });

    it('should return max for new keys', () => {
      expect(limiter.getRemaining('newuser')).toBe(3);
    });

    it('should return max when the previous window expired', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(1_000);
        const shortLimiter = new RateLimiter(3, 100);
        shortLimiter.isAllowed('user1');
        jest.setSystemTime(1_101);
        expect(shortLimiter.getRemaining('user1')).toBe(3);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('reset', () => {
    it('should reset limit', () => {
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');

      limiter.reset('user1');
      expect(limiter.isAllowed('user1')).toBe(true);
    });
  });
});

describe('AnomalyDetector', () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    detector = new AnomalyDetector();
  });

  describe('checkAnomaly', () => {
    it('should not flag normal trades', () => {
      // Record normal trades
      for (let i = 0; i < 10; i++) {
        detector.recordTrade({
          id: `order-${i}`,
          marketId: 'market-1',
          side: 'buy',
          size: 100,
          price: 0.5,
          orderType: 'limit',
        });
      }

      const result = detector.checkAnomaly({
        id: 'order-11',
        marketId: 'market-1',
        side: 'buy',
        size: 105,
        price: 0.51,
        orderType: 'limit',
      });

      expect(result.isAnomalous).toBe(false);
      expect(result.riskScore).toBeLessThan(50);
    });

    it('should flag extreme size trades', () => {
      // Record normal trades
      for (let i = 0; i < 10; i++) {
        detector.recordTrade({
          id: `order-${i}`,
          marketId: 'market-1',
          side: 'buy',
          size: 100,
          price: 0.5,
          orderType: 'limit',
        });
      }

      // Size 10001 > 10000 (large order threshold) and extreme Z-score
      const result = detector.checkAnomaly({
        id: 'order-11',
        marketId: 'market-1',
        side: 'buy',
        size: 10001,
        price: 0.5,
        orderType: 'limit',
      });

      expect(result.isAnomalous).toBe(true);
      expect(result.riskScore).toBeGreaterThan(50);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('should flag extreme prices', () => {
      const result = detector.checkAnomaly({
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.001,
        orderType: 'limit',
      });

      expect(result.riskScore).toBeGreaterThan(0);
      expect(result.reasons.some((r) => r.includes('Extreme price'))).toBe(true);
    });

    it('should flag large orders', () => {
      const result = detector.checkAnomaly({
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 50000,
        price: 0.5,
        orderType: 'limit',
      });

      expect(result.reasons.some((r) => r.includes('Large order'))).toBe(true);
    });
  });

  describe('clearHistory', () => {
    it('should clear trade history', () => {
      detector.recordTrade({
        id: 'order-1',
        marketId: 'market-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'limit',
      });

      detector.clearHistory('market-1');

      const result = detector.checkAnomaly({
        id: 'order-2',
        marketId: 'market-1',
        side: 'buy',
        size: 10000,
        price: 0.5,
        orderType: 'limit',
      });

      // Should not have std dev calculation
      expect(result.riskScore).toBeLessThan(50);
    });
  });
});

describe('Utility functions', () => {
  describe('generateNonce', () => {
    it('should generate unique nonces', () => {
      const nonce1 = generateNonce();
      const nonce2 = generateNonce();

      expect(nonce1).not.toBe(nonce2);
      expect(nonce1.length).toBe(32); // 16 bytes hex
    });
  });

  describe('hashSensitive', () => {
    const originalEnv = process.env.HASH_SALT;

    beforeEach(() => {
      process.env.HASH_SALT = 'test-salt-for-consistent-hashing';
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.HASH_SALT;
      } else {
        process.env.HASH_SALT = originalEnv;
      }
    });

    it('should hash data consistently when HASH_SALT is set', () => {
      const hash1 = hashSensitive('secret');
      const hash2 = hashSensitive('secret');

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(16);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = hashSensitive('secret1');
      const hash2 = hashSensitive('secret2');

      expect(hash1).not.toBe(hash2);
    });

    it('should be deterministic within a process even when HASH_SALT is unset', () => {
      delete process.env.HASH_SALT;
      const hash1 = hashSensitive('secret');
      const hash2 = hashSensitive('secret');

      // Same input must yield the same hash within a process so hashes can be
      // correlated across log lines. (Previously a fresh random salt per call made
      // every hash unique and useless for correlation.)
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(16);
    });
  });
});
