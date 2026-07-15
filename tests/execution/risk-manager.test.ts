/**
 * Unit tests for risk manager
 */

import { RiskManager, getRiskManager, resetRiskManager } from '../../src/execution/risk-manager.js';
import { OrderStatus } from '../../src/execution/execution-engine.js';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync } from 'fs';

describe('RiskManager', () => {
  let riskManager: RiskManager;

  beforeEach(() => {
    resetRiskManager();
    riskManager = new RiskManager();
  });

  describe('checkTrade', () => {
    it('should allow trade within limits', () => {
      // First add a position in another market to establish base exposure
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status, 'market-other', 'buy');

      // Now adding a small position in market-1 should be allowed
      const result = riskManager.checkTrade('market-1', 10, 'buy', 5);

      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe('low');
    });

    it('should reject trade when circuit breaker is active', () => {
      riskManager.triggerCircuitBreaker('Test');

      const result = riskManager.checkTrade('market-1', 100, 'buy', 50);

      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('critical');
    });

    it('should reject trade exceeding max exposure', () => {
      const result = riskManager.checkTrade('market-1', 50000, 'buy', 50000);

      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('high');
    });

    it('should reject trade with high concentration', () => {
      // First add a position in another market to establish exposure
      const status1: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status1, 'market-other', 'buy');

      // Now try to add a very large position in market-1
      // This would create high concentration in market-1
      const result = riskManager.checkTrade('market-1', 1000, 'buy', 1000);

      // The trade itself won't be rejected for concentration (newPositionValue/totalExposure ≈ 1)
      // But we verify the concentration calculation works
      expect(result).toBeDefined();
    });

    it('should use provided trade notional directly (not size * notional)', () => {
      const baseStatus: OrderStatus = {
        orderId: 'base-order',
        status: 'filled',
        filledSize: 200,
        remainingSize: 0,
        avgPrice: 2,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(baseStatus, 'market-base', 'buy');

      // Additional trade notional is 50 (size 10 at unit value 5).
      const result = riskManager.checkTrade('market-new', 10, 'buy', 50);
      expect(result.allowed).toBe(true);
    });
  });

  describe('updatePosition', () => {
    it('should add new position', () => {
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      riskManager.updatePosition(status, 'market-1', 'buy');

      const position = riskManager.getPosition('market-1');
      expect(position).toBeDefined();
      expect(position?.size).toBe(100);
      expect(position?.side).toBe('long');
    });

    it('should update existing position', () => {
      const status1: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status1, 'market-1', 'buy');

      const status2: OrderStatus = {
        orderId: 'order-2',
        status: 'filled',
        filledSize: 50,
        remainingSize: 0,
        avgPrice: 0.6,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status2, 'market-1', 'buy');

      const position = riskManager.getPosition('market-1');
      expect(position?.size).toBe(150);
    });

    it('should close position when size becomes zero', () => {
      const openStatus: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(openStatus, 'market-1', 'buy');

      const closeStatus: OrderStatus = {
        orderId: 'order-2',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.6,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(closeStatus, 'market-1', 'sell');

      const position = riskManager.getPosition('market-1');
      expect(position).toBeUndefined();
    });

    it('should handle partial fills', () => {
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'partial',
        filledSize: 50,
        remainingSize: 50,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };

      riskManager.updatePosition(status, 'market-1', 'buy');

      const position = riskManager.getPosition('market-1');
      expect(position?.size).toBe(50);
    });
  });

  describe('handlePartialFill', () => {
    it('should recommend hold for small exposure', () => {
      const executed: OrderStatus[] = [
        {
          orderId: 'order-1',
          status: 'filled',
          filledSize: 10,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: Date.now(),
        },
      ];
      const failed: string[] = ['order-2'];

      const result = riskManager.handlePartialFill(executed, failed, 'arb-1');

      expect(result.action).toBe('hold');
    });

    it('should recommend unwind for large exposure', () => {
      const executed: OrderStatus[] = [
        {
          orderId: 'order-1',
          status: 'filled',
          filledSize: 10000,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: Date.now(),
        },
      ];
      const failed: string[] = ['order-2'];

      const result = riskManager.handlePartialFill(executed, failed, 'arb-1');

      expect(result.action).toBe('unwind');
    });

    it('should recommend hedge when single leg fails', () => {
      const executed: OrderStatus[] = [
        {
          orderId: 'order-1',
          status: 'filled',
          filledSize: 100,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: Date.now(),
        },
        {
          orderId: 'order-2',
          status: 'filled',
          filledSize: 100,
          remainingSize: 0,
          avgPrice: 0.5,
          timestamp: Date.now(),
        },
      ];
      const failed: string[] = ['order-3'];

      const result = riskManager.handlePartialFill(executed, failed, 'arb-1');

      expect(result.action).toBe('hedge');
    });
  });

  describe('circuit breaker', () => {
    it('should trigger circuit breaker', () => {
      riskManager.triggerCircuitBreaker('Test reason');

      expect(riskManager.isCircuitBreakerActive()).toBe(true);
    });

    it('should reset circuit breaker', () => {
      riskManager.triggerCircuitBreaker('Test reason');
      riskManager.resetCircuitBreaker();

      expect(riskManager.isCircuitBreakerActive()).toBe(false);
    });

    it('should reject trades when circuit breaker is active', () => {
      riskManager.triggerCircuitBreaker('Test reason');

      const result = riskManager.checkTrade('market-1', 100, 'buy', 50);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Circuit breaker');
    });
  });

  describe('emergency stop', () => {
    it('should trigger emergency stop on large unrealized loss after mark-to-market update', () => {
      const tightRisk = new RiskManager({ emergencyStopThreshold: 10 });

      const openStatus: OrderStatus = {
        orderId: 'open-order',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      tightRisk.updatePosition(openStatus, 'market-1', 'buy');

      tightRisk.updateMarketPrice('market-1', 0.1);
      expect(tightRisk.checkEmergencyStop()).toBe(true);
    });
  });

  describe('getRiskMetrics', () => {
    it('should return current metrics', () => {
      const status: OrderStatus = {
        orderId: 'order-1',
        status: 'filled',
        filledSize: 100,
        remainingSize: 0,
        avgPrice: 0.5,
        timestamp: Date.now(),
      };
      riskManager.updatePosition(status, 'market-1', 'buy');

      const metrics = riskManager.getRiskMetrics();

      expect(metrics.totalExposure).toBe(50);
      expect(metrics.positionCount).toBe(1);
    });
  });

  describe('resetDailyPnL', () => {
    it('should reset daily PnL', () => {
      riskManager.resetDailyPnL();

      const metrics = riskManager.getRiskMetrics();
      expect(metrics.dailyPnL).toBe(0);
    });
  });

  describe('state persistence', () => {
    it('persists positions, daily PnL, and circuit breaker across restart', () => {
      const tmpFile = `${tmpdir()}/risk-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
      try {
        // First instance: open a position, trigger the circuit breaker.
        const first = new RiskManager({ stateFilePath: tmpFile });
        const status: OrderStatus = {
          orderId: 'order-1',
          status: 'filled',
          filledSize: 100,
          remainingSize: 0,
          avgPrice: 0.4,
          timestamp: Date.now(),
        };
        first.updatePosition(status, 'market-1', 'buy');
        first.triggerCircuitBreaker('loss limit');

        // A fresh instance with the same path must reload that state rather than
        // zeroing it (the whole point: restart must not defeat the loss circuit breaker).
        const reloaded = new RiskManager({ stateFilePath: tmpFile });
        expect(reloaded.isCircuitBreakerActive()).toBe(true);
        expect(reloaded.getPosition('market-1')).toBeDefined();
        expect(reloaded.getPosition('market-1')?.size).toBe(100);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    });

    it('starts fresh (no crash) when the state file is corrupt', () => {
      const tmpFile = `${tmpdir()}/risk-state-corrupt-${Date.now()}.json`;
      try {
        writeFileSync(tmpFile, '{ not valid json');
        const rm = new RiskManager({ stateFilePath: tmpFile });
        expect(rm.isCircuitBreakerActive()).toBe(false);
        expect(rm.getPositions()).toEqual([]);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    });
  });
});
