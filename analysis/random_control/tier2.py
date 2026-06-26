"""Tier 2 — within-window time-randomization.

Tests whether the min-price fill the backtest brags about is an outlier in
its own window, or whether the window is genuinely cheap throughout.

The strategy stat per (strategy, window) cell:
    observed_min_price       = min(t.price for t in trades)
    observed_min_net_roi     = net_roi(observed_min_price)
    observed_prob_le_X       = 1[observed_min_price <= X]

Random-pick (null) stat per cell:
    pick one trade uniformly at random from trades
    pick_price -> pick_net_roi, pick_le_X (boolean)
    averaged over n_iter draws inside the cell -> cell-level mean

We then aggregate cells by (strategy, window) AT THE MATCH-DATE LEVEL using a
cluster bootstrap: resample slug groups with replacement and recompute the
strategy/random means per resample. CI percentile + one-sided p.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .metrics import net_roi


@dataclass
class Tier2Cell:
    strategy: str
    window_sec: int
    slug: str
    n_trades: int
    observed_min_price: float
    observed_min_net_roi_pct: float
    observed_le_099: int
    observed_le_098: int
    observed_le_097: int
    random_pick_mean_price: float
    random_pick_mean_net_roi_pct: float
    random_pick_prob_le_099: float
    random_pick_prob_le_098: float
    random_pick_prob_le_097: float


def _cell_metrics(trades: list[dict]) -> dict | None:
    """Per-cell strategy + analytical-random metrics (closed-form, no MC).

    Analytical-random is exact: for uniform pick, prob_le_X = mean(1[p<=X])
    and mean_net_roi = mean(net_roi(p)). MC isn't needed at the cell layer.
    """
    if not trades:
        return None
    prices = np.array([t["price"] for t in trades], dtype=float)
    prices = prices[(prices > 0) & (prices < 1)]
    if prices.size == 0:
        return None

    obs_min = float(prices.min())
    rois = np.array([net_roi(p) for p in prices])
    return {
        "n_trades": int(prices.size),
        "observed_min_price": obs_min,
        "observed_min_net_roi_pct": float(net_roi(obs_min) * 100.0),
        "observed_le_099": int(obs_min <= 0.99),
        "observed_le_098": int(obs_min <= 0.98),
        "observed_le_097": int(obs_min <= 0.97),
        "random_pick_mean_price": float(prices.mean()),
        "random_pick_mean_net_roi_pct": float(rois.mean() * 100.0),
        "random_pick_prob_le_099": float((prices <= 0.99).mean()),
        "random_pick_prob_le_098": float((prices <= 0.98).mean()),
        "random_pick_prob_le_097": float((prices <= 0.97).mean()),
    }


def build_cell_table(window_trades_df: pd.DataFrame) -> pd.DataFrame:
    """One row per (strategy, window, slug, token) cell; only cells with trades."""
    rows = []
    for row in window_trades_df.itertuples(index=False):
        m = _cell_metrics(row.trades)
        if m is None:
            continue
        rows.append({
            "strategy": row.strategy,
            "window_sec": row.window_sec,
            "slug": row.slug,
            "token": row.token,
            "title": row.title,
            **m,
        })
    return pd.DataFrame(rows)


def _cluster_bootstrap_diff(
    cells: pd.DataFrame,
    strat_col: str,
    rand_col: str,
    n_iter: int,
    seed: int,
) -> tuple[float, float, tuple[float, float], float]:
    """Cluster-bootstrap by slug. Returns:
        (mean_strat, mean_rand, CI95_on_diff, p_one_sided_strat_gt_rand)
    """
    if cells.empty:
        return float("nan"), float("nan"), (float("nan"), float("nan")), float("nan")

    slugs = cells["slug"].unique()
    rng = np.random.default_rng(seed)

    def mean_for(sample_slugs: np.ndarray) -> tuple[float, float]:
        sub = cells[cells["slug"].isin(sample_slugs)]
        if sub.empty:
            return float("nan"), float("nan")
        per_slug = sub.groupby("slug")[[strat_col, rand_col]].mean()
        return float(per_slug[strat_col].mean()), float(per_slug[rand_col].mean())

    observed_strat, observed_rand = mean_for(slugs)
    observed_diff = observed_strat - observed_rand

    diffs = np.empty(n_iter, dtype=float)
    for i in range(n_iter):
        sample = rng.choice(slugs, size=len(slugs), replace=True)
        s, r = mean_for(sample)
        diffs[i] = s - r

    ci_lo, ci_hi = np.percentile(diffs, [2.5, 97.5])
    p_one_sided = float((diffs <= 0).mean())
    return observed_strat, observed_rand, (float(ci_lo), float(ci_hi)), p_one_sided


def run_tier2(
    window_trades_df: pd.DataFrame,
    n_iter: int = 10_000,
    seed: int = 0,
) -> pd.DataFrame:
    """Returns one row per (strategy, window) with strategy vs random stats."""
    cells = build_cell_table(window_trades_df)
    if cells.empty:
        return pd.DataFrame()

    results = []
    for (strategy, window_sec), group in cells.groupby(["strategy", "window_sec"]):
        events = len(group)
        events_with_trades = int((group["n_trades"] > 0).sum())

        # --- min-net-roi: observed min vs random-pick mean
        roi_strat_obs, roi_rand_obs, roi_ci, roi_p = _cluster_bootstrap_diff(
            group,
            strat_col="observed_min_net_roi_pct",
            rand_col="random_pick_mean_net_roi_pct",
            n_iter=n_iter,
            seed=seed,
        )

        # --- hit-rate le 0.99: observed (min hits) vs random-pick prob
        hr_strat_obs, hr_rand_obs, hr_ci, hr_p = _cluster_bootstrap_diff(
            group,
            strat_col="observed_le_099",
            rand_col="random_pick_prob_le_099",
            n_iter=n_iter,
            seed=seed,
        )

        results.append({
            "strategy": strategy,
            "window_sec": int(window_sec),
            "events": events,
            "events_with_trades": events_with_trades,
            "obs_mean_min_net_roi_pct": roi_strat_obs,
            "rand_mean_pick_net_roi_pct": roi_rand_obs,
            "roi_diff_ci_lo": roi_ci[0],
            "roi_diff_ci_hi": roi_ci[1],
            "roi_p_strat_gt_rand": roi_p,
            "obs_hit_rate_le_099": hr_strat_obs,
            "rand_hit_rate_le_099": hr_rand_obs,
            "hit_rate_diff_ci_lo": hr_ci[0],
            "hit_rate_diff_ci_hi": hr_ci[1],
            "hit_rate_p_strat_gt_rand": hr_p,
        })

    return pd.DataFrame(results).sort_values(["window_sec", "strategy"]).reset_index(drop=True)
