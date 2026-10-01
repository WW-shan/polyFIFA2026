# Late-game score model shadow monitor design (2026-09-28)

## Purpose

The walk-forward study in
`docs/late-game-score-model-research-2026-09-28.md` found an out-of-sample
signal: when a live-visible score and clock imply a moneyline favourite at
>= 0.90 while the market price still trails by >= 0.03, a later taker buy at
`model - 0.01` produced +12.9% (NFL, 35 fills) and +13.2% (NBA, 10 fills).

Those fills were reconstructed from public trade prints, and the latency
between ESPN publishing a state and this machine receiving it was never
measured during a live game. The documented gate before any real order is a
shadow process that records the same signal from live sources without trading.

## Scope

Build `src/research/shadow/`, an isolated, read-only monitor:

- it polls ESPN and the Polymarket CLOB;
- it applies the exported score model to live-visible game states;
- it appends one NDJSON audit record stream;
- it never imports the executor or the ledger and never submits an order.

Out of scope: order placement, stake sizing, wallet access, model retraining
inside the monitor, non-moneyline markets.

## Design

### Model artifact

`tools/research/export_late_score_model.py` fits the same regularized logistic
model used by the walk-forward study on every available game and writes a JSON
artifact (feature spec, coefficients, mean, scale, training metadata, fee
rate). The monitor refuses to start without a valid artifact, so live
predictions cannot silently diverge from the validated model. The TypeScript
feature and probability functions are cross-checked against golden values
computed by the Python implementation.

### Live state

Primary state source is the ESPN site scoreboard for the game's date, filtered
by ESPN event id: score, period, display clock and status. It is one small
request per poll and exposes exactly the fields the model learned on. On a
signal, the monitor additionally fetches the ESPN summary to record the last
published play and its `wallclock`, which is the evidence for ESPN
publication latency. `winprobability` is never read.

### Market data

Gamma sports events are discovered by tag with a bounded start-time window and
matched to the ESPN event by team names and start time. Only the two-outcome
moneyline market is used. For each poll the monitor fetches `/book` for both
tokens through the configured proxy and records best bid/ask, mid, tick size
and displayed ask depth within the model limit.

### Signal rule

Identical to the validated walk-forward rule:

- final regulation period or overtime, <= 180 seconds remaining;
- model probability >= 0.90 for one side;
- model probability minus executable best ask >= 0.03;
- limit price `min(0.99, model - 0.01)`;
- signal is recorded once per game and side, then re-checked at 30 s and every
  15 s through 90 s, mirroring the study's 30 s delay plus 60 s worst-price
  window;
- hypothetical fill walks the recorded ask levels up to the limit for the
  configured share count; it is a measurement, never an order.

### Records

One NDJSON file per run under `data/research/shadow/`. Record kinds:
`run-start`, `game-linked`, `state`, `signal`, `fill-check`, `settlement`,
`error`. Each record carries wall-clock and monotonic timestamps, the league,
game identity, raw inputs, model output, executable prices and a decision
reason. Records are written only inside the final 15 minutes plus one
minute-cadence heartbeats while a game is live, to bound disk use. Settlement
is derived from the ESPN final score and confirmed against the Gamma resolved
outcome prices when available.

### Safety

- No import of `src/execution/*`, `src/persistence/ledger.ts` or `src/cli.ts`
  anywhere under `src/research/shadow/`; enforced by a test.
- The CLI writes only under its `--out` path.
- Missing book, missing state and replay/stale data fail closed with a reason
  string; the monitor never guesses a price.

## Validation plan

1. Unit tests for model features/probability, book walking, ESPN parsing,
   Gamma/ESPN linking, the tick loop and CLI parsing.
2. Isolation test that the shadow module cannot reach the executor or ledger.
3. Pre-game dry run against tonight's NFL event to confirm discovery, linking
   and order-book reads.
4. Live shadow run during the NFL game; only after it confirms the edge
   survives real latency should a separately approved live pilot be proposed.

## Implementation notes (2026-09-28)

Implemented as specified:

- `src/research/shadow/{model,espn,market,monitor,cli}.ts`
- `tools/research/export_late_score_model.py`
- `tests/research/shadow/` (49 tests, including the import-graph isolation
  test)
- npm scripts `shadow:late-game`, `shadow:nfl`, `shadow:nba`

Measurements and their exact meaning:

- `stateLagMs` / `espnSummary.lastPlayAgeMs`: age of the last ESPN-visible
  play state, from its `wallclock` to local receipt. This bounds publication
  latency from above because the poll interval and ESPN's own publish delay
  both add to it.
- `roundTripMs`: local HTTP round trip for the order-book request.
- `bookLagMs`: how old the venue's book `timestamp` is at receipt. The CLOB
  only advances that timestamp when the book changes, so it is a lower bound
  on book freshness, not network latency.

Settlement uses the ESPN final score; the record keeps `conditionId` and
`marketSlug` so a later script can cross-check Gamma's resolved payout.

The rule is recorded, not executed. A live order path is a separate,
independently approved change after the shadow run confirms the edge survives
real publication and execution latency.
