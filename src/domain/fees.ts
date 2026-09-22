// Official Polymarket sports category taker fee rate. The venue exposes this
// per market as `fd.r` on GET /clob-markets/{conditionId}; every sports market
// sampled from this project's universe reports 0.05 with exponent 1, and the
// published fee table charges 1.05 USDC per 100 shares at a 0.70 entry.
export const SPORTS_TAKER_FEE_RATE = 0.05;

export function sportsTakerFeePerShare(price: number, feeRate = SPORTS_TAKER_FEE_RATE): number {
  assertProbability(price, "price");
  return feeRate * price * (1 - price);
}

export function netReturnRate(price: number, feeRate = SPORTS_TAKER_FEE_RATE): number {
  assertProbability(price, "price");
  return (1 - price - sportsTakerFeePerShare(price, feeRate)) / price;
}

function assertProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}
