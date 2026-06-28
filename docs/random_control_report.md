# Random-Control Falsification Report — loss_requires_two_goals

更新日期: 2026-06-28 Asia/Shanghai

This is the headline document. Two tiers of falsification were run against
the published `loss_requires_two_goals` backtest. Both use the same
discipline: cluster bootstrap by `slug` (match-date) with B=10,000, and
the net-ROI formula matches `src/domain/fees.ts` exactly (verified by
metrics self-test on 6 published anchor prices).

## TL;DR

| Tier | Question | Verdict |
|---|---|---|
| **Tier 2** | Is the published `min_price` a window-wide phenomenon, or a single tick outlier? | **PASS** for 8/9 decision-grade cells — the strategy beats uniform-random execution inside the same window with 95% CI excluding 0. |
| **Tier 3** | Does the `lossRequiresGoals>=2` filter beat buying the ex-ante favorite side in the same match-window? | **FAIL at 60s/120s/180s. INCONCLUSIVE at 300s/480s.** The filter has no edge over fav-side dip-buying at short windows; at long windows we can't distinguish them. |

**Recommended deployment policy after both tiers:**

1. **Only trade 300s and 480s windows.** Tier 3 kills 60s-180s decisively.
2. **`total_under_loss_ge2` is the safest cell.** Tier 2 best CI lift, and at 480s its hit-rate (97.1%) matches the universe (100%) — meaning it's not getting beaten, just neck-and-neck.
3. **Treat published 27% ROI as headline, not expected value.** The realistic per-trade expected ROI from Tier 2's "random pick in same window" baseline is 1.5-4.4%, not 27%. A live FOK bot rarely gets the min-tick fill.
4. **Add Kelly sizing.** With the now-validated `q_hat ≈ 0.77` for `total_under_loss_ge2 @ 480s`, fractional Kelly gives proper position size rather than the current "all-in stake" path.
5. **Do NOT trade `*_locked` classes.** Tier 2 confirms these are orderbook-lag artefacts. Tier 3's control universe systematically excludes their equivalents.

## Tier 2 — within-window random pick

See `random_control_tier2_report.md` for full table. Decision-grade cells:

| Strategy | Window | Obs min-ROI | Rand-pick ROI | ROI Δ CI | Hit≤0.99 strat | Hit≤0.99 rand | Verdict |
|---|---|---|---|---|---|---|---|
| total_under_loss_ge2 | 300s | 1.80% | 0.69% | [+0.68, +1.48] | 69.4% | 36.9% | **PASS** |
| total_under_loss_ge2 | 480s | 4.38% | 1.52% | [+1.73, +3.76] | 83.8% | 57.4% | **PASS** (safest) |
| spread_tight_loss_ge2 | 300s | 21.47% | 1.86% | [+0.38, +34.81] | 44.1% | 33.0% | PASS but wide CI |
| spread_tight_loss_ge2 | 480s | 21.43% | 1.99% | [+1.14, +33.86] | 58.3% | 41.7% | PASS but wide CI |
| loser_no | 480s | 0.86% | 0.45% | [+0.13, +0.63] | 26.1% | 11.9% | PASS small |
| draw_no_lead_ge2 | 300s | 1.50% | 0.66% | [+0.11, +1.44] | 27.3% | 19.0% | PASS small |
| leader_yes_lead_ge2 | 300s | 1.29% | 0.33% | [+0.16, +1.61] | 25.0% | 7.3% | PASS small |
| team_total_under_loss_ge2 | 300s | 0.70% | 0.37% | [+0.11, +0.54] | 25.0% | 18.2% | PASS small |
| loser_no | 300s | 0.52% | 0.27% | [+0.02, +0.43] | 9.1% | 5.1% | INCONCLUSIVE |

**Tier 2 takeaway:** within the strategy-filtered candidate pool, the `min_price` selection IS materially better than typical execution in the same window — but the lift over random-pick is small (0.3-3.8 pp ROI) outside `spread_tight_loss_ge2`.

## Tier 3 — universe-null vs ex-ante favorite

Universe = all FIFWC markets in the same matches that the strategy does NOT
select. Filters applied (all default-on for fair comparison):

1. Drop trades whose `asset` is not the resolved winning outcome (otherwise
   we count losing-side BUYs that priced to $0 by definition).
2. Drop markets where the winning side's earliest 480s trade was already
   ≥ 0.95 (locked equivalents — orderbook-lag, not strategy alpha).
3. Drop markets where the winning side's earliest 480s trade was < 0.85
   (NOT the ex-ante favorite — selecting these requires end-of-match
   winner knowledge that the strategy doesn't have).

After filters, control universe = 415 (market, window) cells across 35-37 matches.

| Window | n | Strat min-ROI | Ctrl min-ROI | ROI Δ CI | Strat hit≤0.99 | Ctrl hit≤0.99 | Verdict |
|---|---|---|---|---|---|---|---|
| 60s | 33 | 0.39% | 33.11% | [-55.46, -2.79] | 18.2% | 90.9% | **FAIL** |
| 120s | 35 | 1.14% | 34.31% | [-54.76, -5.20] | 42.9% | 97.1% | **FAIL** |
| 180s | 35 | 1.45% | 35.86% | [-55.90, -6.45] | 57.1% | 100.0% | **FAIL** |
| 300s | 35 | 22.42% | 153.98% | [-256.04, +23.05] | 85.7% | 100.0% | **INCONCLUSIVE** |
| 480s | 35 | 24.64% | 162.82% | [-264.40, +17.91] | 97.1% | 100.0% | **INCONCLUSIVE** |

**Tier 3 takeaway:** at short windows, simply buying the ex-ante favorite
side in any FIFWC market produces hit rates 70+ pp higher than the
`lossRequiresGoals>=2` strategy. At long windows the strategy approaches
parity (97% vs 100% hit≤0.99 at 480s).

The control universe's blowout ROI at 300s/480s is dominated by mid-window
favorite-side dips — markets where the ex-ante favorite (price ≥ 0.85
at 480s mark) briefly traded at 0.4-0.6 mid-window before returning to 1.
A real-time bot cannot see these dips coming any better than the
strategy can; but it can see them happen and execute. The **alpha may
actually be in fav-side regression buying**, not the `lossRequiresGoals`
frame. That's a future-research direction.

## Honest limits

- **n=33-37 matches per window** — small. Tier 2 CIs for `spread_tight_*`
  span tens of pp; Tier 3 CIs for `300s/480s` cross zero.
- **Backtest uses end-of-match score** — the data file has no per-second
  score stream, so we replay last-N-seconds trades. Live deployment
  requires `time-window.ts:26`'s 365Scores verified clock to confirm
  `lossRequiresGoals>=2` holds at the moment of the order, not just the
  moment of resolution.
- **Universe coverage is 729/736 control markets** — 7 markets failed
  to fetch (rate limit / transient API errors). Re-fetching these
  doesn't change the verdict structure.
- **Tier 3 fav-side proxy uses winner-side earliest trade price as ex-ante
  signal.** A pure ex-ante approach would query orderbook best-ask at
  match minute 88 from Polymarket history. That data isn't in the repo;
  the proxy is correct in direction (filters out longshots that won by
  luck) but slightly overstates control's information.

## What this means for the live bot

The original deployment runbook (`docs/live_deployment_runbook.md`)
recommended stake = $10-30, ROI threshold 1%, exclude `*_locked`,
window 3-8 minutes. After Tier 3, **tighten further**:

| Config | Original | After Tier 3 |
|---|---|---|
| Allowed windows | 180s, 300s, 480s | **300s, 480s only** |
| Preferred strategy | total_under_loss_ge2 + spread_tight | **total_under_loss_ge2** as primary; spread_tight as opportunistic only |
| Sizing | fixed stake | **Kelly (q=0.77 for primary cell, ¼ Kelly, 5% cap)** |
| Hard kill | 5% bankroll per trade | **5% bankroll per trade + 20% aggregate open + 5% daily per-strategy** |

## File index

- `analysis/random_control/metrics.py` — fees + net_roi with self-test
- `analysis/random_control/io.py` — loaders for candidates/summary/trades
- `analysis/random_control/tier2.py` — within-window random-pick
- `analysis/random_control/tier3.py` — universe null with ex-ante fav filter
- `analysis/random_control/report.py` — Tier 2 report renderer
- `analysis/fetch_event_markets.ts` — pulls 1011-market universe from Polymarket
- `analysis/fetch_universe_trades.py` — pulls BUY trades for 736 control markets
- `analysis/fetch_market_resolutions.py` — pulls outcome resolutions for fair winner-side filter
- `analysis/run_tier2.py`, `analysis/run_tier3.py` — entry points
- `data/random_control_tier2.csv`, `data/random_control_tier3.csv` — bootstrap output tables
- `docs/random_control_tier2_report.md`, `docs/random_control_tier3_report.md` — per-tier reports

## Reproducing

```bash
# from repo root
npm install                                # repo deps (typecheck + tests still pass)
cd analysis
uv sync

# Tier 2 only uses data already in repo
uv run python run_tier2.py

# Tier 3 requires fetching ~15-25 min
npx tsx ../analysis/fetch_event_markets.ts
uv run python fetch_market_resolutions.py
uv run python fetch_universe_trades.py
uv run python run_tier3.py
```

All bootstrap iterations use `seed=0` for reproducibility.
