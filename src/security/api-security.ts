/**
 * API Security Module
 *
 * Provides:
 * - API key rotation
 * - Request signing (HMAC)
 * - Rate limiting
 * - Anomaly detection for trades
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { getLogger } from '../utils/logger.js';
import type { TradeOrder } from '../execution/types.js';

export interface ApiCredentials {
  apiKey: string;
  apiSecret: string;
  createdAt: number;
  expiresAt?: number;
}

export interface SignedRequest {
  timestamp: number;
  signature: string;
  payload: string;
}

export interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export interface AnomalyCheckResult {
  isAnomalous: boolean;
  riskScore: number;
  reasons: string[];
}

/**
 * API Key Manager with rotation support
 */
export class ApiKeyManager {
  private credentials: Map<string, ApiCredentials> = new Map();
  private currentKeyId: string | null = null;
  private logger = getLogger().child({ module: 'ApiKeyManager' });

  /**
   * Register a new API key
   */
  registerKey(keyId: string, apiKey: string, apiSecret: string, expiresAt?: number): void {
    const creds: ApiCredentials = {
      apiKey,
      apiSecret,
      createdAt: Date.now(),
    };
    if (expiresAt !== undefined) {
      creds.expiresAt = expiresAt;
    }
    this.credentials.set(keyId, creds);
    this.logger.info(`Registered API key: ${keyId}`);
  }

  /**
   * Set the current active key
   */
  setCurrentKey(keyId: string): boolean {
    if (!this.credentials.has(keyId)) {
      this.logger.error(`Key not found: ${keyId}`);
      return false;
    }
    this.currentKeyId = keyId;
    this.logger.info(`Switched to API key: ${keyId}`);
    return true;
  }

  /**
   * Get current credentials
   */
  getCurrentCredentials(): ApiCredentials | null {
    if (!this.currentKeyId) return null;
    const credentials = this.credentials.get(this.currentKeyId);
    return credentials ? { ...credentials } : null;
  }

  /**
   * Rotate to a new key
   */
  rotateKey(): boolean {
    const availableKeys = Array.from(this.credentials.keys());
    if (availableKeys.length <= 1) {
      this.logger.warn('No alternative keys available for rotation');
      return false;
    }

    const currentIndex = this.currentKeyId ? availableKeys.indexOf(this.currentKeyId) : -1;
    const nextIndex = (currentIndex + 1) % availableKeys.length;
    const nextKey = availableKeys[nextIndex];
    if (!nextKey) return false;
    return this.setCurrentKey(nextKey);
  }

  /**
   * Check if current key is expired
   */
  isCurrentKeyExpired(): boolean {
    const creds = this.getCurrentCredentials();
    if (!creds?.expiresAt) return false;
    return Date.now() > creds.expiresAt;
  }

  /**
   * Remove a key
   */
  removeKey(keyId: string): boolean {
    if (this.currentKeyId === keyId) {
      this.logger.error('Cannot remove currently active key');
      return false;
    }
    return this.credentials.delete(keyId);
  }
}

/**
 * Request signer using HMAC-SHA256
 */
export class RequestSigner {
  private apiSecret: string;

  constructor(apiSecret: string) {
    this.apiSecret = apiSecret;
  }

  /**
   * Sign a request payload
   */
  sign(payload: Record<string, unknown>): SignedRequest {
    const timestamp = Date.now();
    const payloadStr = JSON.stringify(payload);
    const dataToSign = `${timestamp.toString()}.${payloadStr}`;

    const signature = createHmac('sha256', this.apiSecret).update(dataToSign).digest('hex');

    return {
      timestamp,
      signature,
      payload: payloadStr,
    };
  }

  /**
   * Verify a signed request
   */
  verify(signedRequest: SignedRequest): boolean {
    const { timestamp, signature, payload } = signedRequest;

    // Check timestamp is within 5 minutes
    if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
      return false;
    }

    const dataToSign = `${timestamp.toString()}.${payload}`;
    const expectedSignature = createHmac('sha256', this.apiSecret).update(dataToSign).digest('hex');

    // Constant-time comparison: a plain === short-circuits on the first differing
    // byte, leaking how many leading bytes of a forged signature match via response
    // timing (classic signature timing attack). timingSafeEqual throws on
    // mismatched lengths, so guard with the length check first.
    const signatureBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    return signatureBuf.length === expectedBuf.length && timingSafeEqual(signatureBuf, expectedBuf);
  }
}

/**
 * Simple in-memory rate limiter
 */
export class RateLimiter {
  /** Soft cap on tracked keys. When exceeded, expired entries are swept to bound
   *  memory (the limiter is keyed on caller-supplied, potentially high-cardinality
   *  values like per-IP/per-token; without sweeping this Map grew unbounded). */
  private static readonly MAX_ENTRIES = 10000;
  /** Sweep at most this often (and on cap breach) — amortized O(1) per call. */
  private static readonly SWEEP_INTERVAL_MS = 60000;

  private limits: Map<string, RateLimitEntry> = new Map();
  private maxRequests: number;
  private windowMs: number;
  private lastSweepAt = 0;
  private logger = getLogger().child({ module: 'RateLimiter' });

  constructor(maxRequests = 100, windowMs = 60000) {
    if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
      throw new Error('Rate limiter maxRequests must be a positive integer');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('Rate limiter windowMs must be greater than zero');
    }
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request is allowed
   */
  isAllowed(key: string): boolean {
    const now = Date.now();

    // Amortized sweep: drop expired entries periodically (and immediately if the
    // cap is breached) so high-cardinality keys cannot exhaust memory.
    if (
      this.limits.size >= RateLimiter.MAX_ENTRIES ||
      now - this.lastSweepAt >= RateLimiter.SWEEP_INTERVAL_MS
    ) {
      this.sweepExpired(now);
      this.lastSweepAt = now;
    }

    const entry = this.limits.get(key);

    if (!entry || now > entry.resetTime) {
      if (!entry && this.limits.size >= RateLimiter.MAX_ENTRIES) {
        this.logger.warn('RateLimiter rejected a new key at capacity', {
          size: this.limits.size,
          cap: RateLimiter.MAX_ENTRIES,
        });
        return false;
      }
      // New window
      this.limits.set(key, {
        count: 1,
        resetTime: now + this.windowMs,
      });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      this.logger.warn(`Rate limit exceeded for ${key}`);
      return false;
    }

    entry.count++;
    return true;
  }

  /**
   * Remove entries whose window has elapsed.
   */
  private sweepExpired(now: number): void {
    for (const [k, entry] of this.limits) {
      if (now > entry.resetTime) {
        this.limits.delete(k);
      }
    }
    if (this.limits.size >= RateLimiter.MAX_ENTRIES) {
      this.logger.warn('RateLimiter at capacity after sweep (sustained high cardinality)', {
        size: this.limits.size,
        cap: RateLimiter.MAX_ENTRIES,
      });
    }
  }

  /**
   * Get remaining requests for a key
   */
  getRemaining(key: string): number {
    const entry = this.limits.get(key);
    if (!entry || Date.now() > entry.resetTime) return this.maxRequests;
    return Math.max(0, this.maxRequests - entry.count);
  }

  /**
   * Reset limit for a key
   */
  reset(key: string): void {
    this.limits.delete(key);
  }
}

/**
 * Trade anomaly detector
 */
export class AnomalyDetector {
  private tradeHistory: Map<string, number[]> = new Map();
  private maxHistorySize = 100;

  /**
   * Record a trade for pattern analysis
   */
  recordTrade(order: TradeOrder): void {
    const sizes = this.tradeHistory.get(order.marketId) ?? [];
    sizes.push(order.size);

    if (sizes.length > this.maxHistorySize) {
      sizes.shift();
    }

    this.tradeHistory.set(order.marketId, sizes);
  }

  /**
   * Check if a trade is anomalous
   */
  checkAnomaly(order: TradeOrder): AnomalyCheckResult {
    const reasons: string[] = [];
    let riskScore = 0;

    // Check order size
    const sizes = this.tradeHistory.get(order.marketId) ?? [];
    if (sizes.length >= 10) {
      const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
      const stdDev = Math.sqrt(
        sizes.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / sizes.length
      );

      const zScore = Math.abs(order.size - mean) / (stdDev || 1);
      if (zScore > 3) {
        reasons.push(`Size ${order.size.toString()} is ${zScore.toFixed(1)} std dev from mean`);
        // Strong single-signal weight so one clear anomaly can trip the gate (INFRA-8).
        riskScore += 40;
      }
    }

    // Check for unusual price
    if (order.price < 0.01 || order.price > 0.99) {
      reasons.push(`Extreme price: ${order.price.toString()}`);
      riskScore += 40;
    }

    // Check large orders
    if (order.size > 10000) {
      reasons.push(`Large order size: ${order.size.toString()}`);
      riskScore += 40;
    }

    return {
      isAnomalous: riskScore >= 40,
      riskScore,
      reasons,
    };
  }

  /**
   * Clear history for a market
   */
  clearHistory(marketId: string): void {
    this.tradeHistory.delete(marketId);
  }
}

/**
 * Generate a secure nonce for requests
 */
export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Process-wide salt cache for {@link hashSensitive}. When HASH_SALT is unset we
 * generate ONE random salt per process and reuse it, so the same secret hashes
 * consistently across log lines within a run (the point of logging a hash).
 * Previously a fresh random salt per call made every hash unique and useless for
 * correlation. Set HASH_SALT to make hashes comparable across restarts too.
 */
let hashSaltCache: string | null = null;

/**
 * Hash sensitive data (for logging). Deterministic within a process: the same
 * input yields the same hash for the lifetime of the process (so hashes can be
 * correlated across log lines). Set HASH_SALT for cross-restart comparability.
 */
export function hashSensitive(data: string): string {
  const salt = process.env.HASH_SALT ?? (hashSaltCache ??= randomBytes(32).toString('hex'));
  return createHmac('sha256', salt).update(data).digest('hex').substring(0, 16);
}
