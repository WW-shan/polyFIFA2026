"""Entry point for Tier 3 universe-null random-control run.

Usage (after fetch_universe_trades.py has populated the cache):
    uv run --project analysis python analysis/run_tier3.py
"""
from __future__ import annotations

from pathlib import Path

from random_control import io, metrics, tier3

REPO_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    print("[1/4] metrics self-test...")
    metrics.self_test()
    print("      OK\n")

    print("[2/4] loading strategy + universe trades...")
    strat_trades = io.trades_dataframe()
    universe_trades = tier3.load_universe_window_trades()
    print(f"      strategy: {len(strat_trades)} (candidate, window) rows")
    print(f"      universe: {len(universe_trades)} (control, window) rows\n")

    print("[3/4] running Tier 3 cluster bootstrap (B=10,000)...")
    table = tier3.run_tier3(strat_trades, universe_trades, n_iter=10_000, seed=0)
    out_csv = REPO_ROOT / "data" / "random_control_tier3.csv"
    table.to_csv(out_csv, index=False)
    print(f"      wrote {out_csv}\n")

    print("[4/4] rendering verdict report...")
    out_md = REPO_ROOT / "docs" / "random_control_tier3_report.md"
    tier3.render_tier3_report(table, out_md)
    print(f"      wrote {out_md}")


if __name__ == "__main__":
    main()
