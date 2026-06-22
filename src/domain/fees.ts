export const SPORTS_TAKER_FEE_RATE = 0.03;

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
