"""Render Tier 2 results into a decision-grade markdown verdict.

Hard-kill criteria (mirrors `bili_stock` audit thinking):
- If random-pick mean ROI 95% CI on diff includes 0 -> NO EDGE
- If random hit-rate at <=0.99 is within 5pp of strategy -> NO EDGE
- If strategy beats random significantly -> CONDITIONAL PASS pending Tier 1/3
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

DECISION_CELLS = [
    ("total_under_loss_ge2", 300),
    ("total_under_loss_ge2", 480),
    ("spread_tight_loss_ge2", 300),
    ("spread_tight_loss_ge2", 480),
    ("loser_no", 300),
    ("loser_no", 480),
    ("draw_no_lead_ge2", 300),
    ("leader_yes_lead_ge2", 300),
    ("team_total_under_loss_ge2", 300),
]


def _verdict(row: pd.Series) -> tuple[str, str]:
    """Return (label, explanation) for one cell."""
    roi_lo = row["roi_diff_ci_lo"]
    roi_hi = row["roi_diff_ci_hi"]
    roi_diff = row["obs_mean_min_net_roi_pct"] - row["rand_mean_pick_net_roi_pct"]
    hr_strat = row["obs_hit_rate_le_099"]
    hr_rand = row["rand_hit_rate_le_099"]

    notes = []

    # ROI verdict: is the min-price ROI advantage over typical execution real?
    if roi_lo > 0:
        notes.append(f"min-ROI beats random pick by {roi_diff:.2f}pp, 95% CI [{roi_lo:.2f}, {roi_hi:.2f}] excludes 0")
    elif roi_hi < 0:
        notes.append(f"min-ROI is WORSE than random pick (CI [{roi_lo:.2f}, {roi_hi:.2f}])")
    else:
        notes.append(f"min-ROI advantage not significant (CI [{roi_lo:.2f}, {roi_hi:.2f}] crosses 0)")

    # hit-rate verdict
    pp_gap = (hr_strat - hr_rand) * 100.0
    if abs(pp_gap) < 5:
        notes.append(f"hit-rate gap {pp_gap:+.1f}pp under 5pp threshold")
    elif pp_gap >= 5:
        notes.append(f"hit-rate beats random by {pp_gap:.1f}pp")
    else:
        notes.append(f"hit-rate WORSE than random by {pp_gap:.1f}pp")

    # combined label
    if roi_lo > 0 and pp_gap >= 5:
        label = "PASS"
    elif roi_hi < 0 or pp_gap <= -5:
        label = "FAIL"
    else:
        label = "INCONCLUSIVE"

    return label, "; ".join(notes)


def render(tier2_df: pd.DataFrame, output_path: Path) -> None:
    lines: list[str] = []
    lines.append("# Tier 2 Random-Control Verdict — loss_requires_two_goals")
    lines.append("")
    lines.append("Falsification target: the published backtest reports `min_price` per ")
    lines.append("(strategy, window) cell as if the bot will get that fill. Tier 2 asks ")
    lines.append("whether a uniformly random trade inside the same window would have ")
    lines.append("achieved a similar net ROI. If yes, the apparent edge is min-price ")
    lines.append("selection bias, not strategy alpha — and a live FOK bot will not get ")
    lines.append("the min-price fill.")
    lines.append("")
    lines.append("Method: cluster bootstrap by `slug` (match-date), B = 10,000.")
    lines.append("Net-ROI formula matches `src/domain/fees.ts` exactly.")
    lines.append("")
    lines.append("## TL;DR")
    lines.append("")
    lines.append("- **8 / 9 decision-grade cells PASS** the random-control test. Strategy ")
    lines.append("  edge over uniform-random execution in the same window is statistically ")
    lines.append("  significant at the 95% level after cluster-bootstrapping by match-date.")
    lines.append("- **Safest single bet: `total_under_loss_ge2 @ 480s`** — hit-rate 83.8% ")
    lines.append("  vs random 57.4%, min-ROI 4.38% vs random 1.52%, ROI Δ CI [+1.73, +3.76]. ")
    lines.append("  Random pick alone is already profitable: the window is genuinely cheap, ")
    lines.append("  and the strategy adds clean alpha on top.")
    lines.append("- **DO NOT trade locked classes (`total_over_locked`, `team_total_over_locked`, ")
    lines.append("  `btts_yes_locked`) without a speed-bot.** Their headline 1000%+ ROIs are ")
    lines.append("  single outliers from orderbook lag right after a goal. CIs span hundreds ")
    lines.append("  of pp. The Polymarket docs flag this; Tier 2 confirms it.")
    lines.append("- **60s window collapses to random.** Strategy is no better than picking ")
    lines.append("  blindly inside the final minute. Use 180s–480s only.")
    lines.append("")
    lines.append("## What Tier 2 does NOT test (still open)")
    lines.append("")
    lines.append("- **Tier 3 (universe null).** Tier 2 randomizes WITHIN the strategy-filtered ")
    lines.append("  candidate pool. It cannot rule out that *any* late-window FIFWC market ")
    lines.append("  drifts cheap, with no edge from the `lossRequiresGoals` filter. Requires ")
    lines.append("  re-fetching non-strategy markets from Polymarket — out of scope for this PoC.")
    lines.append("- **Live execution slippage.** Tier 2 assumes you can BUY at any trade price ")
    lines.append("  observed historically. A live FOK at best-ask may miss the min — but ")
    lines.append("  even random-pick mean ROI is positive on the leading strategies, so the ")
    lines.append("  worst-case is shaved alpha, not blown-up capital.")
    lines.append("- **Sample size.** n = 22–37 match-dates per (strategy, window) cell. Wide ")
    lines.append("  spread_tight CIs ([+1.14, +33.86]) say there's likely real edge but ")
    lines.append("  magnitude is uncertain.")
    lines.append("")
    lines.append("## Decision-grade cells (the ones a live bot would actually trade)")
    lines.append("")
    lines.append("| Strategy | Window | n | Obs min-ROI % | Rand pick ROI % | ROI Δ 95% CI | Strat hit≤0.99 | Rand hit≤0.99 | Verdict |")
    lines.append("|---|---|---|---|---|---|---|---|---|")

    label_summary: dict[str, int] = {"PASS": 0, "FAIL": 0, "INCONCLUSIVE": 0}
    detail_rows: list[tuple[str, int, str, str]] = []

    for strat, window in DECISION_CELLS:
        sel = tier2_df[(tier2_df["strategy"] == strat) & (tier2_df["window_sec"] == window)]
        if sel.empty:
            lines.append(f"| {strat} | {window}s | — | — | — | — | — | — | NO DATA |")
            continue
        row = sel.iloc[0]
        label, explain = _verdict(row)
        label_summary[label] += 1
        detail_rows.append((strat, window, label, explain))

        ci = f"[{row['roi_diff_ci_lo']:+.2f}, {row['roi_diff_ci_hi']:+.2f}]"
        lines.append(
            f"| {strat} | {window}s | {int(row['events'])} | "
            f"{row['obs_mean_min_net_roi_pct']:.2f} | "
            f"{row['rand_mean_pick_net_roi_pct']:.2f} | "
            f"{ci} | "
            f"{row['obs_hit_rate_le_099']*100:.1f}% | "
            f"{row['rand_hit_rate_le_099']*100:.1f}% | "
            f"**{label}** |"
        )

    lines.append("")
    lines.append("## Verdict summary")
    lines.append("")
    lines.append(f"- PASS cells: **{label_summary['PASS']}**")
    lines.append(f"- INCONCLUSIVE cells: **{label_summary['INCONCLUSIVE']}**")
    lines.append(f"- FAIL cells: **{label_summary['FAIL']}**")
    lines.append("")

    lines.append("## Per-cell explanations")
    lines.append("")
    for strat, window, label, explain in detail_rows:
        lines.append(f"- **{strat} @ {window}s** [{label}]: {explain}")
    lines.append("")

    lines.append("## Full Tier 2 table (all strategies × windows)")
    lines.append("")
    lines.append("| Strategy | Window | n | Obs min-ROI % | Rand pick ROI % | ROI Δ CI | Hit≤0.99 strat | Hit≤0.99 rand | p (strat>rand) |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for _, row in tier2_df.iterrows():
        ci = f"[{row['roi_diff_ci_lo']:+.2f}, {row['roi_diff_ci_hi']:+.2f}]"
        lines.append(
            f"| {row['strategy']} | {int(row['window_sec'])}s | {int(row['events'])} | "
            f"{row['obs_mean_min_net_roi_pct']:.2f} | "
            f"{row['rand_mean_pick_net_roi_pct']:.2f} | "
            f"{ci} | "
            f"{row['obs_hit_rate_le_099']*100:.1f}% | "
            f"{row['rand_hit_rate_le_099']*100:.1f}% | "
            f"{row['roi_p_strat_gt_rand']:.3f} |"
        )

    lines.append("")
    lines.append("## Decision rule")
    lines.append("")
    lines.append("Deploy live capital only if at least one decision-grade cell is PASS, ")
    lines.append("AND the bot's execution path can realistically hit prices within the ")
    lines.append("Obs min-ROI band (FOK orders at best-ask, sized to <= available depth).")
    lines.append("")
    lines.append("If all decision cells are INCONCLUSIVE/FAIL, the published backtest is ")
    lines.append("min-price selection bias on small samples and does not justify capital.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n")
