# Late-game score model research (2026-09-28)

## Question

Can a live-visible score and game clock identify moneyline prices on Polymarket
that have not adjusted yet, and can that edge survive fees and execution delay?

This replaces the earlier idea of buying a fixed 0.70 bid in the final minutes.
The earlier studies already showed that this dip bid almost never filled and
that a maker bid below the favourite had strong adverse selection.

## What was tested

The test used public ESPN play-by-play state (score, period and clock) and the
public Polymarket trade history already downloaded under `data/research/`.
Only fields visible at that point in the game were used.

ESPN's historical `winprobability` was explicitly rejected as a signal. Its
core API records a `lastModified` time after the game, so using it in this
backtest would leak future information even though the displayed values look
like a live curve.

The model is a regularized logistic regression on score margin, remaining time,
their interaction, and overtime. It is trained only on the final 12 minutes of
earlier games. The stronger walk-forward run trains on the first 20% of games,
predicts each later 5% block once, and then adds that block to training.

The execution screen required all of the following:

- ESPN model probability at least 0.90.
- Model probability above the last trade-implied market price by at least
  0.03.
- Signal inside the final 180 seconds of regulation or overtime.
- A 30-second wait before assuming the public score state was available.
- A later public taker BUY print at or below `model probability - 0.01`.
- The `worst` result uses the highest eligible BUY print in the next 60 seconds.
- Hold to settlement and charge the 5% sports taker fee.

## Results

These are expanding-window, out-of-sample results. `signals` counts games where
the model fired; `fills` counts those with an eligible later public BUY print.

| League | Signals | Fills | Wins | Worst-price net return | 95% CI |
|---|---:|---:|---:|---:|---:|
| NFL | 67 | 35 | 34 | +12.9% | +/- 7.6% |
| NBA | 56 | 10 | 10 | +13.2% | +/- 6.1% |
| College football | 21 | 9 | 7 | +2.7% | +/- 38.8% |

The same rule at lower model confidence was not stable: the early and late
halves frequently disagreed, and using the worst observed price removed the
apparent edge in many configurations.

## Interpretation

NFL is the strongest current candidate. NBA is promising but has only ten
out-of-sample fills. College football is inconclusive. The result is not yet a
live-trading result because:

1. It uses trade prints, not a complete historical order book, so the next BUY
   print is only an approximation of the ask available to this bot.
2. The actual delay between ESPN publishing a state and this machine receiving
   it has not been measured during a live game.
3. The sample is still small, especially for NBA, and one late loss can erase
   many wins.
4. The model is score-only; injuries, timeouts, possession and team strength are
   not represented.

## Gate before live orders

Run a shadow process during live NBA and NFL games. It should record, without
placing orders:

- the ESPN state and local receipt time;
- the model probability and reason it fired;
- the current CLOB bid/ask and depth for both moneyline tokens;
- the hypothetical fill price, latency and subsequent settlement result.

Only after that confirms that the edge survives real publication and execution
latency should a small live stake and a per-game loss cap be enabled.

The reproducible scripts and commands are in
[`tools/research/README.md`](../tools/research/README.md).
