# Polymarket Live Sports And Execution Repair Design

Date: 2026-06-23  
Status: approved for implementation planning  
Scope: live data, tail-window correctness, live fill confirmation, duplicate protection, and auditability

## Context

The bot already has a working rule layer for the user's core safety assumption: a candidate is eligible only when losing requires at least two adverse goals (`lossRequiresGoals >= 2`). That rule layer is not the current concern.

The remaining correctness issues are in the live pipeline around real-time match state, live order result normalization, and duplicate-position protection. The new research in `docs/polymarket_live_sports_data.md` changes the data-source design:

- Polymarket has an unauthenticated Sports WebSocket at `wss://sports-api.polymarket.com/ws`.
- The WebSocket pushes live `score`, `period`, `elapsed`, `live`, and `ended` fields.
- The WebSocket may identify games by `slug`, `gameId`, or `sportradarGameId`, so runtime matching must not depend only on the global `fifwc-*` page slug.
- No reliable `remainingMinutes`, `stoppageTime`, `addedTime`, `expectedEndMinute`, or equivalent field has been confirmed in the live sports schema.
- Therefore the bot must not pretend that `minute >= 87` equals the final three minutes of the match.

The user's capital size is small enough that orderbook depth and multi-level sweeping are lower priority. Blended full-fill across several ask levels remains out of scope for this repair and should be implemented after the live pipeline is correct.

## Goals

1. Use Polymarket's Sports WebSocket as the primary live score source for watch mode.
2. Preserve page/Gamma/Gateway sources for event, market, token, and fallback snapshot discovery.
3. Match live updates to World Cup events by `slug`, `gameId`, `sportradarGameId`, then team/date fallback.
4. Replace fixed-minute tail logic with a deterministic tail-window classifier.
5. Use conservative `90:00+` tail entry when true remaining time is unavailable.
6. Normalize live order results from confirmed CLOB order/trade state, not from pre-order estimates.
7. Prevent repeated full-bankroll entries in the same match.
8. Write live sports and execution evidence to local audit files for later debugging.

## Non-Goals

- Do not implement blended multi-level orderbook sweeping in this repair.
- Do not add probability weighting for strategies; the approved assumption is that two-goal-cushion failure risk is negligible.
- Do not claim strict "final 180 seconds" support until the live feed exposes or confirms reliable remaining-time data.
- Do not add proxy-bypass logic. Continue using standard `HTTP_PROXY` / `HTTPS_PROXY` support.
- Do not place live orders in automated tests. Live placement remains an explicit smoke/acceptance step with real credentials.

## Architecture

### 1. Sports Live Provider

Add `src/polymarket/sports-live.ts`.

Responsibilities:

- Connect to `wss://sports-api.polymarket.com/ws`.
- Use the existing proxy environment convention where the runtime supports it.
- Reply `pong` when the server sends `ping`.
- Parse JSON updates and ignore malformed messages without crashing the watch loop.
- Normalize updates into a project-level live match shape:

```ts
interface LiveSportsUpdate {
  eventSlug: string;
  gameId?: number;
  sportradarGameId?: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  score: string;
  period: "NS" | "1H" | "HT" | "2H" | "ET" | "FT" | "UNKNOWN";
  elapsed: string;
  elapsedSeconds?: number;
  isLive: boolean;
  ended: boolean;
  raw: unknown;
  receivedAt: string;
}
```

- Map raw updates to local events by:
  1. exact `slug`;
  2. `gameId`;
  3. `sportradarGameId`;
  4. normalized home/away team names plus match date.
- Optionally append raw and normalized updates to `POLY_LIVE_AUDIT_FILE` as NDJSON.

The provider should expose small pure helpers for parsing score, period, elapsed time, and event matching so tests do not need a real WebSocket.

### 2. Event Index

Extend `src/polymarket/worldcup-events.ts` with a richer event index function, for example:

```ts
interface WorldCupEventRef {
  eventSlug: string;
  gameId?: number;
  sportradarGameId?: string;
  homeTeam?: string;
  awayTeam?: string;
  startTime?: string;
}
```

The existing slug-only function can remain for compatibility, but watch mode should build the rich index. Sources:

- Gamma/global page for the tradable `fifwc-*` event slug and markets.
- Sports Gateway as a supplemental source for `gameId`, `sportradarGameId`, and `fwc-*` mappings.
- Page initial state where available.

### 3. Tail Window Classifier

Add `src/domain/time-window.ts`.

The classifier converts a normalized match state into an explicit tail-window decision:

```ts
type TailWindowMode = "remaining" | "conservative90";

interface TailWindowDecision {
  eligible: boolean;
  source: "remaining_seconds" | "remaining_minutes" | "conservative_90_plus" | "not_enough_time_data";
  details: string;
}
```

Rules:

- If `period !== "2H"`, `isLive !== true`, or `ended === true`, return ineligible.
- If `remainingSeconds` exists, eligible when `0 <= remainingSeconds <= 180`.
- Else if `remainingMinutes` exists, eligible when `0 <= remainingMinutes <= 3`.
- Else, in `conservative90` mode, eligible when `period === "2H"` and `elapsedSeconds >= 90 * 60`.
- Else return ineligible with `not_enough_time_data`.

This classifier is intentionally conservative. It may miss 87-90 minute opportunities when stoppage time is unknown, but it avoids false claims that the bot knows the true final three minutes.

### 4. Strategy Integration

`selectLossRequiresCandidates` and `buildTradeDecision` currently depend on `MatchState.remainingMinutes`. The repair should route the entry-window check through the new classifier rather than spreading time logic across several files.

Expected behavior:

- Strategy selection remains unchanged for scoring, market parsing, and `lossRequiresGoals`.
- A candidate can only reach orderbook evaluation if the classifier says the match is in the configured tail window.
- Decision output should include the tail-window source when available, so logs distinguish strict remaining-time entries from conservative 90-plus entries.

### 5. CLI Watch Flow

`src/cli.ts` watch mode should become event-driven for live World Cup monitoring:

1. Build the World Cup event index.
2. Connect to Sports WebSocket.
3. For each relevant update, normalize it to `MatchState`.
4. Run the tail-window classifier.
5. Only fetch markets and orderbooks after the match is in the tail window.
6. Run the existing two-goal-cushion strategy decision.
7. Execute paper/live order if a positive-net candidate exists.
8. Stop after a filled/partial/posted live result or continue after no-trade updates, depending on `--max-iterations` or runtime options.

The old polling path can stay for tests and as a fallback, but `--watch --worldcup true` should prefer the Sports WebSocket path.

### 6. Live Execution Confirmation

Repair `src/execution/live-executor.ts` so returned `TradeResult` reflects actual CLOB state.

Current issue:

- `normalizeLiveOrderResult` uses requested `order.size` and `order.notional` as if they were filled.
- This can misreport FAK partial fills, FOK no-fills, posted orders, or cancellation cases.

New design:

- The live client abstraction should support:
  - posting the market buy;
  - reading `getOrder(orderId)` when an order id exists;
  - reading `getTrades({ asset_id })` or equivalent and filtering by order id / market / token;
  - reading `getOpenOrders({ asset_id })` as a fallback;
  - optionally canceling unexpected resting orders for FOK/FAK.
- Normalize from confirmed data:
  - `filled`: confirmed matched shares are materially positive and no open remainder exists.
  - `partial`: confirmed matched shares are positive but below requested amount.
  - `posted`: an open order remains and no rejection is present.
  - `rejected`: Polymarket rejects the order or confirmed matched shares are zero with no open order.
  - `canceled`: an unexpected open remainder is canceled successfully.
- Add `raw` with the post response and confirmation payloads.
- Compute `shares`, `notional`, weighted average `price`, `fee`, and `estimatedProfit` from actual fills where available.

If the CLOB API does not return enough confirmation data in a particular response, the executor should return a conservative non-filled status rather than fabricate a fill.

### 7. Ledger Protection

Repair `src/persistence/ledger.ts` and the CLI duplicate check.

Current issue:

- Duplicate protection keys on `eventSlug + tokenId`.
- The user's runtime rule is one full-bankroll entry per match, chosen by best edge.

New behavior:

- Default duplicate check should be event-level: any active result for the same `eventSlug` blocks a second entry.
- Active statuses: `filled`, `partial`, `posted`.
- Inactive statuses: `rejected`, `canceled`.
- Keep token-level details for reporting, but do not allow a second token in the same event unless a future explicit override is added.

### 8. Configuration

Add or document:

- `POLY_LIVE_AUDIT_FILE`: optional NDJSON path for raw live sports updates and normalized decisions.
- `POLY_TAIL_TIME_MODE`: default `conservative90`; future value `remaining` can require true remaining-time fields.
- Existing `HTTP_PROXY` / `HTTPS_PROXY` remain the proxy mechanism.
- Existing live credential and balance variables remain unchanged.

### 9. Testing

Unit tests:

- Sports update parsing:
  - `score: "3-1"` maps to home/away goals.
  - `elapsed: "89:30"` maps to `5370`.
  - `elapsed: "90+3'"` or `93:00` maps to 5580 if observed fixtures require it.
  - malformed updates are ignored safely.
- Event matching:
  - exact slug match.
  - `gameId` match across `fifwc-*` and `fwc-*`.
  - `sportradarGameId` match.
  - team/date fallback.
- Tail-window classifier:
  - `89:30` with no remaining time is ineligible in conservative mode.
  - `90:00` and later is eligible in conservative mode.
  - `remainingSeconds <= 180` is eligible.
  - `NS`, `HT`, `FT`, and `ended=true` are ineligible.
- Live execution normalization:
  - matched response becomes `filled` only with confirmed fill data.
  - partial FAK becomes `partial`.
  - rejected or zero-fill FOK becomes `rejected`.
  - open order becomes `posted` or `canceled` depending on cancel outcome.
- Ledger:
  - event-level active entry blocks a second token in the same event.
  - rejected/canceled entries do not block a later attempt.

Integration tests:

- Fake WebSocket update for a World Cup match maps to a `MatchState`, passes the conservative tail window at 90-plus, identifies a two-goal-cushion candidate, fetches a mocked orderbook, and reaches paper execution.
- Injected live executor simulates confirmed partial and zero-fill outcomes; CLI summary and ledger match the actual status.
- Existing fixture tests for strategy selection and fees remain passing.

Verification commands:

```bash
npm test
npm run typecheck
git diff --check
```

Live acceptance:

1. Run status check with real env:

```bash
npm run live:status
```

2. Run Sports WebSocket capture before and during a World Cup match, writing audit data.
3. Confirm updates can be mapped by `gameId` or `sportradarGameId`.
4. At 80+ minutes, inspect elapsed format and any newly visible time fields.
5. In conservative `90:00+` mode, allow a small live FOK/FAK trade only if a two-goal-cushion candidate and positive net return are present.
6. Accept the live test only when CLOB confirmation shows the true fill status and ledger records the same status.

## Implementation Order

1. Add pure event matching and time-window modules with tests.
2. Add Sports WebSocket provider and audit writer with mocked WebSocket tests.
3. Update World Cup event index to carry `gameId` and `sportradarGameId`.
4. Wire watch mode to the provider while preserving fixture/polling tests.
5. Repair live execution confirmation and result normalization.
6. Repair ledger duplicate protection to event-level active blocking.
7. Run the full local verification suite.
8. Perform live capture and then a controlled live smoke test.
9. Implement blended multi-level orderbook sweeping in a later follow-up.

## Risks And Mitigations

- Sports WebSocket fields may differ during actual soccer matches. Mitigation: raw audit logging and parser tests from captured fixtures.
- Conservative 90-plus mode can miss 87-90 minute opportunities. Mitigation: document this explicitly and upgrade only after real live feed evidence supports stricter remaining-time logic.
- CLOB confirmation may be eventually consistent. Mitigation: poll confirmation briefly and return non-filled status if no fill is verifiable.
- FAK can partially fill. Mitigation: `partial` becomes a first-class status and ledger records actual filled size.
- Existing uncommitted strategy/docs changes should not be mixed into this repair spec commit. Mitigation: commit only this design document.
