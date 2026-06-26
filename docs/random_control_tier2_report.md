# Tier 2 Random-Control Verdict — loss_requires_two_goals

Falsification target: the published backtest reports `min_price` per 
(strategy, window) cell as if the bot will get that fill. Tier 2 asks 
whether a uniformly random trade inside the same window would have 
achieved a similar net ROI. If yes, the apparent edge is min-price 
selection bias, not strategy alpha — and a live FOK bot will not get 
the min-price fill.

Method: cluster bootstrap by `slug` (match-date), B = 10,000.
Net-ROI formula matches `src/domain/fees.ts` exactly.

## TL;DR

- **8 / 9 decision-grade cells PASS** the random-control test. Strategy 
  edge over uniform-random execution in the same window is statistically 
  significant at the 95% level after cluster-bootstrapping by match-date.
- **Safest single bet: `total_under_loss_ge2 @ 480s`** — hit-rate 83.8% 
  vs random 57.4%, min-ROI 4.38% vs random 1.52%, ROI Δ CI [+1.73, +3.76]. 
  Random pick alone is already profitable: the window is genuinely cheap, 
  and the strategy adds clean alpha on top.
- **DO NOT trade locked classes (`total_over_locked`, `team_total_over_locked`, 
  `btts_yes_locked`) without a speed-bot.** Their headline 1000%+ ROIs are 
  single outliers from orderbook lag right after a goal. CIs span hundreds 
  of pp. The Polymarket docs flag this; Tier 2 confirms it.
- **60s window collapses to random.** Strategy is no better than picking 
  blindly inside the final minute. Use 180s–480s only.

## What Tier 2 does NOT test (still open)

- **Tier 3 (universe null).** Tier 2 randomizes WITHIN the strategy-filtered 
  candidate pool. It cannot rule out that *any* late-window FIFWC market 
  drifts cheap, with no edge from the `lossRequiresGoals` filter. Requires 
  re-fetching non-strategy markets from Polymarket — out of scope for this PoC.
- **Live execution slippage.** Tier 2 assumes you can BUY at any trade price 
  observed historically. A live FOK at best-ask may miss the min — but 
  even random-pick mean ROI is positive on the leading strategies, so the 
  worst-case is shaved alpha, not blown-up capital.
- **Sample size.** n = 22–37 match-dates per (strategy, window) cell. Wide 
  spread_tight CIs ([+1.14, +33.86]) say there's likely real edge but 
  magnitude is uncertain.

## Decision-grade cells (the ones a live bot would actually trade)

| Strategy | Window | n | Obs min-ROI % | Rand pick ROI % | ROI Δ 95% CI | Strat hit≤0.99 | Rand hit≤0.99 | Verdict |
|---|---|---|---|---|---|---|---|---|
| total_under_loss_ge2 | 300s | 36 | 1.80 | 0.69 | [+0.68, +1.48] | 69.4% | 36.9% | **PASS** |
| total_under_loss_ge2 | 480s | 37 | 4.38 | 1.52 | [+1.73, +3.76] | 83.8% | 57.4% | **PASS** |
| spread_tight_loss_ge2 | 300s | 34 | 21.47 | 1.86 | [+0.38, +34.81] | 44.1% | 33.0% | **PASS** |
| spread_tight_loss_ge2 | 480s | 36 | 21.43 | 1.99 | [+1.14, +33.86] | 58.3% | 41.7% | **PASS** |
| loser_no | 300s | 22 | 0.52 | 0.27 | [+0.02, +0.43] | 9.1% | 5.1% | **INCONCLUSIVE** |
| loser_no | 480s | 23 | 0.86 | 0.45 | [+0.13, +0.63] | 26.1% | 11.9% | **PASS** |
| draw_no_lead_ge2 | 300s | 11 | 1.50 | 0.66 | [+0.11, +1.44] | 27.3% | 19.0% | **PASS** |
| leader_yes_lead_ge2 | 300s | 16 | 1.29 | 0.33 | [+0.16, +1.61] | 25.0% | 7.3% | **PASS** |
| team_total_under_loss_ge2 | 300s | 24 | 0.70 | 0.37 | [+0.11, +0.54] | 25.0% | 18.2% | **PASS** |

## Verdict summary

- PASS cells: **8**
- INCONCLUSIVE cells: **1**
- FAIL cells: **0**

## Per-cell explanations

- **total_under_loss_ge2 @ 300s** [PASS]: min-ROI beats random pick by 1.12pp, 95% CI [0.68, 1.48] excludes 0; hit-rate beats random by 32.5pp
- **total_under_loss_ge2 @ 480s** [PASS]: min-ROI beats random pick by 2.86pp, 95% CI [1.73, 3.76] excludes 0; hit-rate beats random by 26.4pp
- **spread_tight_loss_ge2 @ 300s** [PASS]: min-ROI beats random pick by 19.61pp, 95% CI [0.38, 34.81] excludes 0; hit-rate beats random by 11.1pp
- **spread_tight_loss_ge2 @ 480s** [PASS]: min-ROI beats random pick by 19.44pp, 95% CI [1.14, 33.86] excludes 0; hit-rate beats random by 16.6pp
- **loser_no @ 300s** [INCONCLUSIVE]: min-ROI beats random pick by 0.25pp, 95% CI [0.02, 0.43] excludes 0; hit-rate gap +4.0pp under 5pp threshold
- **loser_no @ 480s** [PASS]: min-ROI beats random pick by 0.41pp, 95% CI [0.13, 0.63] excludes 0; hit-rate beats random by 14.1pp
- **draw_no_lead_ge2 @ 300s** [PASS]: min-ROI beats random pick by 0.84pp, 95% CI [0.11, 1.44] excludes 0; hit-rate beats random by 8.2pp
- **leader_yes_lead_ge2 @ 300s** [PASS]: min-ROI beats random pick by 0.96pp, 95% CI [0.16, 1.61] excludes 0; hit-rate beats random by 17.7pp
- **team_total_under_loss_ge2 @ 300s** [PASS]: min-ROI beats random pick by 0.34pp, 95% CI [0.11, 0.54] excludes 0; hit-rate beats random by 6.8pp

## Full Tier 2 table (all strategies × windows)

| Strategy | Window | n | Obs min-ROI % | Rand pick ROI % | ROI Δ CI | Hit≤0.99 strat | Hit≤0.99 rand | p (strat>rand) |
|---|---|---|---|---|---|---|---|---|
| btts_yes_locked | 60s | 20 | 0.14 | 0.14 | [+0.00, +0.00] | 5.0% | 5.0% | 0.606 |
| draw_no_lead_ge2 | 60s | 7 | 0.10 | 0.10 | [+0.00, +0.00] | 0.0% | 0.0% | 1.000 |
| leader_yes_lead_ge2 | 60s | 16 | 0.10 | 0.10 | [-0.00, +0.00] | 0.0% | 0.0% | 0.890 |
| loser_no | 60s | 18 | 0.10 | 0.10 | [-0.00, +0.00] | 0.0% | 0.0% | 1.000 |
| spread_tight_loss_ge2 | 60s | 18 | 0.47 | 0.39 | [+0.00, +0.14] | 27.8% | 24.4% | 0.011 |
| team_total_over_locked | 60s | 14 | 0.29 | 0.29 | [+0.00, +0.00] | 21.4% | 21.4% | 1.000 |
| team_total_under_loss_ge2 | 60s | 12 | 0.31 | 0.23 | [+0.00, +0.16] | 16.7% | 11.1% | 0.117 |
| total_over_locked | 60s | 28 | 0.93 | 0.42 | [+0.00, +0.95] | 17.9% | 17.9% | 0.278 |
| total_under_loss_ge2 | 60s | 33 | 0.28 | 0.21 | [+0.03, +0.12] | 12.1% | 10.3% | 0.005 |
| btts_yes_locked | 120s | 21 | 0.14 | 0.14 | [-0.00, +0.00] | 4.8% | 4.8% | 0.595 |
| draw_no_lead_ge2 | 120s | 9 | 0.35 | 0.23 | [+0.00, +0.21] | 22.2% | 7.6% | 0.103 |
| leader_yes_lead_ge2 | 120s | 16 | 0.10 | 0.10 | [-0.00, +0.00] | 0.0% | 0.0% | 1.000 |
| loser_no | 120s | 20 | 0.14 | 0.10 | [+0.00, +0.07] | 5.0% | 0.2% | 0.349 |
| spread_tight_loss_ge2 | 120s | 25 | 1.31 | 0.64 | [+0.08, +1.15] | 40.0% | 33.2% | 0.000 |
| team_total_over_locked | 120s | 21 | 0.61 | 0.29 | [+0.00, +0.55] | 19.0% | 19.0% | 0.123 |
| team_total_under_loss_ge2 | 120s | 14 | 0.34 | 0.24 | [+0.00, +0.18] | 21.4% | 13.1% | 0.009 |
| total_over_locked | 120s | 31 | 66.91 | 2.40 | [+1.01, +116.40] | 32.3% | 25.5% | 0.000 |
| total_under_loss_ge2 | 120s | 35 | 0.56 | 0.31 | [+0.11, +0.36] | 25.7% | 16.0% | 0.000 |
| btts_yes_locked | 180s | 23 | 0.17 | 0.14 | [+0.00, +0.06] | 4.3% | 4.3% | 0.129 |
| draw_no_lead_ge2 | 180s | 11 | 0.36 | 0.25 | [+0.00, +0.19] | 18.2% | 9.4% | 0.031 |
| leader_yes_lead_ge2 | 180s | 16 | 0.22 | 0.11 | [-0.00, +0.20] | 12.5% | 0.4% | 0.035 |
| loser_no | 180s | 21 | 0.19 | 0.11 | [+0.00, +0.13] | 9.5% | 1.4% | 0.034 |
| spread_tight_loss_ge2 | 180s | 29 | 1.34 | 0.66 | [+0.15, +1.09] | 37.9% | 32.5% | 0.000 |
| team_total_over_locked | 180s | 23 | 49.44 | 2.87 | [+0.00, +87.27] | 21.7% | 19.3% | 0.033 |
| team_total_under_loss_ge2 | 180s | 18 | 0.56 | 0.36 | [+0.05, +0.32] | 27.8% | 17.6% | 0.003 |
| total_over_locked | 180s | 33 | 219.16 | 19.09 | [+58.54, +330.06] | 33.3% | 27.7% | 0.000 |
| total_under_loss_ge2 | 180s | 35 | 0.69 | 0.35 | [+0.18, +0.47] | 37.1% | 18.5% | 0.000 |
| btts_yes_locked | 300s | 23 | 430.51 | 9.01 | [+0.03, +807.78] | 17.4% | 7.8% | 0.002 |
| draw_no_lead_ge2 | 300s | 11 | 1.50 | 0.66 | [+0.11, +1.44] | 27.3% | 19.0% | 0.000 |
| leader_yes_lead_ge2 | 300s | 16 | 1.29 | 0.33 | [+0.16, +1.61] | 25.0% | 7.3% | 0.000 |
| loser_no | 300s | 22 | 0.52 | 0.27 | [+0.02, +0.43] | 9.1% | 5.1% | 0.004 |
| spread_tight_loss_ge2 | 300s | 34 | 21.47 | 1.86 | [+0.38, +34.81] | 44.1% | 33.0% | 0.000 |
| team_total_over_locked | 300s | 29 | 328.27 | 27.27 | [+40.66, +513.38] | 27.6% | 22.5% | 0.004 |
| team_total_under_loss_ge2 | 300s | 24 | 0.70 | 0.37 | [+0.11, +0.54] | 25.0% | 18.2% | 0.000 |
| total_over_locked | 300s | 34 | 895.61 | 100.34 | [+212.27, +1235.87] | 35.3% | 32.9% | 0.000 |
| total_under_loss_ge2 | 300s | 36 | 1.80 | 0.69 | [+0.68, +1.48] | 69.4% | 36.9% | 0.000 |
| btts_yes_locked | 480s | 23 | 747.58 | 43.67 | [+0.05, +1245.34] | 17.4% | 11.3% | 0.003 |
| draw_no_lead_ge2 | 480s | 14 | 1.80 | 0.82 | [+0.23, +1.59] | 28.6% | 19.8% | 0.000 |
| leader_yes_lead_ge2 | 480s | 16 | 1.88 | 0.50 | [+0.31, +2.20] | 31.2% | 13.0% | 0.000 |
| loser_no | 480s | 23 | 0.86 | 0.45 | [+0.13, +0.63] | 26.1% | 11.9% | 0.000 |
| spread_tight_loss_ge2 | 480s | 36 | 21.43 | 1.99 | [+1.14, +33.86] | 58.3% | 41.7% | 0.000 |
| team_total_over_locked | 480s | 30 | 651.57 | 66.09 | [+92.83, +975.46] | 33.3% | 26.0% | 0.000 |
| team_total_under_loss_ge2 | 480s | 31 | 1.13 | 0.53 | [+0.20, +0.90] | 29.0% | 22.0% | 0.000 |
| total_over_locked | 480s | 35 | 1726.47 | 122.55 | [+543.30, +2529.47] | 42.9% | 35.7% | 0.000 |
| total_under_loss_ge2 | 480s | 37 | 4.38 | 1.52 | [+1.73, +3.76] | 83.8% | 57.4% | 0.000 |

## Decision rule

Deploy live capital only if at least one decision-grade cell is PASS, 
AND the bot's execution path can realistically hit prices within the 
Obs min-ROI band (FOK orders at best-ask, sized to <= available depth).

If all decision cells are INCONCLUSIVE/FAIL, the published backtest is 
min-price selection bias on small samples and does not justify capital.
