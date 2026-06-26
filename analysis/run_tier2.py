"""Entry point for the Tier 2 random-control run.

Usage (from repo root):
    uv run --project analysis python analysis/run_tier2.py
"""
from __future__ import annotations

from pathlib import Path

from random_control import io, metrics, report, tier2

REPO_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    print("[1/4] metrics self-test...")
    metrics.self_test()
    print("      OK\n")

    print("[2/4] loading trades...")
    window_trades = io.trades_dataframe()
    n_cells = (window_trades["trades"].map(len) > 0).sum()
    n_total_trades = window_trades["trades"].map(len).sum()
    print(f"      {len(window_trades)} (candidate, window) cells, {n_cells} non-empty, {n_total_trades} trades total\n")

    print("[3/4] running Tier 2 cluster bootstrap (B=10,000)...")
    table = tier2.run_tier2(window_trades, n_iter=10_000, seed=0)
    out_csv = REPO_ROOT / "data" / "random_control_tier2.csv"
    table.to_csv(out_csv, index=False)
    print(f"      wrote {out_csv} ({len(table)} (strategy, window) rows)\n")

    print("[4/4] rendering verdict report...")
    out_md = REPO_ROOT / "docs" / "random_control_tier2_report.md"
    report.render(table, out_md)
    print(f"      wrote {out_md}")


if __name__ == "__main__":
    main()
