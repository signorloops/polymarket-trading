import {
  PolymarketTradingSystem,
  type TradingSystemConfig,
} from '../../src/index.js';
import { jest } from '@jest/globals';
import {
  getRiskManager,
  resetRiskManager,
} from '../../src/execution/risk-manager.js';
import type { ArbitrageOpportunity } from '../../src/market/arbitrage-detector.js';

describe('PolymarketTradingSystem', () => {
  beforeEach(() => {
    resetRiskManager();
  });

  afterEach(() => {
    resetRiskManager();
  });

  it('should pass non-zero size and notional into risk check', async () => {
    const config: TradingSystemConfig = {
      liveTrading: false,
      markets: [],
      events: [],
    };
    const system = new PolymarketTradingSystem(config);

    const opportunity: ArbitrageOpportunity = {
      id: 'arb-test',
      type: 'single-market',
      markets: ['market-yes', 'market-no'],
      expectedProfit: 0.08,
      guaranteedProfit: 0.08,
      confidence: 0.9,
      tradeDirection: [0.3, 0.2],
      timestamp: Date.now(),
      expiresAt: Date.now() + 60000,
    };

    const riskManager = getRiskManager();
    const checkSpy = jest.spyOn(riskManager, 'checkTrade');

    await system.executeOpportunity(opportunity);

    expect(checkSpy).toHaveBeenCalledTimes(1);
    const [_marketId, size, _side, notional] = checkSpy.mock.calls[0]!;
    expect(size).toBeGreaterThan(0);
    expect(notional).toBeGreaterThan(0);
  });
});
