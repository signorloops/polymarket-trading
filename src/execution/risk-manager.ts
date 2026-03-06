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

export interface RiskManagerConfig {
  maxExposure?: number;
  maxBetFraction?: number;
  maxDailyLoss?: number;
  emergencyStopThreshold?: number;
}

export class RiskManager {
  private positions: Map<string, Position> = new Map();
  private marketPrices: Map<string, number> = new Map();
  private dailyPnL = 0;
  private maxDailyPnL = 0;
  private minDailyPnL = 0;
  private circuitBreakerTriggered = false;
  private logger = getLogger().child({ module: 'RiskManager' });
  private config: Required<RiskManagerConfig>;

  constructor(config: RiskManagerConfig = {}) {
    this.config = {
      maxExposure: config.maxExposure ?? RISK_CONFIG.MAX_EXPOSURE,
      maxBetFraction: config.maxBetFraction ?? 0.5,
      maxDailyLoss: config.maxDailyLoss ?? RISK_CONFIG.MAX_DAILY_LOSS,
      emergencyStopThreshold: config.emergencyStopThreshold ?? RISK_CONFIG.EMERGENCY_STOP_THRESHOLD,
    };
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
    }
  }

  /**
   * Reset circuit breaker (manual override)
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerTriggered = false;
    this.logger.info('Circuit breaker reset');
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
}

/**
 * Global risk manager instance
 */
const riskManagerSingleton = createSingleton(() => new RiskManager());
export const getRiskManager = riskManagerSingleton.get;
export const resetRiskManager = riskManagerSingleton.reset;
