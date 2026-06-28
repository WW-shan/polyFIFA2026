"""Tier 3 — universe-null random control.

For each match-window, compare:
- strategy_best: among candidates that pass lossRequiresGoals>=2, the cheapest
  fill (this is what the live bot would actually buy because runner.ts picks
  highest estimatedNetReturn = lowest price).
- control_best: among NON-strategy markets in the same match, the cheapest
  fill ON THE EVENTUAL WINNING SIDE (so we don't penalize the universe with
  losing-side trades that price near 0 by definition).

If control_best matches or beats strategy_best, the lossRequiresGoals filter
adds zero value: the live bot might as well buy any tail-window FIFWC market.
If strategy_best wins materially, the filter has real alpha.

Cluster bootstrap by `slug` (match-date) preserves within-match correlation.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from . import io as io_module
from .metrics import net_roi
from .tier2 import build_cell_table

REPO_DATA = io_module.DATA_DIR


def _load_resolutions() -> dict[str, dict]:
    """conditionId -> resolution info (winnerIndex, outcomes, asset->outcomeIndex)."""
    import json
    path = REPO_DATA / "market_resolutions.json"
    if not path.exists():
        return {}
    return {r["conditionId"]: r for r in json.loads(path.read_text())}


def _load_market_token_to_outcome() -> dict[str, dict[str, int]]:
    """conditionId -> {clobTokenId: outcomeIndex}."""
    import json
    path = REPO_DATA / "event_markets_universe.json"
    if not path.exists():
        return {}
    out: dict[str, dict[str, int]] = {}
    for m in json.loads(path.read_text()):
        cid = m.get("conditionId")
        tokens = m.get("clobTokenIds") or []
        if cid and tokens:
            out[cid] = {tok: i for i, tok in enumerate(tokens)}
    return out


def load_universe_window_trades(
    filter_winning_side: bool = True,
    exclude_locked_equivalents: bool = True,
    locked_threshold: float = 0.95,
    ex_ante_favorite_only: bool = True,
    ex_ante_favorite_min_price: float = 0.85,
) -> pd.DataFrame:
    """Flatten data/universe_tail_trades.json into the same shape iter_window_trades uses.

    Filters applied (all default-on for fair vs-strategy comparison):

    - ``filter_winning_side``: drop trades whose `asset` is NOT the resolved
      winning outcome. Otherwise the universe is dominated by losing-side BUYs
      that ended at $0 — by definition impossible to profit from.
    - ``exclude_locked_equivalents``: drop markets whose winning-side EARLIEST
      trade in 480s already prices >= ``locked_threshold`` (default 0.95). These
      are universe analogues of Tier 2's `*_locked` classes — orderbook-lag fills
      not realistically tradeable.
    - ``ex_ante_favorite_only``: drop markets whose winning side was NOT the
      ex-ante favorite at start of the 480s window (>= ``ex_ante_favorite_min_price``,
      default 0.85). Without this filter, the control silently uses end-of-match
      winner knowledge to keep longshot markets that paid off in hindsight — a
      privilege the strategy doesn't have. Strategy's `lossRequiresGoals>=2` is
      an ex-ante predicate on current score; control must be ex-ante too.
    """
    import json
    path = REPO_DATA / "universe_tail_trades.json"
    rows = json.loads(path.read_text())
    resolutions = _load_resolutions() if filter_winning_side else {}
    token_outcome = _load_market_token_to_outcome() if filter_winning_side else {}

    flat = []
    dropped_no_resolution = 0
    dropped_locked_equiv = 0
    dropped_not_ex_ante_fav = 0
    dropped_losing_side = 0
    total_trades_in = 0
    total_trades_out = 0
    for row in rows:
        cid = row.get("conditionId")
        winner_idx = None
        token_map = token_outcome.get(cid, {})
        if filter_winning_side:
            resolution = resolutions.get(cid)
            if resolution is None:
                dropped_no_resolution += 1
                continue
            winner_idx = resolution.get("winnerIndex")
            if winner_idx is None:
                dropped_no_resolution += 1
                continue

        # Need the earliest winner-side fill in 480s window for both filters.
        winner_earliest_price = None
        if winner_idx is not None:
            w480 = (row.get("windows") or {}).get("480") or []
            winner_w480 = [t for t in w480 if token_map.get(t.get("asset")) == winner_idx]
            if winner_w480:
                earliest = max(winner_w480, key=lambda t: t.get("sec_to_finish", 0))
                winner_earliest_price = float(earliest.get("price", 0))

        if exclude_locked_equivalents and winner_earliest_price is not None:
            if winner_earliest_price >= locked_threshold:
                dropped_locked_equiv += 1
                continue

        # Ex-ante fav-side filter: at start of 480s window, was the eventual
        # winner already the market favorite? If not, picking this market
        # would have required end-of-match knowledge.
        if ex_ante_favorite_only:
            if winner_earliest_price is None or winner_earliest_price < ex_ante_favorite_min_price:
                dropped_not_ex_ante_fav += 1
                continue

        for window_sec_str, trades in (row.get("windows") or {}).items():
            filtered: list[dict] = []
            for t in trades or []:
                total_trades_in += 1
                if filter_winning_side and winner_idx is not None:
                    asset = t.get("asset")
                    asset_idx = token_map.get(asset)
                    if asset_idx is None or asset_idx != winner_idx:
                        dropped_losing_side += 1
                        continue
                filtered.append(t)
                total_trades_out += 1
            flat.append({
                "strategy": "__control__",
                "slug": row.get("slug"),
                "title": row.get("question"),
                "token": cid,
                "loss_requires_goals": None,
                "window_sec": int(window_sec_str),
                "trades": filtered,
            })

    print(
        f"  [universe filter] {dropped_no_resolution} markets dropped (no resolution); "
        f"{dropped_locked_equiv} dropped (locked-equivalent at start of 480s); "
        f"{dropped_not_ex_ante_fav} dropped (not ex-ante favorite); "
        f"kept {total_trades_out}/{total_trades_in} winning-side trades "
        f"({dropped_losing_side} losing-side dropped)"
    )
    return pd.DataFrame(flat)


def aggregate_best_per_match_window(cells: pd.DataFrame) -> pd.DataFrame:
    """Per (slug, window_sec), keep only the BEST cell — lowest observed_min_price.

    This mirrors what the live bot does: it picks the single highest-ROI
    executable candidate per match.
    """
    if cells.empty:
        return cells
    sorted_cells = cells.sort_values(["slug", "window_sec", "observed_min_price"])
    best = sorted_cells.drop_duplicates(subset=["slug", "window_sec"], keep="first")
    return best.reset_index(drop=True)


def _cluster_bootstrap(
    pairs: pd.DataFrame,
    strat_col: str,
    ctrl_col: str,
    n_iter: int,
    seed: int,
) -> dict:
    """Cluster-bootstrap by slug. pairs has one row per (slug, window) with both cols."""
    slugs = pairs["slug"].unique()
    rng = np.random.default_rng(seed)

    def mean_for(samp):
        sub = pairs[pairs["slug"].isin(samp)]
        return float(sub[strat_col].mean()), float(sub[ctrl_col].mean())

    obs_s, obs_c = mean_for(slugs)
    diffs = np.empty(n_iter, dtype=float)
    for i in range(n_iter):
        sample = rng.choice(slugs, size=len(slugs), replace=True)
        s, c = mean_for(sample)
        diffs[i] = s - c
    ci_lo, ci_hi = np.percentile(diffs, [2.5, 97.5])
    p_one_sided = float((diffs <= 0).mean())
    return {
        "obs_strategy": obs_s,
        "obs_control": obs_c,
        "diff_ci_lo": float(ci_lo),
        "diff_ci_hi": float(ci_hi),
        "p_one_sided_strat_gt_ctrl": p_one_sided,
    }


def run_tier3(
    strategy_window_trades: pd.DataFrame,
    universe_window_trades: pd.DataFrame,
    n_iter: int = 10_000,
    seed: int = 0,
    exclude_locked: bool = True,
) -> pd.DataFrame:
    """Per (window_sec): strategy_best vs control_best across all matches.

    The 'strategy_best' row is the bot's actual pick per match. The 'control_best'
    row is the cheapest fill among all NON-strategy markets in that match.

    `exclude_locked=True` (default) removes *_locked candidates from the strategy
    side because the runbook flags them as orderbook-lag artefacts not safe to
    deploy. Set to False to reproduce the as-published backtest universe.
    """
    if exclude_locked:
        strategy_window_trades = strategy_window_trades[
            ~strategy_window_trades["strategy"].str.endswith("_locked", na=False)
        ].reset_index(drop=True)

    strat_cells = build_cell_table(strategy_window_trades)
    ctrl_cells = build_cell_table(universe_window_trades)

    strat_best = aggregate_best_per_match_window(strat_cells)
    ctrl_best = aggregate_best_per_match_window(ctrl_cells)

    cols = [
        "slug", "window_sec",
        "observed_min_price", "observed_min_net_roi_pct",
        "observed_le_099", "observed_le_098",
        "random_pick_mean_net_roi_pct", "random_pick_prob_le_099",
    ]
    strat_best = strat_best[cols].rename(columns={
        "observed_min_price": "strat_min_price",
        "observed_min_net_roi_pct": "strat_min_roi_pct",
        "observed_le_099": "strat_le_099",
        "observed_le_098": "strat_le_098",
        "random_pick_mean_net_roi_pct": "strat_rand_mean_roi_pct",
        "random_pick_prob_le_099": "strat_rand_prob_le_099",
    })
    ctrl_best = ctrl_best[cols].rename(columns={
        "observed_min_price": "ctrl_min_price",
        "observed_min_net_roi_pct": "ctrl_min_roi_pct",
        "observed_le_099": "ctrl_le_099",
        "observed_le_098": "ctrl_le_098",
        "random_pick_mean_net_roi_pct": "ctrl_rand_mean_roi_pct",
        "random_pick_prob_le_099": "ctrl_rand_prob_le_099",
    })

    paired = strat_best.merge(ctrl_best, on=["slug", "window_sec"], how="inner")

    results = []
    for window_sec, group in paired.groupby("window_sec"):
        n = len(group)
        roi_stats = _cluster_bootstrap(group, "strat_min_roi_pct", "ctrl_min_roi_pct", n_iter, seed)
        hit_stats = _cluster_bootstrap(group, "strat_le_099", "ctrl_le_099", n_iter, seed)
        results.append({
            "window_sec": int(window_sec),
            "n_matches_paired": int(n),
            "strat_min_roi_pct_mean": roi_stats["obs_strategy"],
            "ctrl_min_roi_pct_mean": roi_stats["obs_control"],
            "roi_diff_ci_lo": roi_stats["diff_ci_lo"],
            "roi_diff_ci_hi": roi_stats["diff_ci_hi"],
            "roi_p_strat_gt_ctrl": roi_stats["p_one_sided_strat_gt_ctrl"],
            "strat_hit_rate_le_099": hit_stats["obs_strategy"],
            "ctrl_hit_rate_le_099": hit_stats["obs_control"],
            "hit_rate_diff_ci_lo": hit_stats["diff_ci_lo"],
            "hit_rate_diff_ci_hi": hit_stats["diff_ci_hi"],
            "hit_rate_p_strat_gt_ctrl": hit_stats["p_one_sided_strat_gt_ctrl"],
        })

    return pd.DataFrame(results).sort_values("window_sec").reset_index(drop=True)


def render_tier3_report(tier3_df: pd.DataFrame, output_path: Path) -> None:
    lines: list[str] = []
    lines.append("# Tier 3 Random-Control Verdict — universe null")
    lines.append("")
    lines.append("Falsification target: Tier 2 confirmed the strategy beats random ")
    lines.append("execution WITHIN the candidate set. Tier 3 asks the stronger ")
    lines.append("question: does the `lossRequiresGoals >= 2` filter add value vs ")
    lines.append("buying the cheapest available non-strategy market in the same ")
    lines.append("match-window?")
    lines.append("")
    lines.append("Method: per match, take the cheapest fill among strategy candidates ")
    lines.append("(what the bot does) and the cheapest fill among non-strategy markets ")
    lines.append("(the control bot). Cluster bootstrap by slug, B = 10,000.")
    lines.append("")
    lines.append("## Per-window comparison")
    lines.append("")
    lines.append("| Window | n | Strat min-ROI % | Ctrl min-ROI % | ROI Δ 95% CI | Strat hit≤0.99 | Ctrl hit≤0.99 | p |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for _, row in tier3_df.iterrows():
        ci = f"[{row['roi_diff_ci_lo']:+.2f}, {row['roi_diff_ci_hi']:+.2f}]"
        lines.append(
            f"| {int(row['window_sec'])}s | {int(row['n_matches_paired'])} | "
            f"{row['strat_min_roi_pct_mean']:.2f} | "
            f"{row['ctrl_min_roi_pct_mean']:.2f} | "
            f"{ci} | "
            f"{row['strat_hit_rate_le_099']*100:.1f}% | "
            f"{row['ctrl_hit_rate_le_099']*100:.1f}% | "
            f"{row['roi_p_strat_gt_ctrl']:.3f} |"
        )
    lines.append("")
    lines.append("## Verdict per window")
    lines.append("")
    for _, row in tier3_df.iterrows():
        w = int(row["window_sec"])
        ci_lo = row["roi_diff_ci_lo"]
        ci_hi = row["roi_diff_ci_hi"]
        hit_gap = (row["strat_hit_rate_le_099"] - row["ctrl_hit_rate_le_099"]) * 100
        if ci_lo > 0 and hit_gap >= 5:
            verdict = "**PASS** — strategy filter has alpha over non-strategy universe"
        elif ci_hi < 0 or hit_gap <= -5:
            verdict = "**FAIL** — non-strategy universe is better; filter is anti-edge"
        else:
            verdict = "**INCONCLUSIVE** — strategy not distinguishable from universe at 95%"
        lines.append(f"- **{w}s** [n={int(row['n_matches_paired'])}]: {verdict}; ROI Δ CI [{ci_lo:+.2f}, {ci_hi:+.2f}], hit-rate gap {hit_gap:+.1f}pp")
    lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n")
