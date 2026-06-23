# World Cup Tail Spread Bot Design

Date: 2026-06-22  
Project: `/Users/ww/Project/polyFIFA2026`

## Purpose

Build a Polymarket World Cup single-match spread tail-entry bot that can:

1. identify the correct in-play spread market when a World Cup match is near the end and one side is already covering;
2. check CLOB price/depth and expected fee-adjusted return;
3. submit a trade through a pluggable executor;
4. prove the full flow with automated tests, including a paper-trading executor and fixtures based on the research data.

The project focuses on World Cup match markets under `soccer-fifwc`, especially `Spreads`, not tournament futures and not moneyline.

## Non-Goals

- Do not implement any geoblock bypass behavior.
- Do not hardcode private keys or API credentials.
- Do not claim live trading works unless real credentials are configured and a live smoke command succeeds.
- Do not use `prices-history` alone as proof of executable liquidity. Runtime trading must use live CLOB orderbook/price data.
- Do not build a web UI in this phase.

## Inputs

### Market Data

- Gamma API: `https://gamma-api.polymarket.com`
- Polymarket sports page initial state: `https://polymarket.com/sports/world-cup/{event_slug}`
- CLOB API: `https://clob.polymarket.com`
- Data API only for research/backtest, not runtime execution: `https://data-api.polymarket.com`

### Match State

For the first implementation, match state is an explicit input to the command/runtime layer:

```json
{
  "eventSlug": "fifwc-esp-ksa-2026-06-21",
  "homeTeam": "Spain",
  "awayTeam": "Saudi Arabia",
  "homeGoals": 4,
  "awayGoals": 0,
  "minute": 90,
  "period": "2H",
  "isLive": true
}
```

This keeps live-score provider integration separate. A later phase can plug in a real score feed.

### Runtime Configuration

Use environment variables and command flags:

- `HTTP_PROXY` / `HTTPS_PROXY`: optional normal network proxy, e.g. `http://127.0.0.1:10808`.
- `POLY_PRIVATE_KEY`: required only for live trading.
- `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE`: required only for live trading if using existing L2 credentials.
- `POLY_FUNDER_ADDRESS`: required only for live trading depending on wallet type.
- `BOT_MODE`: `paper` or `live`; default `paper`.

## Core Strategy Logic

### Candidate Check

A match can be considered only if:

- it is a World Cup match event (`soccer-fifwc` / slug starts with `fifwc-`);
- it is live or in a manually supplied near-end state;
- current remaining time is inside `entryWindowMinutes`, default `3`;
- one team leads by at least 2 goals.

### Target Spread Selection

Given a winner and goal margin:

1. Extract all `sportsMarketType == "spreads"` markets for the event.
2. Keep markets where first outcome equals the winning team.
3. Keep markets where `abs(line) < margin`, because the team is covering that spread.
4. Select the largest `abs(line)`, i.e. closest covered line:
   - margin 2 -> `-1.5`
   - margin 3 -> `-2.5`
   - margin 4 -> `-3.5`
   - margin 5 -> `-4.5`
5. If no exact best line exists, use the highest available covered line.

### Price and Return Check

The bot reads the CLOB orderbook for the winning outcome token and computes:

- best ask;
- available ask size at or below `maxEntryPrice`;
- estimated fee-adjusted return using Polymarket sports fee formula.

Formula:

```text
fee = shares * 0.03 * p * (1 - p)
net_return = (1 - p - 0.03 * p * (1 - p)) / p
```

Default thresholds:

- `entryWindowMinutes = 3`
- `maxEntryPrice = 0.98` for 2% target mode
- `minimumNetReturn = 0.019`
- `minimumNotional = 5`
- `maxNotional = user-configured`, required for live mode

### Decision Output

The detector returns a structured decision:

```json
{
  "action": "BUY",
  "eventSlug": "fifwc-esp-ksa-2026-06-21",
  "marketSlug": "fifwc-esp-ksa-2026-06-21-spread-home-3pt5",
  "question": "Spread: Spain (-3.5)",
  "tokenId": "9545...",
  "conditionId": "0x86fc...",
  "outcome": "Spain",
  "line": -3.5,
  "bestAsk": 0.97,
  "availableSize": 100,
  "estimatedNetReturn": 0.0300,
  "notional": 97
}
```

If the conditions are not met, it returns a no-trade reason such as:

- `MATCH_NOT_LATE_ENOUGH`
- `LEAD_TOO_SMALL`
- `NO_COVERED_SPREAD`
- `PRICE_TOO_HIGH`
- `DEPTH_TOO_SMALL`
- `MARKET_NOT_FOUND`
- `ORDERBOOK_UNAVAILABLE`

## Architecture

Use a small TypeScript CLI/library with focused modules.

### Modules

- `src/domain/types.ts`
  - Shared TypeScript types for match state, market metadata, orderbook, decisions, and trade results.

- `src/domain/fees.ts`
  - Polymarket sports taker fee and return calculations.

- `src/domain/spread-selector.ts`
  - Pure functions that choose the target spread market from match state and spread markets.

- `src/domain/decision.ts`
  - Pure decision logic combining match state, selected spread, orderbook snapshot, thresholds, and stake sizing.

- `src/polymarket/http.ts`
  - Small fetch wrapper with timeout and optional proxy support through environment variables.

- `src/polymarket/event-page.ts`
  - Fetches Polymarket sports page, extracts Next.js `initialState`, decodes base64 + zlib, and returns spread market metadata.

- `src/polymarket/clob.ts`
  - Reads CLOB orderbook and normalizes asks/bids.

- `src/execution/paper-executor.ts`
  - Simulated executor that validates decision shape and returns a deterministic filled result.

- `src/execution/live-executor.ts`
  - Polymarket CLOB live executor behind explicit `BOT_MODE=live`. Uses official client/library or REST signing. Fails fast if credentials are absent.

- `src/cli.ts`
  - CLI entrypoint for running detection and optional execution.

## Testing Strategy

Use TDD. No production behavior should be written before a failing test.

### Unit Tests

- Fee calculation:
  - `0.97` produces about `3.00%` net return.
  - `0.98` produces about `1.98%` net return.

- Spread selection:
  - 4-0 Spain vs Saudi selects `Spain -3.5`, not `Spain -1.5`.
  - 3-0 Argentina vs Algeria selects `Argentina -2.5`.
  - 2-0 Australia vs Türkiye selects `Australia -1.5`.
  - Draw or one-goal lead returns no candidate.

- Decision logic:
  - best ask `0.97` and enough size returns BUY.
  - best ask `0.995` with `maxEntryPrice=0.98` returns PRICE_TOO_HIGH.
  - enough lead but no depth returns DEPTH_TOO_SMALL.

### Integration Tests

Fixtures derived from research/backtest data:

- Spain 4-0 Saudi Arabia spread page fixture includes `Spain -3.5`.
- Japan 4-0 Tunisia spread page fixture includes `Japan -3.5`.
- Egypt 3-1 New Zealand fixture selects `Egypt -1.5`.

### Execution Tests

- Paper executor accepts a valid BUY decision and returns `status=filled` with expected token, price, size, and notional.
- Live executor without credentials fails with a clear `LIVE_CREDENTIALS_MISSING` error.
- Live smoke test is opt-in and skipped unless `BOT_MODE=live` and required credentials are present.

## Acceptance Criteria

The implementation is acceptable when all of the following pass:

1. `npm test` passes with unit and integration tests.
2. A paper-mode command can complete the full flow:
   - load fixture event/markets;
   - select the correct spread;
   - evaluate price/depth;
   - submit to paper executor;
   - output a filled trade result.
3. The decision output includes event slug, market slug, token id, condition id, line, best ask, estimated return, and reason/action.
4. The live executor refuses to run without credentials and returns a clear error.
5. If real credentials are provided, an explicit live smoke command can attempt a minimal FOK/FAK order and report Polymarket API response. This is not required for CI because credentials are external.
6. No secrets are stored in source files, tests, fixtures, or docs.

## Research Data Already Available

- Main research document: `docs/worldcup_tail_spread_research.md`
- Price-history raw data: `data/poly_tail_backtest.json`
- Trades raw data: `data/poly_tail_trades_backtest.json`
- Price summary: `data/price_history_summary.csv`
- Trades summary: `data/trades_summary.csv`

Important research conclusion: strict last-60-second 2-3% opportunities are not universal. A practical bot should start watching around 82-88 minutes and focus on the highest covered spread line.

## Spec Self-Review

- No placeholders remain.
- Scope is one implementation phase: detector, paper execution, live executor interface, tests.
- Live-score provider integration is explicitly out of scope for this phase; match state is supplied as input.
- Runtime trading uses live orderbook/price checks, not historical price-history data.
- Acceptance criteria distinguish paper-mode automated verification from opt-in live smoke verification.
