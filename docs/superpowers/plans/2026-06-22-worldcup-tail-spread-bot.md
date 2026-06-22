# World Cup Tail Spread Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested TypeScript CLI/library that identifies covered World Cup spread markets, evaluates price/depth, and submits either a deterministic paper trade or an opt-in live Polymarket CLOB order.

**Architecture:** Keep the trading decision pure and fixture-testable. Runtime adapters fetch Polymarket page/CLOB data, normalize it into domain types, and pass decisions into `paper` or `live` executors. Live trading is guarded by explicit credentials and a separate smoke command; CI acceptance uses paper execution.

**Tech Stack:** Node 26, TypeScript, Vitest, tsx, undici for HTTP/proxy, `@polymarket/clob-client` plus `@ethersproject/wallet` for the live CLOB adapter.

---

## File Structure

- Create `package.json`: npm scripts for tests, typecheck, fixture paper run, and live smoke.
- Create `tsconfig.json`: strict TypeScript config for `src` and `tests`.
- Create `vitest.config.ts`: Vitest config with Node environment.
- Create `src/domain/types.ts`: match state, spread market, orderbook, decision, executor result types.
- Create `src/domain/fees.ts`: Polymarket sports fee and net-return calculations.
- Create `src/domain/spread-selector.ts`: pure winner/margin and highest-covered-spread selection.
- Create `src/domain/decision.ts`: pure orderbook/threshold/stake decision builder.
- Create `src/polymarket/http.ts`: fetch JSON/text with timeout and optional `HTTP_PROXY`/`HTTPS_PROXY` dispatcher.
- Create `src/polymarket/event-page.ts`: extract/decode `__NEXT_DATA__.props.pageProps.initialState` and recursively normalize spread markets.
- Create `src/polymarket/clob.ts`: normalize CLOB orderbook responses and fetch a token book.
- Create `src/execution/paper-executor.ts`: deterministic filled trade simulator.
- Create `src/execution/live-executor.ts`: credential validation and official CLOB client order adapter.
- Create `src/runner.ts`: reusable identify -> decide -> execute orchestration.
- Create `src/cli.ts`: CLI wrapper for fixture paper runs and opt-in live smoke.
- Create `tests/**`: unit, integration, executor, and CLI tests.
- Create `tests/fixtures/**`: Spain/Japan/Egypt fixture match/market/orderbook JSON.

## Task 1: Project Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create TypeScript/Vitest config files**

`package.json` must include these scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "cli": "tsx src/cli.ts",
    "paper:fixture": "tsx src/cli.ts --mode paper --match-file tests/fixtures/matches/spain-4-0.json --markets-file tests/fixtures/markets/spain-spreads.json --orderbook-file tests/fixtures/orderbooks/spain-3p5-ask-097.json --stake 97",
    "live:smoke": "BOT_MODE=live tsx src/cli.ts --mode live --match-file tests/fixtures/matches/spain-4-0.json --markets-file tests/fixtures/markets/spain-spreads.json --orderbook-file tests/fixtures/orderbooks/spain-3p5-ask-097.json --stake 5 --order-type FOK"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install undici @polymarket/clob-client @ethersproject/wallet && npm install -D typescript tsx vitest @types/node`

Expected: `package-lock.json` is created and `npm test` can invoke Vitest.

- [ ] **Step 3: Commit tooling**

Run: `git add package.json package-lock.json tsconfig.json vitest.config.ts && git commit -m "chore: add typescript test tooling"`

## Task 2: Domain Fees And Spread Selection

**Files:**
- Create: `tests/domain/fees.test.ts`
- Create: `tests/domain/spread-selector.test.ts`
- Create: `src/domain/types.ts`
- Create: `src/domain/fees.ts`
- Create: `src/domain/spread-selector.ts`

- [ ] **Step 1: Write failing fee tests**

```ts
import { describe, expect, test } from "vitest";
import { netReturnRate, sportsTakerFeePerShare } from "../../src/domain/fees";

describe("sports fee math", () => {
  test("0.97 entry produces about 3.00% net return after sports taker fee", () => {
    expect(sportsTakerFeePerShare(0.97)).toBeCloseTo(0.000873, 6);
    expect(netReturnRate(0.97)).toBeCloseTo(0.03003, 5);
  });

  test("0.98 entry produces about 1.98% net return after sports taker fee", () => {
    expect(sportsTakerFeePerShare(0.98)).toBeCloseTo(0.000588, 6);
    expect(netReturnRate(0.98)).toBeCloseTo(0.01981, 5);
  });
});
```

Run: `npm test -- tests/domain/fees.test.ts`
Expected: FAIL because `src/domain/fees.ts` does not exist.

- [ ] **Step 2: Implement minimal fee functions**

Create `src/domain/fees.ts` with `SPORTS_TAKER_FEE_RATE = 0.03`, `sportsTakerFeePerShare(price)`, `netReturnRate(price)`, and input validation for `0 < price < 1`.

Run: `npm test -- tests/domain/fees.test.ts`
Expected: PASS.

- [ ] **Step 3: Write failing spread selector tests**

Cover these behaviors: Spain 4-0 selects Spain `-3.5`; Argentina 3-0 selects Argentina `-2.5`; Australia 2-0 selects Australia `-1.5`; one-goal lead returns `LEAD_TOO_SMALL`; missing market returns `NO_COVERED_SPREAD`.

Run: `npm test -- tests/domain/spread-selector.test.ts`
Expected: FAIL because selector module does not exist.

- [ ] **Step 4: Implement domain types and spread selector**

Create `src/domain/types.ts` with `MatchState`, `SpreadMarket`, `SelectedSpread`, and no-trade reason types. Create `src/domain/spread-selector.ts` with `getLeader`, `isWorldCupMatch`, `selectCoveredSpread`.

Run: `npm test -- tests/domain/fees.test.ts tests/domain/spread-selector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit domain core**

Run: `git add src/domain tests/domain && git commit -m "feat: select covered world cup spreads"`

## Task 3: Decision Logic And Orderbook Handling

**Files:**
- Create: `tests/domain/decision.test.ts`
- Modify: `src/domain/types.ts`
- Create: `src/domain/decision.ts`

- [ ] **Step 1: Write failing decision tests**

Tests must assert: best ask `0.97` with enough size returns `BUY`; best ask `0.995` returns `PRICE_TOO_HIGH`; no eligible depth returns `DEPTH_TOO_SMALL`; net return below threshold returns `RETURN_TOO_LOW`; notional below minimum returns `DEPTH_TOO_SMALL`.

Run: `npm test -- tests/domain/decision.test.ts`
Expected: FAIL because decision module does not exist.

- [ ] **Step 2: Implement decision builder**

Create `src/domain/decision.ts` with `buildTradeDecision(match, selected, orderbook, thresholds)`. Sort asks ascending, sum size at or below max price, size the order as `min(maxNotional / bestAsk, availableSize)`, calculate fee-adjusted return, and return structured `BUY`/`NO_TRADE` decisions.

Run: `npm test -- tests/domain/decision.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit decision logic**

Run: `git add src/domain tests/domain && git commit -m "feat: evaluate spread entry decisions"`

## Task 4: Polymarket Data Adapters And Fixtures

**Files:**
- Create: `tests/polymarket/event-page.test.ts`
- Create: `tests/polymarket/clob.test.ts`
- Create: `src/polymarket/http.ts`
- Create: `src/polymarket/event-page.ts`
- Create: `src/polymarket/clob.ts`
- Create: `tests/fixtures/matches/*.json`
- Create: `tests/fixtures/markets/*.json`
- Create: `tests/fixtures/orderbooks/*.json`

- [ ] **Step 1: Create fixture JSON files**

Fixtures must include:

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

Market fixtures must include `Spain -1.5`, `Spain -2.5`, `Spain -3.5`, `Japan -3.5`, and `Egypt -1.5` style records with stable fake token IDs and condition IDs.

- [ ] **Step 2: Write failing event-page tests**

Create a compressed `initialState` test HTML in code using `zlib.deflateSync(JSON.stringify(state)).toString("base64")`. Assert extractor returns spread markets and parses `-3.5` from `Spread: Spain (-3.5)`.

Run: `npm test -- tests/polymarket/event-page.test.ts`
Expected: FAIL because event-page module does not exist.

- [ ] **Step 3: Implement event-page adapter**

Implement `extractNextInitialState`, `decodeInitialStatePayload`, `findSpreadMarkets`, and `normalizeSpreadMarket`. Recursively traverse unknown JSON and only accept objects with outcomes, token IDs, condition ID, slug, and question.

Run: `npm test -- tests/polymarket/event-page.test.ts`
Expected: PASS.

- [ ] **Step 4: Write failing CLOB normalization tests**

Assert string price/size orderbooks normalize into numeric asks sorted ascending and preserve `tick_size`/`neg_risk`.

Run: `npm test -- tests/polymarket/clob.test.ts`
Expected: FAIL because CLOB module does not exist.

- [ ] **Step 5: Implement HTTP and CLOB adapters**

`http.ts` exposes `fetchJson`/`fetchText` with timeout and optional proxy dispatcher. `clob.ts` exposes `normalizeOrderbook` and `fetchOrderbook(tokenId)`.

Run: `npm test -- tests/polymarket/event-page.test.ts tests/polymarket/clob.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit adapters and fixtures**

Run: `git add src/polymarket tests/polymarket tests/fixtures && git commit -m "feat: normalize polymarket spread data"`

## Task 5: Executors

**Files:**
- Create: `tests/execution/paper-executor.test.ts`
- Create: `tests/execution/live-executor.test.ts`
- Create: `src/execution/paper-executor.ts`
- Create: `src/execution/live-executor.ts`

- [ ] **Step 1: Write failing paper executor test**

Assert a valid `BUY` decision returns `status: "filled"`, `mode: "paper"`, the same token ID, price, shares, notional, fee, and a deterministic `paper-` order ID.

Run: `npm test -- tests/execution/paper-executor.test.ts`
Expected: FAIL because paper executor does not exist.

- [ ] **Step 2: Implement paper executor**

Create `PaperExecutor.execute(decision)` and reject `NO_TRADE` decisions with code `PAPER_NO_TRADE_DECISION`.

Run: `npm test -- tests/execution/paper-executor.test.ts`
Expected: PASS.

- [ ] **Step 3: Write failing live executor tests**

Assert missing env throws `LIVE_CREDENTIALS_MISSING`. Assert injected fake live client receives token ID, price, size, order type, tick size, and neg-risk from the decision.

Run: `npm test -- tests/execution/live-executor.test.ts`
Expected: FAIL because live executor does not exist.

- [ ] **Step 4: Implement live executor**

Create env parser, `LiveExecutionError`, injected client interface, and default CLOB client factory using `@polymarket/clob-client`, `@ethersproject/wallet`, `createAndPostOrder`, `Side.BUY`, and `OrderType.FOK`/`FAK`.

Run: `npm test -- tests/execution/paper-executor.test.ts tests/execution/live-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit executors**

Run: `git add src/execution tests/execution && git commit -m "feat: add paper and live executors"`

## Task 6: Runner, CLI, And Acceptance Tests

**Files:**
- Create: `tests/integration/fixture-flow.test.ts`
- Create: `tests/cli.test.ts`
- Create: `src/runner.ts`
- Create: `src/cli.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing fixture-flow test**

Load Spain fixture match/markets/orderbook and assert `runPaperFlow` returns a filled paper trade for `Spain -3.5` at `0.97` with net return about `3.00%`.

Run: `npm test -- tests/integration/fixture-flow.test.ts`
Expected: FAIL because runner does not exist.

- [ ] **Step 2: Implement runner**

Create `runPaperFlow({ match, markets, orderbook, thresholds })` and `runDecisionFlow(...)` orchestration using selector, decision builder, and executors.

Run: `npm test -- tests/integration/fixture-flow.test.ts`
Expected: PASS.

- [ ] **Step 3: Write failing CLI test**

Call `runCli([...])` with fixture paths and assert JSON output includes `status: "filled"`, `marketSlug` containing `spread-home-3pt5`, and `mode: "paper"`.

Run: `npm test -- tests/cli.test.ts`
Expected: FAIL because CLI module does not exist.

- [ ] **Step 4: Implement CLI**

Parse `--mode`, `--match-file`, `--markets-file`, `--orderbook-file`, `--stake`, `--max-entry-price`, `--minimum-net-return`, `--minimum-notional`, and `--order-type`. Print a JSON result. For `--mode live`, use live executor and surface `LIVE_CREDENTIALS_MISSING` clearly.

Run: `npm test -- tests/cli.test.ts tests/integration/fixture-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Update README usage**

Document `npm test`, `npm run paper:fixture`, `npm run typecheck`, and `npm run live:smoke`. State that `HTTP_PROXY`/`HTTPS_PROXY` are normal network settings and live credentials are env-only.

- [ ] **Step 6: Commit runner and CLI**

Run: `git add src/runner.ts src/cli.ts tests/integration tests/cli.test.ts README.md && git commit -m "feat: add paper trading cli flow"`

## Task 7: Final Verification And Push

**Files:**
- Modify: none unless verification reveals defects.

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no TypeScript errors.

- [ ] **Step 3: Run paper acceptance command**

Run: `npm run paper:fixture`
Expected: JSON with `status: "filled"`, `action: "BUY"`, `outcome: "Spain"`, `line: -3.5`, `bestAsk: 0.97`, and `mode: "paper"`.

- [ ] **Step 4: Run missing-credentials live smoke guard**

Run: `npm run live:smoke`
Expected: non-zero exit with `LIVE_CREDENTIALS_MISSING` unless real live credentials are intentionally configured.

- [ ] **Step 5: Secret scan**

Run: `rg -n "PRIVATE_KEY|POLY_PRIVATE|POLY_API|gho_|sk-|BEGIN .*PRIVATE|0x[a-fA-F0-9]{64}" . --glob '!node_modules/**' --glob '!package-lock.json'`
Expected: only docs/tests mention env variable names or fake fixture IDs.

- [ ] **Step 6: Commit any final fixes and push**

Run: `git status -sb`, commit remaining intended changes, then `git push`.

## Self-Review

- Spec coverage: detector, fee math, orderbook price/depth checks, paper executor, live credential guard, CLI, fixtures, and acceptance commands are all mapped to tasks.
- Placeholder scan: no `TBD`, `TODO`, or open-ended implementation placeholders remain.
- Type consistency: `MatchState`, `SpreadMarket`, `OrderbookSnapshot`, `TradeDecision`, and `TradeResult` are introduced before use and reused consistently.
- Scope check: live-score feed integration remains out of scope; match state is supplied from fixture/file or caller input.
