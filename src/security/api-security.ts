/**
 * API Security Module
 *
 * Provides:
 * - API key rotation
 * - Request signing (HMAC)
 * - Rate limiting
 * - Anomaly detection for trades
 */

import { createHmac, randomBytes } from 'crypto';
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
    return this.credentials.get(this.currentKeyId) ?? null;
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

    const signature = createHmac('sha256', this.apiSecret)
      .update(dataToSign)
      .digest('hex');

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
    const expectedSignature = createHmac('sha256', this.apiSecret)
      .update(dataToSign)
      .digest('hex');

    return signature === expectedSignature;
  }
}

/**
 * Simple in-memory rate limiter
 */
export class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private maxRequests: number;
  private windowMs: number;
  private logger = getLogger().child({ module: 'RateLimiter' });

  constructor(maxRequests = 100, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request is allowed
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const entry = this.limits.get(key);

    if (!entry || now > entry.resetTime) {
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
   * Get remaining requests for a key
   */
  getRemaining(key: string): number {
    const entry = this.limits.get(key);
    if (!entry) return this.maxRequests;
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
  private logger = getLogger().child({ module: 'AnomalyDetector' });

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
        riskScore += 30;
      }
    }

    // Check for unusual price
    if (order.price < 0.01 || order.price > 0.99) {
      reasons.push(`Extreme price: ${order.price.toString()}`);
      riskScore += 20;
    }

    // Check large orders
    if (order.size > 10000) {
      reasons.push(`Large order size: ${order.size.toString()}`);
      riskScore += 25;
    }

    return {
      isAnomalous: riskScore > 50,
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
 * Hash sensitive data (for logging)
 * Uses environment variable HASH_SALT or generates a random salt
 */
export function hashSensitive(data: string): string {
  const salt = process.env.HASH_SALT ?? randomBytes(32).toString('hex');
  return createHmac('sha256', salt)
    .update(data)
    .digest('hex')
    .substring(0, 16);
}
