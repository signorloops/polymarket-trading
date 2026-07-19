/**
 * Shared Polymarket taker-fee helpers (EXEC-10).
 *
 * Platform fee ≈ rate · (p(1−p))^exponent. For exponent > 0 the factor
 * p(1−p) peaks at 1/4 when p = 1/2, so the global maximum fee factor is
 * (1/4)^exponent — not a hardcoded 0.25 (wrong when exponent ≠ 1).
 */

export const DEFAULT_TAKER_FEE_RATE = 0.07;
export const DEFAULT_TAKER_FEE_EXPONENT = 1;

/** Clamp fee exponent to the platform-supported range. */
export function normalizeTakerFeeExponent(exponent: number): number {
  if (!Number.isFinite(exponent) || exponent < 0) return DEFAULT_TAKER_FEE_EXPONENT;
  return Math.min(exponent, 10);
}

/**
 * Max value of (p(1−p))^exponent over p ∈ (0,1).
 * For exponent = 0 the fee is flat (factor 1).
 */
export function maxTakerFeeFactor(exponent: number): number {
  const e = normalizeTakerFeeExponent(exponent);
  if (e === 0) return 1;
  return Math.pow(0.25, e);
}

/** Fee in quote units for `size` shares at price `p`. */
export function estimateTakerFee(
  size: number,
  price: number,
  rate: number = DEFAULT_TAKER_FEE_RATE,
  exponent: number = DEFAULT_TAKER_FEE_EXPONENT
): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return reserveTakerFee(size, rate, exponent);
  }
  const e = normalizeTakerFeeExponent(exponent);
  const safeRate = Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_TAKER_FEE_RATE;
  return size * safeRate * Math.pow(price * (1 - price), e);
}

/**
 * Conservative collateral reserve when the fill price is unknown (or out of
 * range): size · rate · max_p (p(1−p))^exponent.
 */
export function reserveTakerFee(
  size: number,
  rate: number = DEFAULT_TAKER_FEE_RATE,
  exponent: number = DEFAULT_TAKER_FEE_EXPONENT
): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  const safeRate = Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_TAKER_FEE_RATE;
  return size * safeRate * maxTakerFeeFactor(exponent);
}
