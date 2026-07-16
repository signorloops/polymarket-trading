/**
 * Risk Manager for Non-Atomic Trade Execution
 *
 * Handles risks specific to arbitrage trading:
 * - Partial fill scenarios (one leg executes, another doesn't)
 * - Position limits and exposure tracking
 * - Circuit breakers and emergency stops
 * - Unwind strategies for failed arbitrage
 */

import { getLogger } from '../utils/logger.js';
import { RISK_CONFIG } from '../utils/config.js';
import { OrderStatus } from './execution-engine.js';
import { createSingleton } from '../utils/singleton.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Position {
  marketId: string;
  size: number;
  avgPrice: number;
  side: 'long' | 'short';
  timestamp: number;
}

export interface RiskMetrics {
  totalExposure: number;
  dailyPnL: number;
  unrealizedPnL: number;
  maxDrawdown: number;
  positionCount: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

/** External (exchange) position used for reconciliation. `assetId` is the outcome
 *  token id, matching Position.marketId (order.marketId is used as the tokenID). */
export interface ExchangeBalance {
  assetId: string;
  size: number;
}

export interface ReconcileResult {
  /** In-memory positions whose size was corrected to match the exchange. */
  synced: string[];
  /** In-memory positions the exchange no longer holds (closed externally). */
  removed: string[];
  /** Exchange positions not previously tracked (cost basis unknown). */
  imported: string[];
}

export interface RiskManagerConfig {
  maxExposure?: number;
  maxBetFraction?: number;
  maxDailyLoss?: number;
  emergencyStopThreshold?: number;
  /**
   * Optional path to persist risk state (positions, dailyPnL, circuit breaker).
   * When set, state is loaded on construction and saved after meaningful changes
   * so a restart does not zero the loss circuit breaker / daily PnL.
   */
  stateFilePath?: string;
}

interface PersistedRiskState {
  positions: Position[];
  dailyPnL: number;
  maxDailyPnL: number;
  minDailyPnL: number;
  circuitBreakerTriggered: boolean;
}

export class RiskManager {
  private static readonly RECONCILE_TOLERANCE = 1e-6;

  private positions: Map<string, Position> = new Map();
  private marketPrices: Map<string, number> = new Map();
  private dailyPnL = 0;
  private maxDailyPnL = 0;
  private minDailyPnL = 0;
  private circuitBreakerTriggered = false;
  private logger = getLogger().child({ module: 'RiskManager' });
  private config: Required<Omit<RiskManagerConfig, 'stateFilePath'>>;
  private stateFilePath: string | undefined;

  constructor(config: RiskManagerConfig = {}) {
    this.config = {
      maxExposure: config.maxExposure ?? RISK_CONFIG.MAX_EXPOSURE,
      maxBetFraction: config.maxBetFraction ?? 0.5,
      maxDailyLoss: config.maxDailyLoss ?? RISK_CONFIG.MAX_DAILY_LOSS,
      emergencyStopThreshold: config.emergencyStopThreshold ?? RISK_CONFIG.EMERGENCY_STOP_THRESHOLD,
    };
    this.stateFilePath = config.stateFilePath;
    if (this.stateFilePath) {
      this.loadState();
    }
  }

  /**
   * Update risk manager configuration
   */
  updateConfig(config: RiskManagerConfig): void {
    this.config = {
      ...this.config,
      ...config,
    };
    this.logger.info('Risk manager config updated', this.config);
  }

  /**
   * Check if a trade is allowed based on risk limits
   */
  checkTrade(
    marketId: string,
    size: number,
    side: 'buy' | 'sell',
    estimatedNotional: number
  ): RiskCheckResult {
    // Check circuit breaker
    if (this.circuitBreakerTriggered) {
      return {
        allowed: false,
        reason: 'Circuit breaker triggered - trading halted',
        riskLevel: 'critical',
      };
    }

    // Check daily loss limit
    if (this.dailyPnL < -this.config.maxDailyLoss) {
      this.triggerCircuitBreaker('Daily loss limit exceeded');
      return {
        allowed: false,
        reason: `Daily loss limit exceeded: ${String(this.dailyPnL)}`,
        riskLevel: 'critical',
      };
    }

    // Calculate new exposure
    const currentExposure = this.getTotalExposure();
    const tradeNotional = Math.abs(estimatedNotional);
    const newExposure = currentExposure + tradeNotional;

    // Check max exposure
    if (newExposure > this.config.maxExposure) {
      return {
        allowed: false,
        reason: `Max exposure would be exceeded: ${String(newExposure)} > ${String(this.config.maxExposure)}`,
        riskLevel: 'high',
      };
    }

    // Check position concentration
    const currentPosition = this.positions.get(marketId);
    const newPositionSize = (currentPosition?.size ?? 0) + (side === 'buy' ? size : -size);
    const unitValue = Math.abs(size) > 0 ? tradeNotional / Math.abs(size) : 0;
    const concentration = Math.abs(newPositionSize * unitValue) / (newExposure || 1);

    if (currentExposure > 0 && concentration > 0.5) {
      return {
        allowed: false,
        reason: `Position concentration too high: ${(concentration * 100).toFixed(1)}%`,
        riskLevel: 'medium',
      };
    }

    return { allowed: true, riskLevel: 'low' };
  }

  /**
   * Update position after trade execution
   */
  updatePosition(orderStatus: OrderStatus, marketId: string, side: 'buy' | 'sell'): void {
    if (orderStatus.filledSize <= 0) {
      return;
    }

    const existingPosition = this.positions.get(marketId);
    const filledSize = side === 'buy' ? orderStatus.filledSize : -orderStatus.filledSize;

    if (existingPosition) {
      // Update existing position
      const newSize = existingPosition.size + filledSize;

      if (Math.abs(newSize) < 1e-10) {
        // Position closed
        const pnl = this.calculatePnL(
          existingPosition,
          orderStatus.avgPrice,
          orderStatus.filledSize
        );
        this.dailyPnL += pnl;
        this.positions.delete(marketId);
        this.marketPrices.delete(marketId);
        this.logger.info(`Position closed for ${marketId}`, { pnl });
      } else if (newSize * existingPosition.size < 0) {
        // Position flipped
        const closedSize = existingPosition.size;
        const pnl = this.calculatePnL(existingPosition, orderStatus.avgPrice, Math.abs(closedSize));
        this.dailyPnL += pnl;

        this.positions.set(marketId, {
          marketId,
          size: newSize,
          avgPrice: orderStatus.avgPrice,
          side: newSize > 0 ? 'long' : 'short',
          timestamp: Date.now(),
        });
        this.marketPrices.set(marketId, orderStatus.avgPrice);
        this.logger.info(`Position flipped for ${marketId}`, { newSize, pnl });
      } else {
        // Add to position (average down/up)
        const totalValue =
          existingPosition.size * existingPosition.avgPrice + filledSize * orderStatus.avgPrice;
        const newAvgPrice = newSize !== 0 ? totalValue / newSize : existingPosition.avgPrice;

        existingPosition.size = newSize;
        existingPosition.avgPrice = newAvgPrice;
        this.marketPrices.set(marketId, this.marketPrices.get(marketId) ?? orderStatus.avgPrice);
        this.logger.debug(`Position updated for ${marketId}`, { newSize, newAvgPrice });
      }
    } else {
      // New position
      this.positions.set(marketId, {
        marketId,
        size: filledSize,
        avgPrice: orderStatus.avgPrice,
        side: filledSize > 0 ? 'long' : 'short',
        timestamp: Date.now(),
      });
      this.marketPrices.set(marketId, orderStatus.avgPrice);
      this.logger.debug(`New position for ${marketId}`, {
        size: filledSize,
        avgPrice: orderStatus.avgPrice,
      });
    }

    // Update PnL tracking
    this.updatePnLTracking();
    this.persistState();
  }

  /**
   * Update market mark price for unrealized PnL estimation
   */
  updateMarketPrice(marketId: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) {
      return;
    }
    this.marketPrices.set(marketId, price);
  }

  /**
   * Handle partial fill scenario
   * One leg of arbitrage executed, another didn't
   */
  handlePartialFill(
    executedOrders: OrderStatus[],
    failedOrders: string[],
    arbitrageId: string
  ): { action: 'hold' | 'unwind' | 'hedge'; reason: string } {
    this.logger.warn(`Partial fill for arbitrage ${arbitrageId}`, {
      executed: executedOrders.map((o) => o.orderId),
      failed: failedOrders,
    });

    // Calculate exposure from partial fill
    let exposure = 0;
    for (const order of executedOrders) {
      exposure += order.filledSize * order.avgPrice;
    }

    // Check if exposure is within limits
    if (exposure > this.config.maxExposure * 0.1) {
      return {
        action: 'unwind',
        reason: `Partial fill exposure ${String(exposure)} exceeds 10% of max exposure`,
      };
    }

    // Check if we can reasonably hedge
    if (failedOrders.length === 1 && executedOrders.length > 1) {
      return {
        action: 'hedge',
        reason: 'Single leg failed, attempting to hedge exposure',
      };
    }

    // Hold small exposure temporarily
    return {
      action: 'hold',
      reason: 'Small exposure, monitoring for completion',
    };
  }

  /**
   * Get current risk metrics
   */
  getRiskMetrics(): RiskMetrics {
    const totalExposure = this.getTotalExposure();
    const unrealizedPnL = this.calculateUnrealizedPnL();
    const maxDrawdown = this.maxDailyPnL - this.minDailyPnL;

    return {
      totalExposure,
      dailyPnL: this.dailyPnL,
      unrealizedPnL,
      maxDrawdown,
      positionCount: this.positions.size,
    };
  }

  /**
   * Check if we should trigger emergency stop
   */
  checkEmergencyStop(): boolean {
    const metrics = this.getRiskMetrics();

    if (metrics.unrealizedPnL < -this.config.emergencyStopThreshold) {
      this.logger.error('Emergency stop triggered', {
        unrealizedPnL: metrics.unrealizedPnL,
        threshold: this.config.emergencyStopThreshold,
      });
      this.triggerCircuitBreaker('Emergency stop: unrealized loss threshold');
      return true;
    }

    return false;
  }

  /**
   * Trigger circuit breaker
   */
  triggerCircuitBreaker(reason: string): void {
    if (!this.circuitBreakerTriggered) {
      this.circuitBreakerTriggered = true;
      this.logger.error(`Circuit breaker triggered: ${reason}`);
      this.persistState();
    }
  }

  /**
   * Reset circuit breaker (manual override)
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerTriggered = false;
    this.logger.info('Circuit breaker reset');
    this.persistState();
  }

  /**
   * Check if circuit breaker is active
   */
  isCircuitBreakerActive(): boolean {
    return this.circuitBreakerTriggered;
  }

  /**
   * Reset daily PnL (call at start of trading day)
   */
  resetDailyPnL(): void {
    this.dailyPnL = 0;
    this.maxDailyPnL = 0;
    this.minDailyPnL = 0;
    this.logger.info('Daily PnL reset');
    this.persistState();
  }

  /**
   * Get all current positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position for a specific market
   */
  getPosition(marketId: string): Position | undefined {
    return this.positions.get(marketId);
  }

  /**
   * Clear all positions (emergency use only)
   */
  clearPositions(): void {
    this.positions.clear();
    this.marketPrices.clear();
    this.logger.warn('All positions cleared');
    this.persistState();
  }

  /**
   * Reconcile in-memory positions against exchange ground truth. Use on startup
   * (after loading persisted state) and periodically: the persisted state can be
   * stale if orders filled while the daemon was down, or if positions changed
   * externally. The exchange is authoritative for SIZE:
   *  - synced: correct in-memory size to the exchange value when they differ.
   *  - removed: drop in-memory positions the exchange no longer holds.
   *  - imported: record exchange positions we didn't know about, with avgPrice 0
   *    (cost basis unknown) — these are excluded from unrealized PnL until a cost
   *    basis is supplied, so they can't inflate/deflate the circuit-breaker math.
   * Any drift is logged at WARN for operator review, and state is re-persisted.
   */
  reconcile(balances: readonly ExchangeBalance[]): ReconcileResult {
    const exchange = new Map<string, number>();
    for (const b of balances) {
      if (Number.isFinite(b.size) && Math.abs(b.size) > RiskManager.RECONCILE_TOLERANCE) {
        exchange.set(b.assetId, b.size);
      }
    }

    const synced: string[] = [];
    const removed: string[] = [];

    for (const [assetId, pos] of this.positions) {
      const exchangeSize = exchange.get(assetId);
      if (exchangeSize === undefined) {
        removed.push(assetId);
        this.positions.delete(assetId);
      } else if (Math.abs(exchangeSize - pos.size) > RiskManager.RECONCILE_TOLERANCE) {
        synced.push(assetId);
        pos.size = exchangeSize;
        pos.side = exchangeSize >= 0 ? 'long' : 'short';
        pos.timestamp = Date.now();
      }
    }

    const imported: string[] = [];
    for (const [assetId, exchangeSize] of exchange) {
      if (!this.positions.has(assetId)) {
        imported.push(assetId);
        this.positions.set(assetId, {
          marketId: assetId,
          size: exchangeSize,
          avgPrice: 0, // unknown cost basis; excluded from unrealized PnL until set
          side: exchangeSize >= 0 ? 'long' : 'short',
          timestamp: Date.now(),
        });
      }
    }

    if (synced.length > 0 || removed.length > 0 || imported.length > 0) {
      this.logger.warn('Position reconciliation found drift vs exchange', {
        synced,
        removed,
        imported,
      });
      this.persistState();
    }
    return { synced, removed, imported };
  }

  private getTotalExposure(): number {
    return Array.from(this.positions.values()).reduce(
      (sum, pos) => sum + Math.abs(pos.size * pos.avgPrice),
      0
    );
  }

  private calculatePnL(position: Position, exitPrice: number, size: number): number {
    const entryValue = size * position.avgPrice;
    const exitValue = size * exitPrice;
    return position.side === 'long' ? exitValue - entryValue : entryValue - exitValue;
  }

  private calculateUnrealizedPnL(): number {
    let unrealized = 0;
    for (const position of this.positions.values()) {
      // Skip positions with no known cost basis (e.g. reconciled-in from the
      // exchange) — without an entry price, unrealized PnL cannot be computed and
      // must not feed the emergency-stop circuit breaker.
      if (position.avgPrice <= 0) {
        continue;
      }
      const markPrice = this.marketPrices.get(position.marketId);
      if (markPrice === undefined) {
        continue;
      }
      unrealized += (markPrice - position.avgPrice) * position.size;
    }
    return unrealized;
  }

  private updatePnLTracking(): void {
    if (this.dailyPnL > this.maxDailyPnL) {
      this.maxDailyPnL = this.dailyPnL;
    }
    if (this.dailyPnL < this.minDailyPnL) {
      this.minDailyPnL = this.dailyPnL;
    }
  }

  /**
   * Load persisted risk state (positions, dailyPnL, circuit breaker). Missing file
   * (first run) is silent; a corrupt existing file fails closed by activating
   * the circuit breaker. marketPrices are intentionally
   * NOT persisted (transient, repopulated from live feeds, stale on reload).
   */
  private loadState(): void {
    if (!this.stateFilePath || !existsSync(this.stateFilePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.stateFilePath, 'utf8');
      const state = JSON.parse(raw) as unknown;
      if (!isPersistedRiskState(state)) {
        throw new Error('Risk state file has an invalid schema');
      }
      for (const position of state.positions) {
        this.positions.set(position.marketId, position);
      }
      this.dailyPnL = state.dailyPnL;
      this.maxDailyPnL = state.maxDailyPnL;
      this.minDailyPnL = state.minDailyPnL;
      this.circuitBreakerTriggered = state.circuitBreakerTriggered;
      this.logger.info('Risk state loaded from disk', {
        positions: this.positions.size,
        dailyPnL: this.dailyPnL,
        circuitBreakerTriggered: this.circuitBreakerTriggered,
      });
    } catch (error) {
      this.circuitBreakerTriggered = true;
      this.logger.error('Risk state file unreadable; circuit breaker activated', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Atomically persist risk state (temp file + rename). Called only on meaningful
   * state changes (trade fills, circuit-breaker transitions) — not on every price
   * tick — to bound I/O. A persistence failure activates the in-memory circuit
   * breaker so the process cannot continue adding exposure that would be lost on restart.
   */
  private persistState(): void {
    if (!this.stateFilePath) return;
    const state: PersistedRiskState = {
      positions: Array.from(this.positions.values()),
      dailyPnL: this.dailyPnL,
      maxDailyPnL: this.maxDailyPnL,
      minDailyPnL: this.minDailyPnL,
      circuitBreakerTriggered: this.circuitBreakerTriggered,
    };
    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true });
      const tmp = `${this.stateFilePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), 'utf8');
      renameSync(tmp, this.stateFilePath);
    } catch (error) {
      this.circuitBreakerTriggered = true;
      this.logger.error('Failed to persist risk state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function isPersistedRiskState(value: unknown): value is PersistedRiskState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const state = value as Partial<PersistedRiskState>;
  return (
    Array.isArray(state.positions) &&
    state.positions.every(isPersistedPosition) &&
    typeof state.dailyPnL === 'number' &&
    Number.isFinite(state.dailyPnL) &&
    typeof state.maxDailyPnL === 'number' &&
    Number.isFinite(state.maxDailyPnL) &&
    typeof state.minDailyPnL === 'number' &&
    Number.isFinite(state.minDailyPnL) &&
    typeof state.circuitBreakerTriggered === 'boolean'
  );
}

function isPersistedPosition(value: unknown): value is Position {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const position = value as Partial<Position>;
  return (
    typeof position.marketId === 'string' &&
    position.marketId.trim() !== '' &&
    typeof position.size === 'number' &&
    Number.isFinite(position.size) &&
    typeof position.avgPrice === 'number' &&
    Number.isFinite(position.avgPrice) &&
    position.avgPrice >= 0 &&
    (position.side === 'long' || position.side === 'short') &&
    typeof position.timestamp === 'number' &&
    Number.isFinite(position.timestamp) &&
    position.timestamp >= 0
  );
}

/**
 * Global risk manager instance. When RISK_STATE_FILE is set, risk state (positions,
 * daily PnL, circuit breaker) is persisted across restarts.
 */
const riskManagerSingleton = createSingleton(() => {
  const stateFilePath = process.env.RISK_STATE_FILE;
  return new RiskManager(stateFilePath ? { stateFilePath } : {});
});
export const getRiskManager = riskManagerSingleton.get;
export const resetRiskManager = riskManagerSingleton.reset;
