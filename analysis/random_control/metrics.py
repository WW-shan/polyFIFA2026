"""Per-share fee and net-ROI for Polymarket sports BUYs.

Matches `src/domain/fees.ts` exactly. Self-test against the published CSV
numbers in `docs/loss_requires_two_goals_strategy_backtest.md` before any
random-control statistic is computed.
"""
from __future__ import annotations

SPORTS_TAKER_FEE_RATE = 0.03


def fee_per_share(price: float, fee_rate: float = SPORTS_TAKER_FEE_RATE) -> float:
    if not (0.0 < price < 1.0):
        raise ValueError(f"price must be in (0,1); got {price}")
    return fee_rate * price * (1.0 - price)


def net_roi(price: float, fee_rate: float = SPORTS_TAKER_FEE_RATE) -> float:
    return (1.0 - price - fee_per_share(price, fee_rate)) / price


def hit_rate_le(prices, threshold: float) -> float:
    n = 0
    hits = 0
    for p in prices:
        n += 1
        if p <= threshold:
            hits += 1
    return hits / n if n else 0.0


def self_test() -> None:
    """Match the backtest doc anchor points. Drift means loader/formula broke."""
    anchors = [
        (0.99, 0.980),
        (0.98, 1.980),
        (0.97, 3.003),
        (0.95, 5.113),
        (0.93, 7.317),
        (0.781, 27.384),
    ]
    for price, expected_pct in anchors:
        got_pct = 100.0 * net_roi(price)
        if abs(got_pct - expected_pct) > 0.01:
            raise AssertionError(
                f"net_roi({price}) -> {got_pct:.4f}% expected ~{expected_pct:.4f}%"
            )


if __name__ == "__main__":
    self_test()
    print("metrics self-test: OK")
