import {
  DEFAULT_TAKER_FEE_RATE,
  estimateTakerFee,
  maxTakerFeeFactor,
  reserveTakerFee,
} from '../../src/execution/taker-fee.js';

describe('taker-fee helpers (EXEC-10)', () => {
  it('peaks at (1/4)^exponent for the platform fee curve', () => {
    expect(maxTakerFeeFactor(1)).toBeCloseTo(0.25, 10);
    expect(maxTakerFeeFactor(2)).toBeCloseTo(0.0625, 10);
    // exponent < 1 must reserve MORE than 0.25, not less
    expect(maxTakerFeeFactor(0.5)).toBeCloseTo(0.5, 10);
  });

  it('estimates fee at a known price with the configured exponent', () => {
    const fee = estimateTakerFee(100, 0.5, 0.07, 1);
    expect(fee).toBeCloseTo(100 * 0.07 * 0.25, 10);
  });

  it('reserves the global peak when price is unknown', () => {
    expect(reserveTakerFee(100, DEFAULT_TAKER_FEE_RATE, 1)).toBeCloseTo(100 * 0.07 * 0.25, 10);
    expect(reserveTakerFee(100, 0.07, 0.5)).toBeCloseTo(100 * 0.07 * 0.5, 10);
  });
});
