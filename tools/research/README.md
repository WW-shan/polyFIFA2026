# Late-game score model research

These scripts test whether a live-visible score and game clock can identify a
Polymarket moneyline price that has not adjusted yet. They read public data
only. They never import the trading client, touch a ledger, or submit an order.

## Requirements

- Python 3.11+
- `numpy`
- The repository's normal local proxy at `http://127.0.0.1:10808`, or set
  `POLY_RESEARCH_PROXY`

The scripts cache raw ESPN responses under `/tmp/poly_espn_cache` and write
their intermediate outputs under `/tmp`. Downloaded Polymarket datasets remain
under `data/research/` and are ignored by git.

## 1. Fetch live-visible ESPN state

Only score, period and game clock fields are used by the model. ESPN's
historical `winprobability` field is deliberately not used: the core API records
a post-game `lastModified` time for those rows, so importing it into a live
backtest is look-ahead.

```sh
python3 tools/research/fetch_espn_states.py nba \
  data/research/clock60-nba0-20260925/dataset.json,data/research/clock60-nba1-20260925/dataset.json,data/research/clock60-nba2-20260925/dataset.json

python3 tools/research/fetch_espn_states.py nfl \
  data/research/clock60-nfl-20260925/dataset.json
```

Supported league names are `nba`, `nfl`, `cfb` and `nhl`. NHL summaries do not
currently expose the same play-state shape, so the model study reports zero
usable NHL states rather than guessing.

## 2. Fixed chronological holdout

The first 70% of games by start time train the score/time model. The later 30%
are evaluated unchanged. A game is only considered after the model has seen
earlier games.

```sh
python3 tools/research/late_score_holdout.py nba \
  data/research/clock60-nba0-20260925/dataset.json,data/research/clock60-nba1-20260925/dataset.json,data/research/clock60-nba2-20260925/dataset.json \
  4 720

python3 tools/research/late_score_holdout.py nfl \
  data/research/clock60-nfl-20260925/dataset.json 4 900
```

The final two arguments are the final regulation period and the number of
seconds in that period: NBA `4 720`, NFL/CFB `4 900`.

## 3. Expanding-window replay

This is the stronger test. The first 20% of games initialize the model; then
each later 5% block is predicted once from only the games before it and added
to the training set. A rule cannot see a later, better signal inside the same
game.

```sh
python3 tools/research/late_score_walk_forward.py nba \
  data/research/clock60-nba0-20260925/dataset.json,data/research/clock60-nba1-20260925/dataset.json,data/research/clock60-nba2-20260925/dataset.json \
  4 720

python3 tools/research/late_score_walk_forward.py nfl \
  data/research/clock60-nfl-20260925/dataset.json 4 900
```

Execution assumptions are deliberately conservative: a signal is evaluated
after a delay, fills only from a later public taker BUY print at or below the
model limit, and the reported `worst` price is the highest eligible BUY print
within the next 60 seconds. Returns include the 5% sports taker fee.

These are still public-trade approximations, not a complete order-book replay.
Do not treat the results as a live-trading guarantee.

## 4. Export the frozen model

The live shadow monitor must not retrain at run time, so the final model is
exported once from all available games. The artifact also carries self-test
predictions computed by this Python code; the TypeScript monitor recomputes
them at load time and refuses to run on any mismatch.

```sh
python3 tools/research/export_late_score_model.py nfl /tmp/espn_states_nfl.json.gz \
  4 900 --out data/research/models/late-score-nfl.json
python3 tools/research/export_late_score_model.py nba /tmp/espn_states_nba.json.gz \
  4 720 --out data/research/models/late-score-nba.json
```

Rebuild the model after any new ESPN download. The artifact records the source
dataset hash so a monitor run can be tied back to one dataset snapshot.

## 5. Shadow monitor

`src/research/shadow/` is the read-only gate before any live order. It polls
the ESPN scoreboard for linked games, applies the frozen model, reads both
Polymarket moneyline books through the proxy, and appends NDJSON records:
`run-start`, `discovery`, `game-linked`, `state`, `signal`, `fill-check`,
`settlement`, `error`, `run-end`. It never imports the executor or the ledger;
`tests/research/shadow/isolation.test.ts` enforces that over the full import
graph.

```sh
# One tick, useful as a pre-game connectivity check
npm run shadow:late-game -- --league nfl --once \
  --out data/research/shadow/preflight.ndjson

# Continuous shadow run during live games
npm run shadow:nfl
npm run shadow:nba
```

Default signal rule matches the walk-forward study: final 180 seconds, model
probability >= 0.90, model minus executable best ask >= 0.03, limit
`model - 0.01`, hypothetical size 5 shares, and fill checks at 30 s and every
15 s through 90 s. `--min-probability`, `--min-edge`, `--window-seconds`,
`--shares` and `--delay-seconds` change the recording rule; they never enable
orders. Keep `data/research/shadow/` when comparing a live run to the
backtest, and treat the records as evidence, not as fills.
