import { jest } from '@jest/globals';

import type { TradingBalanceClient } from '../../src/api/trading-client.js';
import { reconcileConfiguredBalances } from '../../src/execution/balance-reconciliation.js';
import { RiskManager } from '../../src/execution/risk-manager.js';

function createClient(getBalances: TradingBalanceClient['getBalances']): TradingBalanceClient {
  return {
    getBalances,
    placeOrder: jest.fn(),
    cancelOrder: jest.fn(),
    getOrder: jest.fn(),
    getCollateralBalance: jest.fn().mockResolvedValue({
      size: 100,
      allowances: { exchange: 100 },
    }),
  } as TradingBalanceClient;
}

describe('reconcileConfiguredBalances', () => {
  it('applies one complete exchange snapshot to persisted risk positions', async () => {
    const riskManager = new RiskManager();
    riskManager.updatePosition(
      {
        orderId: 'old',
        status: 'filled',
        filledSize: 2,
        remainingSize: 0,
        avgPrice: 0.4,
        timestamp: 1,
      },
      'token-a',
      'buy'
    );
    const client = createClient(jest.fn().mockResolvedValue([{ assetId: 'token-a', size: 3 }]));

    const report = await reconcileConfiguredBalances(riskManager, client, ['token-a', 'token-a']);

    expect(client.getBalances).toHaveBeenCalledWith(['token-a']);
    expect(report.synced).toEqual(['token-a']);
    expect(report.collateral.size).toBe(100);
    expect(riskManager.getPosition('token-a')?.size).toBe(3);
  });

  it('rejects an incomplete snapshot without mutating risk state', async () => {
    const riskManager = new RiskManager();
    riskManager.updatePosition(
      {
        orderId: 'old',
        status: 'filled',
        filledSize: 2,
        remainingSize: 0,
        avgPrice: 0.4,
        timestamp: 1,
      },
      'token-a',
      'buy'
    );
    const client = createClient(jest.fn().mockResolvedValue([]));

    await expect(reconcileConfiguredBalances(riskManager, client, ['token-a'])).rejects.toThrow(
      /omitted token ids/
    );
    expect(riskManager.getPosition('token-a')?.size).toBe(2);
  });
});
