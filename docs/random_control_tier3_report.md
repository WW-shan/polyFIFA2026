# Tier 3 Random-Control Verdict — universe null

Falsification target: Tier 2 confirmed the strategy beats random 
execution WITHIN the candidate set. Tier 3 asks the stronger 
question: does the `lossRequiresGoals >= 2` filter add value vs 
buying the cheapest available non-strategy market in the same 
match-window?

Method: per match, take the cheapest fill among strategy candidates 
(what the bot does) and the cheapest fill among non-strategy markets 
(the control bot). Cluster bootstrap by slug, B = 10,000.

## Per-window comparison

| Window | n | Strat min-ROI % | Ctrl min-ROI % | ROI Δ 95% CI | Strat hit≤0.99 | Ctrl hit≤0.99 | p |
|---|---|---|---|---|---|---|---|
| 60s | 33 | 0.39 | 33.11 | [-55.46, -2.79] | 18.2% | 90.9% | 1.000 |
| 120s | 35 | 1.14 | 34.31 | [-54.76, -5.20] | 42.9% | 97.1% | 1.000 |
| 180s | 35 | 1.45 | 35.86 | [-55.90, -6.45] | 57.1% | 100.0% | 1.000 |
| 300s | 35 | 22.42 | 153.98 | [-256.04, +23.05] | 85.7% | 100.0% | 0.774 |
| 480s | 35 | 24.64 | 162.82 | [-264.40, +17.91] | 97.1% | 100.0% | 0.774 |

## Verdict per window

- **60s** [n=33]: **FAIL** — non-strategy universe is better; filter is anti-edge; ROI Δ CI [-55.46, -2.79], hit-rate gap -72.7pp
- **120s** [n=35]: **FAIL** — non-strategy universe is better; filter is anti-edge; ROI Δ CI [-54.76, -5.20], hit-rate gap -54.3pp
- **180s** [n=35]: **FAIL** — non-strategy universe is better; filter is anti-edge; ROI Δ CI [-55.90, -6.45], hit-rate gap -42.9pp
- **300s** [n=35]: **FAIL** — non-strategy universe is better; filter is anti-edge; ROI Δ CI [-256.04, +23.05], hit-rate gap -14.3pp
- **480s** [n=35]: **INCONCLUSIVE** — strategy not distinguishable from universe at 95%; ROI Δ CI [-264.40, +17.91], hit-rate gap -2.9pp

