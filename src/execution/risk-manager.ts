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
import { TradingMetrics } from '../utils/metrics.js';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

export interface RiskTrade {
  marketId: string;
  size: number;
  side: 'buy' | 'sell';
  estimatedNotional: number;
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
  tradingDay?: string;
  maxDrawdown?: number;
}

export class RiskManager {
  static readonly RECONCILE_TOLERANCE = 1e-6;
  private static readonly CONSERVATIVE_TAKER_FEE_RATE = 0.07;

  private positions: Map<string, Position> = new Map();
  private marketPrices: Map<string, number> = new Map();
  private dailyPnL = 0;
  private maxDailyPnL = 0;
  private minDailyPnL = 0;
  private maxDrawdown = 0;
  private tradingDay = currentTradingDay();
  private collateralBalance: number | undefined;
  private circuitBreakerTriggered = false;
  private logger = getLogger().child({ module: 'RiskManager' });
  private config: Required<Omit<RiskManagerConfig, 'stateFilePath'>>;
  private stateFilePath: string | undefined;

  constructor(config: RiskManagerConfig = {}) {
    this.config = validateRiskConfig({
      maxExposure: config.maxExposure ?? RISK_CONFIG.MAX_EXPOSURE,
      maxBetFraction: config.maxBetFraction ?? 0.5,
      maxDailyLoss: config.maxDailyLoss ?? RISK_CONFIG.MAX_DAILY_LOSS,
      emergencyStopThreshold: config.emergencyStopThreshold ?? RISK_CONFIG.EMERGENCY_STOP_THRESHOLD,
    });
    this.stateFilePath = config.stateFilePath;
    if (this.stateFilePath) {
      this.loadState();
    }
  }

  /**
   * Update risk manager configuration
   */
  updateConfig(config: RiskManagerConfig): void {
    this.config = validateRiskConfig({
      ...this.config,
      ...(config.maxExposure === undefined ? {} : { maxExposure: config.maxExposure }),
      ...(config.maxBetFraction === undefined ? {} : { maxBetFraction: config.maxBetFraction }),
      ...(config.maxDailyLoss === undefined ? {} : { maxDailyLoss: config.maxDailyLoss }),
      ...(config.emergencyStopThreshold === undefined
        ? {}
        : { emergencyStopThreshold: config.emergencyStopThreshold }),
    });
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
    return this.checkTrades([{ marketId, size, side, estimatedNotional }]);
  }

  /** Check a complete multi-leg projection against portfolio limits. */
  checkTrades(trades: readonly RiskTrade[]): RiskCheckResult {
    const startedAt = performance.now();
    try {
      return this.evaluateTrades(trades);
    } finally {
      TradingMetrics.riskCheckLatency.observe({}, performance.now() - startedAt);
    }
  }

  private evaluateTrades(trades: readonly RiskTrade[]): RiskCheckResult {
    this.ensureCurrentTradingDay();
    if (trades.length === 0 || trades.some((trade) => !isValidRiskTrade(trade))) {
      return { allowed: false, reason: 'Trade inputs are invalid', riskLevel: 'critical' };
    }

    const projectedPositions = new Map(
      Array.from(this.positions, ([marketId, position]) => [marketId, { ...position }])
    );
    let allReduceOnly = true;
    let requiredCollateral = 0;

    for (const trade of trades) {
      const currentPosition = projectedPositions.get(trade.marketId);
      const currentSize = currentPosition?.size ?? 0;
      const projectedSize = currentSize + (trade.side === 'buy' ? trade.size : -trade.size);
      const reduceOnly =
        trade.side === 'sell' &&
        currentSize > 0 &&
        projectedSize >= -RiskManager.RECONCILE_TOLERANCE;
      allReduceOnly &&= reduceOnly;

      // Outcome tokens cannot be sold short on the CLOB. Reconciliation must
      // establish inventory before a sell can pass this boundary.
      if (trade.side === 'sell' && !reduceOnly) {
        return {
          allowed: false,
          reason: `Sell would exceed reconciled position for ${trade.marketId}`,
          riskLevel: 'high',
        };
      }

      if (trade.side === 'buy') {
        requiredCollateral +=
          trade.estimatedNotional + trade.size * RiskManager.CONSERVATIVE_TAKER_FEE_RATE * 0.25;
      }

      if (Math.abs(projectedSize) < RiskManager.RECONCILE_TOLERANCE) {
        projectedPositions.delete(trade.marketId);
        continue;
      }

      const avgPrice =
        trade.side === 'buy'
          ? currentPosition && currentPosition.avgPrice <= 0
            ? 0
            : (currentSize * (currentPosition?.avgPrice ?? 0) + trade.estimatedNotional) /
              projectedSize
          : (currentPosition?.avgPrice ?? trade.estimatedNotional / trade.size);
      projectedPositions.set(trade.marketId, {
        marketId: trade.marketId,
        size: projectedSize,
        avgPrice,
        side: 'long',
        timestamp: Date.now(),
      });
    }

    // Check circuit breaker
    if (this.circuitBreakerTriggered && !allReduceOnly) {
      return {
        allowed: false,
        reason: 'Circuit breaker triggered - trading halted',
        riskLevel: 'critical',
      };
    }

    // Check daily loss limit
    if (this.dailyPnL <= -this.config.maxDailyLoss && !allReduceOnly) {
      this.triggerCircuitBreaker('Daily loss limit exceeded');
      return {
        allowed: false,
        reason: `Daily loss limit exceeded: ${String(this.dailyPnL)}`,
        riskLevel: 'critical',
      };
    }

    const newExposure = Array.from(projectedPositions.values()).reduce(
      (sum, position) => sum + this.getPositionExposure(position),
      0
    );

    // Check max exposure
    if (newExposure > this.config.maxExposure) {
      return {
        allowed: false,
        reason: `Max exposure would be exceeded: ${String(newExposure)} > ${String(this.config.maxExposure)}`,
        riskLevel: 'high',
      };
    }

    if (
      !allReduceOnly &&
      this.collateralBalance !== undefined &&
      requiredCollateral > this.collateralBalance
    ) {
      return {
        allowed: false,
        reason: `Insufficient reconciled collateral: ${String(requiredCollateral)} > ${String(this.collateralBalance)}`,
        riskLevel: 'high',
      };
    }

    const maxMarketExposure = this.config.maxExposure * this.config.maxBetFraction;
    for (const position of projectedPositions.values()) {
      const marketExposure = this.getPositionExposure(position);
      const currentExposure = this.getPositionExposure(this.positions.get(position.marketId));
      if (marketExposure > currentExposure && marketExposure > maxMarketExposure) {
        return {
          allowed: false,
          reason: `Market exposure would exceed per-market limit: ${String(marketExposure)} > ${String(maxMarketExposure)}`,
          riskLevel: 'medium',
        };
      }
    }

    return { allowed: true, riskLevel: 'low' };
  }

  isReduceOnlyTrade(marketId: string, size: number, side: 'buy' | 'sell'): boolean {
    if (side !== 'sell' || !Number.isFinite(size) || size <= 0) return false;
    const position = this.positions.get(marketId);
    return position !== undefined && position.size > 0 && size <= position.size + 1e-10;
  }

  /**
   * Update position after trade execution
   */
  updatePosition(orderStatus: OrderStatus, marketId: string, side: 'buy' | 'sell'): void {
    this.ensureCurrentTradingDay();
    if (!Number.isFinite(orderStatus.filledSize) || orderStatus.filledSize < 0) {
      this.triggerCircuitBreaker('Invalid filled size received from order adapter');
      return;
    }
    if (orderStatus.filledSize <= 0) {
      return;
    }
    if (
      marketId.trim() === '' ||
      !Number.isFinite(orderStatus.avgPrice) ||
      orderStatus.avgPrice <= 0 ||
      orderStatus.avgPrice >= 1
    ) {
      this.triggerCircuitBreaker('Invalid execution price received from order adapter');
      return;
    }

    const existingPosition = this.positions.get(marketId);
    const filledSize = side === 'buy' ? orderStatus.filledSize : -orderStatus.filledSize;

    // Conditional outcome-token inventory is long-only. If the adapter reports a
    // sell larger than local reconciled inventory, account state has drifted. Book
    // only the locally known close, stop adding exposure, and require reconciliation
    // instead of inventing a negative token position.
    if (
      side === 'sell' &&
      (!existingPosition ||
        existingPosition.size <= 0 ||
        orderStatus.filledSize > existingPosition.size + RiskManager.RECONCILE_TOLERANCE)
    ) {
      if (existingPosition?.size && existingPosition.size > 0) {
        if (existingPosition.avgPrice > 0) {
          this.dailyPnL += this.calculatePnL(
            existingPosition,
            orderStatus.avgPrice,
            existingPosition.size
          );
        }
        this.positions.delete(marketId);
        this.marketPrices.delete(marketId);
      }
      this.updatePnLTracking();
      this.triggerCircuitBreaker(`Sell fill exceeded reconciled position for ${marketId}`);
      this.persistState();
      return;
    }

    if (existingPosition) {
      const newSize = existingPosition.size + filledSize;
      const sameDirection = existingPosition.size * filledSize > 0;
      if (sameDirection) {
        const totalValue =
          Math.abs(existingPosition.size) * existingPosition.avgPrice +
          Math.abs(filledSize) * orderStatus.avgPrice;
        existingPosition.size = newSize;
        existingPosition.avgPrice =
          existingPosition.avgPrice <= 0 ? 0 : totalValue / Math.abs(newSize);
        existingPosition.timestamp = Date.now();
      } else {
        const closedSize = Math.min(Math.abs(existingPosition.size), Math.abs(filledSize));
        const costBasisKnown = existingPosition.avgPrice > 0;
        const pnl = costBasisKnown
          ? this.calculatePnL(existingPosition, orderStatus.avgPrice, closedSize)
          : 0;
        if (costBasisKnown) this.dailyPnL += pnl;
        if (Math.abs(newSize) < 1e-10) {
          this.positions.delete(marketId);
          this.marketPrices.delete(marketId);
          this.logger.info(`Position closed for ${marketId}`, { pnl });
        } else if (newSize * existingPosition.size > 0) {
          existingPosition.size = newSize;
          existingPosition.timestamp = Date.now();
          this.logger.info(`Position reduced for ${marketId}`, { newSize, pnl });
        }
      }
      if (this.positions.has(marketId)) {
        this.marketPrices.set(marketId, orderStatus.avgPrice);
      }
    } else {
      // New position
      this.positions.set(marketId, {
        marketId,
        size: filledSize,
        avgPrice: orderStatus.avgPrice,
        side: 'long',
        timestamp: Date.now(),
      });
      this.marketPrices.set(marketId, orderStatus.avgPrice);
      this.logger.debug(`New position for ${marketId}`, {
        size: filledSize,
        avgPrice: orderStatus.avgPrice,
      });
    }

    // The last reconciled collateral value is an upper bound until the next
    // exchange snapshot. Decrease it for local buys using the current maximum
    // platform taker-fee curve; do not optimistically add sell proceeds.
    if (side === 'buy' && this.collateralBalance !== undefined) {
      const protocolFee =
        orderStatus.filledSize *
        RiskManager.CONSERVATIVE_TAKER_FEE_RATE *
        orderStatus.avgPrice *
        (1 - orderStatus.avgPrice);
      this.collateralBalance = Math.max(
        0,
        this.collateralBalance - orderStatus.filledSize * orderStatus.avgPrice - protocolFee
      );
    }

    // Update PnL tracking
    this.updatePnLTracking();
    this.persistState();
  }

  /**
   * Update market mark price for unrealized PnL estimation
   */
  updateMarketPrice(marketId: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
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
    this.ensureCurrentTradingDay();
    const totalExposure = this.getTotalExposure();
    const unrealizedPnL = this.calculateUnrealizedPnL();

    return {
      totalExposure,
      dailyPnL: this.dailyPnL,
      unrealizedPnL,
      maxDrawdown: this.maxDrawdown,
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
    this.maxDrawdown = 0;
    this.tradingDay = currentTradingDay();
    this.logger.info('Daily PnL reset');
    this.persistState();
  }

  /**
   * Get all current positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values(), (position) => ({ ...position }));
  }

  /**
   * Get position for a specific market
   */
  getPosition(marketId: string): Position | undefined {
    const position = this.positions.get(marketId);
    return position ? { ...position } : undefined;
  }

  getPositionUnrealizedPnL(marketId: string): number | undefined {
    const position = this.positions.get(marketId);
    const markPrice = this.marketPrices.get(marketId);
    if (!position || position.avgPrice <= 0 || markPrice === undefined) {
      return undefined;
    }
    return (markPrice - position.avgPrice) * position.size;
  }

  setCollateralBalance(balance: number): void {
    if (!Number.isFinite(balance) || balance < 0) {
      this.triggerCircuitBreaker('Invalid collateral balance received during reconciliation');
      return;
    }
    this.collateralBalance = balance;
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
      if (!b.assetId || !Number.isFinite(b.size) || b.size < 0 || exchange.has(b.assetId)) {
        this.triggerCircuitBreaker('Invalid or duplicate exchange balance during reconciliation');
        throw new Error(
          `Invalid or duplicate exchange balance for ${b.assetId || 'missing asset'}`
        );
      }
      if (b.size > RiskManager.RECONCILE_TOLERANCE) {
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
        // The exchange balance endpoint has no acquisition history. Any external
        // size drift invalidates our blended cost basis, so keep PnL unknown until
        // an audited ledger supplies it instead of fabricating realized gains.
        pos.avgPrice = 0;
        pos.side = 'long';
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
          side: 'long',
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
      (sum, pos) => sum + this.getPositionExposure(pos),
      0
    );
  }

  private getPositionExposure(position: Position | undefined): number {
    if (!position) return 0;
    if (position.avgPrice > 0 && position.avgPrice < 1) {
      return Math.abs(position.size) * position.avgPrice;
    }
    const markPrice = this.marketPrices.get(position.marketId);
    return Math.abs(position.size) * (markPrice ?? 1);
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
    this.maxDrawdown = Math.max(this.maxDrawdown, this.maxDailyPnL - this.dailyPnL);
  }

  private ensureCurrentTradingDay(): void {
    const today = currentTradingDay();
    if (today === this.tradingDay) return;
    this.dailyPnL = 0;
    this.maxDailyPnL = 0;
    this.minDailyPnL = 0;
    this.maxDrawdown = 0;
    this.tradingDay = today;
    this.persistState();
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
      this.tradingDay = state.tradingDay ?? currentTradingDay();
      this.maxDrawdown = state.maxDrawdown ?? Math.max(0, this.maxDailyPnL - this.dailyPnL);
      this.ensureCurrentTradingDay();
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
      tradingDay: this.tradingDay,
      maxDrawdown: this.maxDrawdown,
    };
    const lockPath = `${this.stateFilePath}.lock`;
    let lockFd: number | undefined;
    let tmp: string | undefined;
    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true, mode: 0o700 });
      lockFd = openSync(lockPath, 'wx', 0o600);
      tmp = `${this.stateFilePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      const tmpFd = openSync(tmp, 'r');
      try {
        fsyncSync(tmpFd);
      } finally {
        closeSync(tmpFd);
      }
      renameSync(tmp, this.stateFilePath);
      const dirFd = openSync(dirname(this.stateFilePath), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      this.circuitBreakerTriggered = true;
      this.logger.error('Failed to persist risk state', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (tmp) {
        try {
          unlinkSync(tmp);
        } catch {
          // The rename may already have consumed the temp file.
        }
      }
      if (lockFd !== undefined) {
        closeSync(lockFd);
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the original persistence result.
        }
      }
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
    state.maxDailyPnL >= state.minDailyPnL &&
    state.maxDailyPnL >= state.dailyPnL &&
    state.minDailyPnL <= state.dailyPnL &&
    typeof state.circuitBreakerTriggered === 'boolean' &&
    (state.tradingDay === undefined || /^\d{4}-\d{2}-\d{2}$/.test(state.tradingDay)) &&
    (state.maxDrawdown === undefined ||
      (typeof state.maxDrawdown === 'number' &&
        Number.isFinite(state.maxDrawdown) &&
        state.maxDrawdown >= 0)) &&
    new Set(state.positions.map((position) => position.marketId)).size === state.positions.length
  );
}

function isValidRiskTrade(trade: RiskTrade): boolean {
  if (
    trade.marketId.trim() === '' ||
    !Number.isFinite(trade.size) ||
    trade.size <= 0 ||
    !Number.isFinite(trade.estimatedNotional) ||
    trade.estimatedNotional <= 0
  ) {
    return false;
  }
  const unitPrice = trade.estimatedNotional / trade.size;
  return unitPrice > 0 && unitPrice < 1;
}

function validateRiskConfig(
  config: Required<Omit<RiskManagerConfig, 'stateFilePath'>>
): Required<Omit<RiskManagerConfig, 'stateFilePath'>> {
  if (!Number.isFinite(config.maxExposure) || config.maxExposure <= 0) {
    throw new Error('maxExposure must be greater than zero');
  }
  if (
    !Number.isFinite(config.maxBetFraction) ||
    config.maxBetFraction <= 0 ||
    config.maxBetFraction > 1
  ) {
    throw new Error('maxBetFraction must be in (0, 1]');
  }
  if (!Number.isFinite(config.maxDailyLoss) || config.maxDailyLoss <= 0) {
    throw new Error('maxDailyLoss must be greater than zero');
  }
  if (!Number.isFinite(config.emergencyStopThreshold) || config.emergencyStopThreshold <= 0) {
    throw new Error('emergencyStopThreshold must be greater than zero');
  }
  return config;
}

function currentTradingDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
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
    Math.abs(position.size) > RiskManager.RECONCILE_TOLERANCE &&
    typeof position.avgPrice === 'number' &&
    Number.isFinite(position.avgPrice) &&
    position.avgPrice >= 0 &&
    position.avgPrice < 1 &&
    position.side === 'long' &&
    position.size > 0 &&
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
