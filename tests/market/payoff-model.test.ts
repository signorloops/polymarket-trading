import {
  findDollarPayoffArbitrage,
  validatePayoffModel,
  type CrossMarketPayoffModel,
} from '../../src/market/payoff-model.js';

const implicationModel: CrossMarketPayoffModel = {
  id: 'primary-implies-election',
  marketIds: ['primary-yes', 'election-no'],
  feeBufferBps: 100,
  scenarios: [
    { id: 'wins-both', payouts: [1, 0] },
    { id: 'wins-primary-loses-election', payouts: [1, 1] },
    { id: 'loses-primary', payouts: [0, 1] },
  ],
};

describe('findDollarPayoffArbitrage', () => {
  it('returns an explicit fee-adjusted USD guarantee for an exhaustive payoff cover', () => {
    const opportunity = findDollarPayoffArbitrage(implicationModel, [
      { marketId: 'primary-yes', askPrice: 0.4, availableSize: 10 },
      { marketId: 'election-no', askPrice: 0.5, availableSize: 10 },
    ]);

    expect(opportunity).not.toBeNull();
    expect(opportunity?.quantities).toEqual([1, 1]);
    expect(opportunity?.grossCostUsd).toBeCloseTo(0.9, 8);
    expect(opportunity?.feeBufferUsd).toBeCloseTo(0.009, 8);
    expect(opportunity?.guaranteedPayoutUsd).toBeCloseTo(1, 8);
    expect(opportunity?.guaranteedProfitUsd).toBeCloseTo(0.091, 8);
    expect(opportunity?.scenarioProfitsUsd.map((scenario) => scenario.profitUsd)).toEqual([
      expect.closeTo(0.091, 8),
      expect.closeTo(1.091, 8),
      expect.closeTo(0.091, 8),
    ]);
  });

  it('returns null when fees eliminate the dollar profit', () => {
    expect(
      findDollarPayoffArbitrage({ ...implicationModel, feeBufferBps: 1_000 }, [
        { marketId: 'primary-yes', askPrice: 0.45, availableSize: 10 },
        { marketId: 'election-no', askPrice: 0.46, availableSize: 10 },
      ])
    ).toBeNull();
  });

  it('returns null when displayed depth cannot fund the complete cover', () => {
    expect(
      findDollarPayoffArbitrage(implicationModel, [
        { marketId: 'primary-yes', askPrice: 0.4, availableSize: 0.5 },
        { marketId: 'election-no', askPrice: 0.5, availableSize: 10 },
      ])
    ).toBeNull();
  });

  it('does not treat a one-contract solution as cross-market arbitrage', () => {
    const alwaysPaysModel: CrossMarketPayoffModel = {
      id: 'degenerate',
      marketIds: ['cash-like', 'other'],
      feeBufferBps: 0,
      scenarios: [
        { id: 'one', payouts: [1, 0] },
        { id: 'two', payouts: [1, 1] },
      ],
    };

    expect(
      findDollarPayoffArbitrage(alwaysPaysModel, [
        { marketId: 'cash-like', askPrice: 0.5, availableSize: 10 },
        { marketId: 'other', askPrice: 0.1, availableSize: 10 },
      ])
    ).toBeNull();
  });

  it('requires every executable quote and validates scenario dimensions', () => {
    expect(
      findDollarPayoffArbitrage(implicationModel, [
        { marketId: 'primary-yes', askPrice: 0.4, availableSize: 10 },
      ])
    ).toBeNull();

    expect(() =>
      validatePayoffModel({
        ...implicationModel,
        scenarios: [
          { id: 'broken', payouts: [1] },
          { id: 'other', payouts: [0, 1] },
        ],
      })
    ).toThrow(/wrong dimension/);
  });
});
