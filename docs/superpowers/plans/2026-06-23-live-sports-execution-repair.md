# Live Sports Execution Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live World Cup monitoring use Polymarket Sports WebSocket data, use correct tail-window gating, confirm real CLOB fills, and block repeated full-bankroll entries in one match.

**Architecture:** Add focused domain modules for tail-window and sports update normalization, then wire them into the existing CLI/runner flow. Keep page/Gamma/CLOB adapters for markets and orderbooks, while Sports WebSocket becomes the primary live score source for `--watch --worldcup true`. Live execution returns confirmed fill status from CLOB order/trade/open-order checks instead of pre-order estimates.

**Tech Stack:** TypeScript ESM, Vitest, undici WebSocket/ProxyAgent, @polymarket/clob-client-v2, viem, existing CLI runner.

---

## File Structure

- Create `src/domain/time-window.ts`: pure tail-window classifier used by selector and decision code.
- Modify `src/domain/types.ts`: extend match time metadata, tail-window metadata, and live trade statuses.
- Modify `src/domain/loss-requires-strategy.ts`: replace local remaining-minute check with `isTailWindowEligible`.
- Modify `src/domain/decision.ts`: replace local remaining-minute check with `isTailWindowEligible`, include tail-window source/details in BUY output.
- Modify `src/runner.ts`: pass tail-window options through strategy selection and decision building.
- Create `tests/domain/time-window.test.ts`: strict and conservative tail-window tests.
- Modify `tests/domain/decision.test.ts`, `tests/domain/loss-requires-strategy.test.ts`, and `tests/integration/loss-requires-flow.test.ts`: assert conservative 90-plus and remaining-time behavior.
- Modify `src/polymarket/worldcup-events.ts`: add rich event references with `gameId`, `sportradarGameId`, teams, and start time.
- Create `tests/polymarket/worldcup-events.test.ts`: event index normalization and dedupe tests.
- Create `src/polymarket/sports-live.ts`: Sports WebSocket update normalization, event matching, provider, and audit writer.
- Create `tests/polymarket/sports-live.test.ts`: parsing, matching, malformed message, and audit tests.
- Modify `src/cli.ts`: add Sports WebSocket watch path for `--watch --worldcup true`, config parsing, and injected test hooks.
- Modify `tests/cli.test.ts`: WebSocket-driven watch, conservative timing, and event-level duplicate tests.
- Modify `src/execution/live-executor.ts`: add confirmation client methods and real fill normalization.
- Modify `tests/execution/live-executor.test.ts`: filled, partial, posted, rejected, canceled, and no-fabricated-fill tests.
- Modify `src/persistence/ledger.ts`: active status set and event-level duplicate check.
- Modify `tests/persistence/ledger.test.ts`: event-level active blocking and inactive-status behavior.
- Modify `.env.example` and `README.md`: document `POLY_LIVE_AUDIT_FILE` and `POLY_TAIL_TIME_MODE`.

---

## Task 1: Tail Window Types And Classifier

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/domain/time-window.ts`
- Test: `tests/domain/time-window.test.ts`

- [ ] **Step 1: Write failing tail-window tests**

Create `tests/domain/time-window.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { classifyTailWindow, isTailWindowEligible } from "../../src/domain/time-window.js";
import type { MatchState } from "../../src/domain/types.js";

const baseMatch: MatchState = {
  eventSlug: "fifwc-strong-weak-2026-06-23",
  homeTeam: "Strong",
  awayTeam: "Weak",
  homeGoals: 2,
  awayGoals: 0,
  minute: 90,
  period: "2H",
  isLive: true
};

describe("tail-window classifier", () => {
  test("uses strict remainingSeconds when available", () => {
    expect(classifyTailWindow({ ...baseMatch, remainingSeconds: 180 })).toMatchObject({
      eligible: true,
      source: "remaining_seconds"
    });
    expect(classifyTailWindow({ ...baseMatch, remainingSeconds: 181 })).toMatchObject({
      eligible: false,
      source: "remaining_seconds"
    });
  });

  test("uses strict remainingMinutes when available", () => {
    expect(classifyTailWindow({ ...baseMatch, remainingMinutes: 3 })).toMatchObject({
      eligible: true,
      source: "remaining_minutes"
    });
    expect(classifyTailWindow({ ...baseMatch, remainingMinutes: 4 })).toMatchObject({
      eligible: false,
      source: "remaining_minutes"
    });
  });

  test("conservative mode enters only at 90:00 or later without remaining time", () => {
    expect(classifyTailWindow({ ...baseMatch, elapsedSeconds: 89 * 60 + 30 })).toMatchObject({
      eligible: false,
      source: "conservative_90_plus"
    });
    expect(classifyTailWindow({ ...baseMatch, elapsedSeconds: 90 * 60 })).toMatchObject({
      eligible: true,
      source: "conservative_90_plus"
    });
  });

  test("remaining-only mode refuses matches without remaining time", () => {
    expect(classifyTailWindow({ ...baseMatch, elapsedSeconds: 91 * 60 }, { mode: "remaining" })).toMatchObject({
      eligible: false,
      source: "not_enough_time_data"
    });
  });

  test("never enters for non-live or non-second-half states", () => {
    expect(isTailWindowEligible({ ...baseMatch, period: "HT", elapsedSeconds: 90 * 60 })).toBe(false);
    expect(isTailWindowEligible({ ...baseMatch, period: "FT", elapsedSeconds: 90 * 60 })).toBe(false);
    expect(isTailWindowEligible({ ...baseMatch, isLive: false, elapsedSeconds: 90 * 60 })).toBe(false);
    expect(isTailWindowEligible({ ...baseMatch, ended: true, elapsedSeconds: 90 * 60 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- --run tests/domain/time-window.test.ts
```

Expected: FAIL because `src/domain/time-window.ts` does not exist.

- [ ] **Step 3: Extend domain types**

Modify `src/domain/types.ts`:

```ts
export type MatchPeriod = "NS" | "1H" | "HT" | "2H" | "ET" | "FT" | "UNKNOWN";

export type TailWindowSource =
  | "remaining_seconds"
  | "remaining_minutes"
  | "conservative_90_plus"
  | "not_enough_time_data"
  | "not_live_second_half";

export interface MatchState {
  eventSlug: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  minute: number;
  period: MatchPeriod;
  isLive: boolean;
  ended?: boolean;
  elapsed?: string;
  elapsedSeconds?: number;
  stoppageMinutes?: number;
  expectedEndMinute?: number;
  remainingMinutes?: number;
  remainingSeconds?: number;
  gameId?: number;
  sportradarGameId?: string;
  tailWindowSource?: TailWindowSource;
  tailWindowDetails?: string;
}
```

Also update `BuyTradeDecision` with:

```ts
  tailWindowSource?: TailWindowSource;
  tailWindowDetails?: string;
```

Update `TradeResult.status` to:

```ts
  status: "filled" | "partial" | "posted" | "rejected" | "canceled";
```

- [ ] **Step 4: Implement the classifier**

Create `src/domain/time-window.ts`:

```ts
import type { MatchState, TailWindowSource } from "./types.js";

export type TailWindowMode = "remaining" | "conservative90";

export interface TailWindowOptions {
  entryWindowMinutes?: number;
  mode?: TailWindowMode;
}

export interface TailWindowDecision {
  eligible: boolean;
  source: TailWindowSource;
  details: string;
}

export function classifyTailWindow(match: MatchState, options: TailWindowOptions = {}): TailWindowDecision {
  const entryWindowMinutes = options.entryWindowMinutes ?? 3;
  const entryWindowSeconds = entryWindowMinutes * 60;
  const mode = options.mode ?? "conservative90";

  if (match.period !== "2H" || !match.isLive || match.ended === true) {
    return {
      eligible: false,
      source: "not_live_second_half",
      details: `period=${match.period} isLive=${match.isLive} ended=${match.ended === true}`
    };
  }

  if (match.remainingSeconds !== undefined) {
    const eligible = match.remainingSeconds >= 0 && match.remainingSeconds <= entryWindowSeconds;
    return {
      eligible,
      source: "remaining_seconds",
      details: `remainingSeconds=${match.remainingSeconds} threshold=${entryWindowSeconds}`
    };
  }

  if (match.remainingMinutes !== undefined) {
    const eligible = match.remainingMinutes >= 0 && match.remainingMinutes <= entryWindowMinutes;
    return {
      eligible,
      source: "remaining_minutes",
      details: `remainingMinutes=${match.remainingMinutes} threshold=${entryWindowMinutes}`
    };
  }

  if (mode === "conservative90" && match.elapsedSeconds !== undefined) {
    const eligible = match.elapsedSeconds >= 90 * 60;
    return {
      eligible,
      source: "conservative_90_plus",
      details: `elapsedSeconds=${match.elapsedSeconds} threshold=${90 * 60}`
    };
  }

  return {
    eligible: false,
    source: "not_enough_time_data",
    details: "No remainingSeconds, remainingMinutes, or conservative elapsedSeconds entry was available"
  };
}

export function isTailWindowEligible(match: MatchState, options: TailWindowOptions = {}): boolean {
  return classifyTailWindow(match, options).eligible;
}
```

- [ ] **Step 5: Run the test**

Run:

```bash
npm test -- --run tests/domain/time-window.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS after any status type exhaustiveness updates in tests are addressed.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/domain/time-window.ts tests/domain/time-window.test.ts
git commit -m "feat: add tail window classifier"
```

---

## Task 2: Integrate Tail Window Into Strategy And Decision Flow

**Files:**
- Modify: `src/domain/loss-requires-strategy.ts`
- Modify: `src/domain/decision.ts`
- Modify: `src/runner.ts`
- Modify: `src/cli.ts`
- Test: `tests/domain/loss-requires-strategy.test.ts`
- Test: `tests/domain/decision.test.ts`
- Test: `tests/integration/loss-requires-flow.test.ts`

- [ ] **Step 1: Write failing integration tests**

Add to `tests/integration/loss-requires-flow.test.ts`:

```ts
test("uses conservative 90-plus tail window when remaining time is unavailable", () => {
  const ninetyPlusMatch = {
    ...match,
    remainingMinutes: undefined,
    elapsedSeconds: 90 * 60
  };

  const decision = runDecisionFlow({
    match: ninetyPlusMatch,
    markets,
    orderbooks: [book("weak-no", 0.99, 100)],
    stake: 10,
    thresholds: { entryWindowMinutes: 3 }
  });

  expect(decision).toMatchObject({
    action: "BUY",
    strategy: "loser_no",
    tailWindowSource: "conservative_90_plus"
  });
});

test("does not trade at 89:30 without remaining time", () => {
  const earlyMatch = {
    ...match,
    remainingMinutes: undefined,
    elapsedSeconds: 89 * 60 + 30
  };

  const decision = runDecisionFlow({
    match: earlyMatch,
    markets,
    orderbooks: [book("weak-no", 0.99, 100)],
    stake: 10,
    thresholds: { entryWindowMinutes: 3 }
  });

  expect(decision).toMatchObject({
    action: "NO_TRADE",
    reason: "MATCH_NOT_LATE_ENOUGH"
  });
});
```

- [ ] **Step 2: Run the failing integration tests**

Run:

```bash
npm test -- --run tests/integration/loss-requires-flow.test.ts
```

Expected: FAIL because the existing selector and decision code only use `remainingMinutes`.

- [ ] **Step 3: Update selector options and time check**

Modify `src/domain/loss-requires-strategy.ts` imports and option type:

```ts
import { classifyTailWindow, type TailWindowMode } from "./time-window.js";
```

```ts
export interface LossRequiresStrategyOptions {
  entryWindowMinutes?: number;
  includeLocked?: boolean;
  tailWindowMode?: TailWindowMode;
}
```

Replace the current `isInEntryWindow` call in `selectLossRequiresCandidates` with:

```ts
if (!isWorldCupMatch(match) || !isInEntryWindow(match, entryWindowMinutes, options.tailWindowMode)) return [];
```

Replace local `isInEntryWindow` with:

```ts
function isInEntryWindow(match: MatchState, entryWindowMinutes: number, tailWindowMode?: TailWindowMode): boolean {
  return classifyTailWindow(match, { entryWindowMinutes, mode: tailWindowMode }).eligible;
}
```

- [ ] **Step 4: Update decision time check and BUY metadata**

Modify `src/domain/decision.ts` imports:

```ts
import { classifyTailWindow, type TailWindowMode } from "./time-window.js";
```

Change `buildTradeDecision` signature to accept an optional mode:

```ts
export function buildTradeDecision(
  match: MatchState,
  selected: SelectedStrategyMarket,
  orderbook: OrderbookSnapshot,
  thresholds: DecisionThresholds,
  tailWindowMode?: TailWindowMode
): TradeDecision {
```

Replace the first time check with:

```ts
  const tailWindow = classifyTailWindow(match, {
    entryWindowMinutes: thresholds.entryWindowMinutes,
    mode: tailWindowMode
  });
  if (!tailWindow.eligible) {
    return noTrade("MATCH_NOT_LATE_ENOUGH", match.eventSlug, tailWindow.details);
  }
```

Add BUY metadata:

```ts
    tailWindowSource: tailWindow.source,
    tailWindowDetails: tailWindow.details,
```

Remove the old local `isWithinEntryWindow` helper from `src/domain/decision.ts`.

- [ ] **Step 5: Update runner inputs**

Modify `src/runner.ts`:

```ts
import type { TailWindowMode } from "./domain/time-window.js";
```

Extend `FlowInput`:

```ts
  tailWindowMode?: TailWindowMode;
```

Pass the mode into selector and decision builder:

```ts
const candidates = selectLossRequiresCandidates(input.match, input.markets, {
  entryWindowMinutes: thresholds.entryWindowMinutes,
  tailWindowMode: input.tailWindowMode
});
```

```ts
return [buildTradeDecision(input.match, candidate, orderbook, thresholds, input.tailWindowMode)];
```

- [ ] **Step 6: Update CLI argument and env parsing**

Modify `src/cli.ts` imports:

```ts
import type { TailWindowMode } from "./domain/time-window.js";
```

Add to `ParsedArgs`:

```ts
  tailTimeMode?: TailWindowMode;
```

Pass into `runDecisionFlow`:

```ts
      tailWindowMode: args.tailTimeMode ?? tailWindowModeFromEnv(env)
```

Add parsing:

```ts
  if (raw.tailTimeMode) parsed.tailTimeMode = parseTailWindowMode(raw.tailTimeMode);
```

Add helpers:

```ts
function tailWindowModeFromEnv(env: Record<string, string | undefined>): TailWindowMode | undefined {
  return env.POLY_TAIL_TIME_MODE ? parseTailWindowMode(env.POLY_TAIL_TIME_MODE) : undefined;
}

function parseTailWindowMode(value: string): TailWindowMode {
  if (value === "remaining" || value === "conservative90") return value;
  throw new Error("--tail-time-mode/POLY_TAIL_TIME_MODE must be remaining or conservative90");
}
```

- [ ] **Step 7: Run targeted tests**

Run:

```bash
npm test -- --run tests/domain/time-window.test.ts tests/domain/decision.test.ts tests/domain/loss-requires-strategy.test.ts tests/integration/loss-requires-flow.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/loss-requires-strategy.ts src/domain/decision.ts src/runner.ts src/cli.ts tests/domain/decision.test.ts tests/domain/loss-requires-strategy.test.ts tests/integration/loss-requires-flow.test.ts
git commit -m "feat: use tail window classifier in decisions"
```

---

## Task 3: Rich World Cup Event Index

**Files:**
- Modify: `src/polymarket/worldcup-events.ts`
- Test: `tests/polymarket/worldcup-events.test.ts`

- [ ] **Step 1: Write failing event index tests**

Create `tests/polymarket/worldcup-events.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { normalizeWorldCupEventRefs } from "../../src/polymarket/worldcup-events.js";

describe("World Cup event refs", () => {
  test("keeps tradable fifwc slug and rich ids", () => {
    const refs = normalizeWorldCupEventRefs([
      {
        slug: "fifwc-prt-uzb-2026-06-23",
        title: "Portugal vs. Uzbekistan",
        startTime: "2026-06-23T17:00:00Z",
        gameId: 90086952,
        eventMetadata: { sportradarGameId: "sr:sport_event:66457034" },
        closed: false,
        archived: false,
        active: true
      }
    ]);

    expect(refs).toEqual([
      {
        eventSlug: "fifwc-prt-uzb-2026-06-23",
        gameId: 90086952,
        sportradarGameId: "sr:sport_event:66457034",
        homeTeam: "Portugal",
        awayTeam: "Uzbekistan",
        startTime: "2026-06-23T17:00:00Z"
      }
    ]);
  });

  test("dedupes by event slug and rejects non-single-match slugs", () => {
    const refs = normalizeWorldCupEventRefs([
      { slug: "fifwc-prt-uzb-2026-06-23", title: "Portugal vs. Uzbekistan" },
      { slug: "fifwc-prt-uzb-2026-06-23", title: "Portugal vs. Uzbekistan" },
      { slug: "fifwc-more-goals-2026", title: "Most goals" }
    ]);

    expect(refs.map((ref) => ref.eventSlug)).toEqual(["fifwc-prt-uzb-2026-06-23"]);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- --run tests/polymarket/worldcup-events.test.ts
```

Expected: FAIL because `normalizeWorldCupEventRefs` is not exported.

- [ ] **Step 3: Implement rich refs**

Modify `src/polymarket/worldcup-events.ts`:

```ts
export interface WorldCupEventRef {
  eventSlug: string;
  gameId?: number;
  sportradarGameId?: string;
  homeTeam?: string;
  awayTeam?: string;
  startTime?: string;
}
```

Add:

```ts
export async function fetchOpenWorldCupEventRefs(): Promise<WorldCupEventRef[]> {
  const url = "https://gamma-api.polymarket.com/events?series_slug=soccer-fifwc&closed=false&limit=100&order=startDate&ascending=true";
  const response = await fetchJson<unknown>(url);
  return normalizeWorldCupEventRefs(normalizeGammaEvents(response));
}

export async function fetchOpenWorldCupEventSlugs(): Promise<string[]> {
  return (await fetchOpenWorldCupEventRefs()).map((event) => event.eventSlug);
}
```

Add the exported normalizer:

```ts
export function normalizeWorldCupEventRefs(records: readonly GammaEventRecord[]): WorldCupEventRef[] {
  const seen = new Set<string>();
  const refs: WorldCupEventRef[] = [];

  for (const event of records) {
    if (!isOpenSingleMatchWorldCupEvent(event)) continue;
    const eventSlug = event.slug as string;
    if (seen.has(eventSlug)) continue;
    seen.add(eventSlug);

    const ref: WorldCupEventRef = { eventSlug };
    const gameId = numberValue(event.gameId);
    if (gameId !== undefined) ref.gameId = gameId;
    const sportradarGameId = stringValue(getNested(event, ["eventMetadata", "sportradarGameId"]) ?? event.sportradarGameId);
    if (sportradarGameId) ref.sportradarGameId = sportradarGameId;
    const title = stringValue(event.title ?? event.name);
    const teams = parseTitleTeams(title);
    if (teams) {
      ref.homeTeam = teams.homeTeam;
      ref.awayTeam = teams.awayTeam;
    }
    const startTime = stringValue(event.startTime ?? event.startDate);
    if (startTime) ref.startTime = startTime;
    refs.push(ref);
  }

  return refs;
}
```

Extend `GammaEventRecord` to include:

```ts
  title?: unknown;
  name?: unknown;
  startTime?: unknown;
  startDate?: unknown;
  gameId?: unknown;
  sportradarGameId?: unknown;
  eventMetadata?: unknown;
```

Add helpers:

```ts
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function getNested(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObjectRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function parseTitleTeams(title: string | undefined): { homeTeam: string; awayTeam: string } | null {
  if (!title) return null;
  const match = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+-\s+.+)?$/i);
  if (!match?.[1] || !match[2]) return null;
  return { homeTeam: match[1].trim(), awayTeam: match[2].trim() };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run tests/polymarket/worldcup-events.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/polymarket/worldcup-events.ts tests/polymarket/worldcup-events.test.ts
git commit -m "feat: add rich world cup event refs"
```

---

## Task 4: Sports WebSocket Normalization And Audit

**Files:**
- Create: `src/polymarket/sports-live.ts`
- Test: `tests/polymarket/sports-live.test.ts`

- [ ] **Step 1: Write failing parser and matcher tests**

Create `tests/polymarket/sports-live.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  appendSportsAudit,
  matchSportsUpdateToEvent,
  normalizeSportsUpdate,
  parseElapsedSeconds
} from "../../src/polymarket/sports-live.js";
import type { WorldCupEventRef } from "../../src/polymarket/worldcup-events.js";

const refs: WorldCupEventRef[] = [
  {
    eventSlug: "fifwc-prt-uzb-2026-06-23",
    gameId: 90086952,
    sportradarGameId: "sr:sport_event:66457034",
    homeTeam: "Portugal",
    awayTeam: "Uzbekistan",
    startTime: "2026-06-23T17:00:00Z"
  }
];

describe("sports live update helpers", () => {
  test("parses elapsed formats", () => {
    expect(parseElapsedSeconds("89:30")).toBe(5370);
    expect(parseElapsedSeconds("90+3'")).toBe(5580);
    expect(parseElapsedSeconds("93:00")).toBe(5580);
    expect(parseElapsedSeconds("")).toBeUndefined();
  });

  test("matches by gameId and normalizes score", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "3-1",
      period: "2H",
      elapsed: "90+3'",
      live: true,
      ended: false
    }, refs, new Date("2026-06-23T19:00:00.000Z"));

    expect(update).toMatchObject({
      eventSlug: "fifwc-prt-uzb-2026-06-23",
      homeGoals: 3,
      awayGoals: 1,
      period: "2H",
      elapsedSeconds: 5580,
      isLive: true,
      ended: false
    });
  });

  test("matches by sportradarGameId", () => {
    expect(matchSportsUpdateToEvent({ sportradarGameId: "sr:sport_event:66457034" }, refs)?.eventSlug)
      .toBe("fifwc-prt-uzb-2026-06-23");
  });

  test("returns null for malformed scores", () => {
    expect(normalizeSportsUpdate({ gameId: 90086952, score: "bad", period: "2H", live: true }, refs)).toBeNull();
  });

  test("writes audit records as ndjson", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-sports-audit-"));
    const file = join(dir, "audit.ndjson");
    await appendSportsAudit(file, {
      receivedAt: "2026-06-23T19:00:00.000Z",
      raw: { gameId: 90086952 },
      normalized: { eventSlug: "fifwc-prt-uzb-2026-06-23" }
    });

    expect(await readFile(file, "utf8")).toContain("\"eventSlug\":\"fifwc-prt-uzb-2026-06-23\"");
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test -- --run tests/polymarket/sports-live.test.ts
```

Expected: FAIL because `src/polymarket/sports-live.ts` does not exist.

- [ ] **Step 3: Implement pure helpers and audit**

Create `src/polymarket/sports-live.ts` with:

```ts
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProxyAgent, WebSocket } from "undici";
import type { MatchPeriod, MatchState } from "../domain/types.js";
import type { WorldCupEventRef } from "./worldcup-events.js";

export interface SportsLiveUpdate extends MatchState {
  score: string;
  raw: unknown;
  receivedAt: string;
}

export interface SportsAuditRecord {
  receivedAt: string;
  raw: unknown;
  normalized: unknown;
}

export function normalizeSportsUpdate(raw: unknown, events: readonly WorldCupEventRef[], now = new Date()): SportsLiveUpdate | null {
  if (!isRecord(raw)) return null;
  const event = matchSportsUpdateToEvent(raw, events);
  if (!event) return null;
  const score = stringValue(raw.score);
  const parsedScore = parseScore(score);
  if (!score || !parsedScore) return null;
  const period = parseSportsPeriod(stringValue(raw.period));
  const elapsed = stringValue(raw.elapsed) ?? "";
  const elapsedSeconds = parseElapsedSeconds(elapsed);
  const live = typeof raw.live === "boolean" ? raw.live : raw.gameState === "live" || raw.gameState === "in-progress";
  const ended = raw.ended === true || period === "FT";

  const update: SportsLiveUpdate = {
    eventSlug: event.eventSlug,
    homeTeam: event.homeTeam ?? "UNKNOWN_HOME",
    awayTeam: event.awayTeam ?? "UNKNOWN_AWAY",
    homeGoals: parsedScore.homeGoals,
    awayGoals: parsedScore.awayGoals,
    minute: elapsedSeconds !== undefined ? Math.floor(elapsedSeconds / 60) : 0,
    period,
    isLive: live && !ended,
    ended,
    score,
    elapsed,
    raw,
    receivedAt: now.toISOString()
  };
  if (event.gameId !== undefined) update.gameId = event.gameId;
  if (event.sportradarGameId) update.sportradarGameId = event.sportradarGameId;
  if (elapsedSeconds !== undefined) update.elapsedSeconds = elapsedSeconds;
  return update;
}

export function matchSportsUpdateToEvent(raw: unknown, events: readonly WorldCupEventRef[]): WorldCupEventRef | null {
  if (!isRecord(raw)) return null;
  const slug = stringValue(raw.slug);
  if (slug) {
    const exact = events.find((event) => event.eventSlug === slug);
    if (exact) return exact;
  }
  const gameId = numberValue(raw.gameId ?? raw.game_id);
  if (gameId !== undefined) {
    const byGameId = events.find((event) => event.gameId === gameId);
    if (byGameId) return byGameId;
  }
  const sportradarGameId = stringValue(raw.sportradarGameId ?? raw.sportradar_game_id);
  if (sportradarGameId) {
    const bySportradar = events.find((event) => event.sportradarGameId === sportradarGameId);
    if (bySportradar) return bySportradar;
  }
  return null;
}

export function parseElapsedSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const clock = value.trim().match(/^(\d+):(\d{1,2})$/);
  if (clock?.[1] && clock[2]) return Number(clock[1]) * 60 + Number(clock[2]);
  const plus = value.trim().match(/^(\d+)\s*\+\s*(\d+)/);
  if (plus?.[1] && plus[2]) return (Number(plus[1]) + Number(plus[2])) * 60;
  const minute = value.trim().match(/^(\d+)'?$/);
  return minute?.[1] ? Number(minute[1]) * 60 : undefined;
}

export async function appendSportsAudit(file: string, record: SportsAuditRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
```

Then add the simple helpers in the same file:

```ts
function parseScore(score: string | undefined): { homeGoals: number; awayGoals: number } | null {
  const match = score?.match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
  if (!match?.[1] || !match[2]) return null;
  return { homeGoals: Number(match[1]), awayGoals: Number(match[2]) };
}

function parseSportsPeriod(period: string | undefined): MatchPeriod {
  const normalized = period?.trim().toUpperCase();
  if (normalized === "NS" || normalized === "1H" || normalized === "HT" || normalized === "2H" || normalized === "ET" || normalized === "FT") return normalized;
  return "UNKNOWN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}
```

- [ ] **Step 4: Add WebSocket provider wrapper**

Add to `src/polymarket/sports-live.ts`:

```ts
export interface SportsLiveProviderOptions {
  events: readonly WorldCupEventRef[];
  url?: string;
  auditFile?: string;
  proxyUrl?: string;
}

export type SportsUpdateHandler = (update: SportsLiveUpdate) => Promise<void> | void;

export class SportsLiveProvider {
  constructor(private readonly options: SportsLiveProviderOptions) {}

  connect(onUpdate: SportsUpdateHandler): WebSocket {
    const url = this.options.url ?? "wss://sports-api.polymarket.com/ws";
    const dispatcher = this.options.proxyUrl ? new ProxyAgent(this.options.proxyUrl) : undefined;
    const socket = new WebSocket(url, undefined, dispatcher ? { dispatcher } : undefined);

    socket.addEventListener("message", (event) => {
      if (event.data === "ping") {
        socket.send("pong");
        return;
      }
      void this.handleMessage(event.data, onUpdate);
    });

    return socket;
  }

  private async handleMessage(data: unknown, onUpdate: SportsUpdateHandler): Promise<void> {
    const raw = parseJsonMessage(data);
    if (raw === null) return;
    const normalized = normalizeSportsUpdate(raw, this.options.events);
    if (this.options.auditFile) {
      await appendSportsAudit(this.options.auditFile, {
        receivedAt: new Date().toISOString(),
        raw,
        normalized
      });
    }
    if (normalized) await onUpdate(normalized);
  }
}

function parseJsonMessage(data: unknown): unknown | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- --run tests/polymarket/sports-live.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/polymarket/sports-live.ts tests/polymarket/sports-live.test.ts
git commit -m "feat: normalize sports live updates"
```

---

## Task 5: Sports WebSocket Watch Path In CLI

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write failing CLI watch test with injected live updates**

Add to `tests/cli.test.ts`:

```ts
test("worldcup watch can use sports live updates instead of polling pages", async () => {
  async function* updates(): AsyncIterable<MatchState> {
    yield {
      eventSlug: "fifwc-esp-ksa-2026-06-21",
      homeTeam: "Spain",
      awayTeam: "Saudi Arabia",
      homeGoals: 4,
      awayGoals: 0,
      minute: 90,
      period: "2H",
      isLive: true,
      elapsedSeconds: 90 * 60
    };
  }

  const result = await runCli([
    "--mode", "paper",
    "--watch", "true",
    "--worldcup", "true",
    "--markets-file", "tests/fixtures/markets/spain-spreads.json",
    "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
    "--stake", "97",
    "--interval-ms", "0",
    "--max-iterations", "1"
  ], {}, {
    watchSportsUpdates: async () => updates()
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    mode: "paper",
    status: "filled",
    action: "BUY",
    decision: {
      tailWindowSource: "conservative_90_plus"
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- --run tests/cli.test.ts -t "worldcup watch can use sports live updates"
```

Expected: FAIL because `watchSportsUpdates` is not a CLI dependency.

- [ ] **Step 3: Add CLI dependency and sports watch function**

Modify `src/cli.ts` imports:

```ts
import { SportsLiveProvider } from "./polymarket/sports-live.js";
import { fetchOpenWorldCupEventRefs, type WorldCupEventRef } from "./polymarket/worldcup-events.js";
```

Extend `CliDependencies`:

```ts
  fetchWorldCupEventRefs?: () => Promise<WorldCupEventRef[]>;
  watchSportsUpdates?: (events: readonly WorldCupEventRef[], options: { auditFile?: string; proxyUrl?: string }) => Promise<AsyncIterable<MatchState>>;
```

Add to `ParsedArgs`:

```ts
  liveAuditFile?: string;
```

Parse:

```ts
  if (raw.liveAuditFile) parsed.liveAuditFile = raw.liveAuditFile;
```

Add helper:

```ts
function resolveLiveAuditFile(args: ParsedArgs, env: Record<string, string | undefined>): string | undefined {
  return args.liveAuditFile ?? env.POLY_LIVE_AUDIT_FILE;
}
```

- [ ] **Step 4: Route `--watch --worldcup true` to sports updates**

At the start of `runWatch`, add:

```ts
  if (args.worldcup) {
    return await runSportsWatch(args, env, deps);
  }
```

Add:

```ts
async function runSportsWatch(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  deps: CliDependencies
): Promise<CliResult> {
  const refs = await (deps.fetchWorldCupEventRefs ?? fetchOpenWorldCupEventRefs)();
  const updates = deps.watchSportsUpdates
    ? await deps.watchSportsUpdates(refs, { auditFile: resolveLiveAuditFile(args, env), proxyUrl: proxyFromEnv(env) })
    : await defaultSportsUpdates(refs, { auditFile: resolveLiveAuditFile(args, env), proxyUrl: proxyFromEnv(env) });

  let last: Record<string, unknown> | undefined;
  let iteration = 0;
  const maxIterations = args.maxIterations ?? Number.POSITIVE_INFINITY;

  for await (const match of updates) {
    iteration += 1;
    const result = await runSinglePass({ ...args, eventSlug: match.eventSlug }, env, {
      ...deps,
      fetchMatchState: async () => match
    });
    if (result.exitCode !== 0) return result;
    last = JSON.parse(result.stdout) as Record<string, unknown>;
    if (last.status !== "no_trade") return result;
    if (iteration >= maxIterations) break;
  }

  return ok({
    mode: args.mode,
    status: "watch_complete",
    iterations: Number.isFinite(maxIterations) ? maxIterations : undefined,
    last
  });
}
```

Add:

```ts
async function defaultSportsUpdates(
  refs: readonly WorldCupEventRef[],
  options: { auditFile?: string; proxyUrl?: string }
): Promise<AsyncIterable<MatchState>> {
  const queue: MatchState[] = [];
  let notify: (() => void) | undefined;
  const provider = new SportsLiveProvider({ events: refs, auditFile: options.auditFile, proxyUrl: options.proxyUrl });
  provider.connect((update) => {
    queue.push(update);
    notify?.();
  });

  async function* iterate(): AsyncIterable<MatchState> {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const next = queue.shift();
      if (next) yield next;
    }
  }

  return iterate();
}
```

Add:

```ts
function proxyFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.https_proxy ?? env.http_proxy;
}
```

- [ ] **Step 5: Update summary output**

In `summary`, include:

```ts
    tailWindowSource: decision.tailWindowSource,
    tailWindowDetails: decision.tailWindowDetails,
```

- [ ] **Step 6: Run CLI tests**

Run:

```bash
npm test -- --run tests/cli.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: use sports websocket updates in watch mode"
```

---

## Task 6: Confirm Live Order Results From CLOB State

**Files:**
- Modify: `src/execution/live-executor.ts`
- Test: `tests/execution/live-executor.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Add to `tests/execution/live-executor.test.ts`:

```ts
test("normalizes confirmed partial fills from trades", () => {
  const result = normalizeConfirmedLiveOrderResult(liveOrder, {
    postResponse: { success: true, orderID: "order-1", status: "matched" },
    trades: [
      { id: "trade-1", taker_order_id: "order-1", asset_id: liveOrder.tokenId, side: "BUY", size: "0.5", price: "0.97", fee_rate_bps: "0", status: "CONFIRMED" }
    ],
    openOrders: []
  });

  expect(result).toMatchObject({
    mode: "live",
    status: "partial",
    orderId: "order-1",
    shares: 0.5,
    notional: 0.485,
    price: 0.97
  });
});

test("does not fabricate FOK fills when no trade or open order confirms execution", () => {
  const result = normalizeConfirmedLiveOrderResult(liveOrder, {
    postResponse: { success: true, orderID: "order-1", status: "matched" },
    trades: [],
    openOrders: []
  });

  expect(result).toMatchObject({
    mode: "live",
    status: "rejected",
    orderId: "order-1",
    shares: 0,
    notional: 0
  });
});

test("marks posted when an open order remains", () => {
  const result = normalizeConfirmedLiveOrderResult(liveOrder, {
    postResponse: { success: true, orderID: "order-1", status: "unmatched" },
    trades: [],
    openOrders: [
      { id: "order-1", status: "LIVE", asset_id: liveOrder.tokenId, side: "BUY", original_size: "1", size_matched: "0", price: "0.97", associate_trades: [] }
    ]
  });

  expect(result).toMatchObject({
    mode: "live",
    status: "posted",
    orderId: "order-1"
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test -- --run tests/execution/live-executor.test.ts
```

Expected: FAIL because `normalizeConfirmedLiveOrderResult` does not exist and status `"partial"` is not supported before Task 1.

- [ ] **Step 3: Extend live client interface**

Modify `src/execution/live-executor.ts`:

```ts
export interface LiveClobClient {
  placeLimitBuy(order: LiveOrderRequest): Promise<TradeResult>;
}

interface LiveClobConfirmationClient {
  placeMarketBuyRaw(order: LiveOrderRequest): Promise<unknown>;
  getOrder(orderId: string): Promise<unknown>;
  getTrades(params: { asset_id?: string; market?: string }): Promise<unknown[]>;
  getOpenOrders(params: { asset_id?: string; market?: string }): Promise<unknown[]>;
  cancelOrder?(payload: { orderID: string }): Promise<unknown>;
}
```

Keep the public `LiveClobClient` interface stable for tests that inject `placeLimitBuy`.

- [ ] **Step 4: Implement confirmed result normalizer**

Add:

```ts
interface LiveOrderConfirmation {
  postResponse: unknown;
  order?: unknown;
  trades: unknown[];
  openOrders: unknown[];
  cancelResponse?: unknown;
}

export function normalizeConfirmedLiveOrderResult(order: LiveOrderRequest, confirmation: LiveOrderConfirmation): TradeResult {
  assertNoPostError(confirmation.postResponse);
  const orderId = orderIdFrom(confirmation.postResponse) ?? orderIdFrom(confirmation.order) ?? "live-order-unknown";
  const fills = confirmation.trades
    .map((trade) => tradeFillFrom(orderId, order.tokenId, trade))
    .filter((fill): fill is { shares: number; notional: number } => fill !== null);
  const filledShares = fills.reduce((total, fill) => total + fill.shares, 0);
  const filledNotional = fills.reduce((total, fill) => total + fill.notional, 0);
  const hasOpenOrder = confirmation.openOrders.some((openOrder) => openOrderMatches(orderId, order.tokenId, openOrder));

  if (filledShares > 0) {
    const status = filledShares + 1e-9 >= order.size && !hasOpenOrder ? "filled" : "partial";
    return {
      mode: "live",
      status,
      orderId,
      tokenId: order.tokenId,
      price: filledNotional / filledShares,
      shares: filledShares,
      notional: filledNotional,
      fee: filledShares * sportsTakerFeePerShare(filledNotional / filledShares),
      estimatedPayout: filledShares,
      estimatedProfit: filledShares - filledNotional - filledShares * sportsTakerFeePerShare(filledNotional / filledShares),
      raw: confirmation
    };
  }

  if (hasOpenOrder) {
    return emptyLiveResult(order, orderId, confirmation.cancelResponse ? "canceled" : "posted", confirmation);
  }

  return emptyLiveResult(order, orderId, "rejected", confirmation);
}
```

Also import the fee function:

```ts
import { sportsTakerFeePerShare } from "../domain/fees.js";
```

Add helper functions:

```ts
function emptyLiveResult(order: LiveOrderRequest, orderId: string, status: TradeResult["status"], raw: unknown): TradeResult {
  return {
    mode: "live",
    status,
    orderId,
    tokenId: order.tokenId,
    price: order.price,
    shares: 0,
    notional: 0,
    fee: 0,
    estimatedPayout: 0,
    estimatedProfit: 0,
    raw
  };
}

function assertNoPostError(raw: unknown): void {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const errorMessage = nonEmptyString(record.errorMsg) ?? nonEmptyString(record.error);
    if (record.success === false || errorMessage) {
      throw new LiveExecutionError("LIVE_ORDER_REJECTED", errorMessage ?? "Polymarket rejected live order", { raw });
    }
  }
}

function orderIdFrom(raw: unknown): string | undefined {
  return stringField(raw, "orderID") ?? stringField(raw, "orderId") ?? stringField(raw, "id");
}
```

Add `tradeFillFrom` and `openOrderMatches`:

```ts
function tradeFillFrom(orderId: string, tokenId: string, raw: unknown): { shares: number; notional: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const tradeOrderId = stringField(record, "taker_order_id") ?? stringField(record, "order_id");
  const assetId = stringField(record, "asset_id") ?? stringField(record, "assetId");
  if (tradeOrderId !== orderId || assetId !== tokenId) return null;
  const size = numberField(record, "size");
  const price = numberField(record, "price");
  if (size === undefined || price === undefined || size <= 0 || price <= 0) return null;
  return { shares: size, notional: size * price };
}

function openOrderMatches(orderId: string, tokenId: string, raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const record = raw as Record<string, unknown>;
  const id = stringField(record, "id") ?? stringField(record, "orderID") ?? stringField(record, "orderId");
  const assetId = stringField(record, "asset_id") ?? stringField(record, "assetId");
  return id === orderId && assetId === tokenId;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const raw = record[key];
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}
```

- [ ] **Step 5: Wire default live client confirmation**

Inside `defaultLiveClientFactory`, replace direct `normalizeLiveOrderResult(order, raw)` return with confirmation:

```ts
const postResponse = config.signatureType === 3
  ? await createAndPostPoly1271MarketOrder(client as unknown as Poly1271PostingClient, config, userMarketOrder, createOptions, orderType)
  : await client.createAndPostMarketOrder(userMarketOrder as never, createOptions, orderType as never);

const orderId = orderIdFrom(postResponse);
const orderState = orderId ? await safeCall(() => client.getOrder(orderId)) : undefined;
const trades = await safeArray(() => client.getTrades({ asset_id: order.tokenId }));
const openOrders = await safeArray(() => client.getOpenOrders({ asset_id: order.tokenId }));
let cancelResponse: unknown;
if (orderId && openOrders.some((openOrder) => openOrderMatches(orderId, order.tokenId, openOrder))) {
  cancelResponse = await safeCall(() => client.cancelOrder({ orderID: orderId }));
}

return normalizeConfirmedLiveOrderResult(order, {
  postResponse,
  order: orderState,
  trades,
  openOrders,
  cancelResponse
});
```

Add safe helpers:

```ts
async function safeCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function safeArray(fn: () => Promise<unknown[]>): Promise<unknown[]> {
  try {
    const value = await fn();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 6: Run live executor tests**

Run:

```bash
npm test -- --run tests/execution/live-executor.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/execution/live-executor.ts tests/execution/live-executor.test.ts
git commit -m "fix: confirm live order fills"
```

---

## Task 7: Event-Level Ledger Duplicate Protection

**Files:**
- Modify: `src/persistence/ledger.ts`
- Modify: `src/cli.ts`
- Test: `tests/persistence/ledger.test.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write failing ledger tests**

Add to `tests/persistence/ledger.test.ts`:

```ts
test("event-level active trade blocks another token in the same event", async () => {
  const ledger = new LiveLedger(file);
  await ledger.recordTrade({
    timestamp: "2026-06-23T10:00:00.000Z",
    mode: "live",
    status: "filled",
    eventSlug: "event-1",
    marketSlug: "market-a",
    tokenId: "token-a",
    conditionId: "condition-a",
    outcome: "Yes",
    orderId: "order-a",
    price: 0.97,
    shares: 1,
    notional: 0.97
  });

  await expect(ledger.hasActiveEventTrade("event-1")).resolves.toBe(true);
});

test("rejected and canceled entries do not block the event", async () => {
  const ledger = new LiveLedger(file);
  await ledger.recordTrade({
    timestamp: "2026-06-23T10:00:00.000Z",
    mode: "live",
    status: "rejected",
    eventSlug: "event-1",
    marketSlug: "market-a",
    tokenId: "token-a",
    conditionId: "condition-a",
    outcome: "Yes",
    orderId: "order-a",
    price: 0.97,
    shares: 0,
    notional: 0
  });

  await expect(ledger.hasActiveEventTrade("event-1")).resolves.toBe(false);
});
```

Use the existing `file` setup pattern in `tests/persistence/ledger.test.ts`.

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- --run tests/persistence/ledger.test.ts
```

Expected: FAIL because `hasActiveEventTrade` does not exist and status `"canceled"` may not be accepted before Task 1.

- [ ] **Step 3: Update ledger types and active helper**

Modify `src/persistence/ledger.ts`:

```ts
export type LedgerStatus = "filled" | "partial" | "posted" | "rejected" | "canceled";
```

Update `LedgerTradeEntry.status`:

```ts
  status: LedgerStatus;
```

Add:

```ts
  async hasActiveEventTrade(eventSlug: string): Promise<boolean> {
    const entries = await this.readEntries();
    return entries.some((entry) => entry.eventSlug === eventSlug && isActiveLedgerStatus(entry.status));
  }
```

Update existing helper:

```ts
  async hasActiveTrade(eventSlug: string, tokenId: string): Promise<boolean> {
    const entries = await this.readEntries();
    return entries.some((entry) =>
      entry.eventSlug === eventSlug
      && entry.tokenId === tokenId
      && isActiveLedgerStatus(entry.status)
    );
  }
```

Add:

```ts
function isActiveLedgerStatus(status: LedgerStatus): boolean {
  return status === "filled" || status === "partial" || status === "posted";
}
```

Update `isLedgerTradeEntry`:

```ts
    && (record.status === "filled" || record.status === "partial" || record.status === "posted" || record.status === "rejected" || record.status === "canceled");
```

- [ ] **Step 4: Update CLI duplicate check**

Modify `src/cli.ts`:

```ts
    if (ledger && await ledger.hasActiveEventTrade(decision.eventSlug)) {
      return ok(summary(args.mode, {
        action: "NO_TRADE",
        reason: "DUPLICATE_TRADE",
        eventSlug: decision.eventSlug,
        details: "Ledger already has an active trade for this event"
      }));
    }
```

- [ ] **Step 5: Add CLI duplicate regression**

Add to `tests/cli.test.ts`:

```ts
test("live ledger blocks a second token in the same event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "poly-cli-event-ledger-"));
  const ledgerFile = join(dir, "ledger.json");
  await writeFile(ledgerFile, JSON.stringify([
    {
      timestamp: "2026-06-23T10:00:00.000Z",
      mode: "live",
      status: "filled",
      eventSlug: "fifwc-esp-ksa-2026-06-21",
      marketSlug: "other-market",
      tokenId: "other-token",
      conditionId: "other-condition",
      outcome: "No",
      orderId: "order-1",
      price: 0.99,
      shares: 1,
      notional: 0.99
    }
  ]));

  const result = await runCli([
    "--mode", "paper",
    "--match-file", "tests/fixtures/matches/spain-4-0.json",
    "--markets-file", "tests/fixtures/markets/spain-spreads.json",
    "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
    "--stake", "97",
    "--ledger-file", ledgerFile
  ]);

  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "no_trade",
    reason: "DUPLICATE_TRADE"
  });
});
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- --run tests/persistence/ledger.test.ts tests/cli.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/persistence/ledger.ts src/cli.ts tests/persistence/ledger.test.ts tests/cli.test.ts
git commit -m "fix: block duplicate event entries"
```

---

## Task 8: Configuration Docs And Env Template

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Document new environment variables**

Add to `.env.example`:

```bash
# Optional: write raw Sports WebSocket updates and normalized decisions as NDJSON.
POLY_LIVE_AUDIT_FILE=data/live-sports-audit.ndjson

# conservative90 enters only at 90:00+ when true remaining time is unavailable.
# remaining requires remainingSeconds/remainingMinutes from the data source.
POLY_TAIL_TIME_MODE=conservative90
```

- [ ] **Step 2: Update README live section**

Add a short section to `README.md` near live/watch instructions:

```md
### Live sports timing

`--watch --worldcup true` uses Polymarket Sports WebSocket updates as the primary live score source. The bot maps updates by `slug`, `gameId`, and `sportradarGameId`.

Set `POLY_TAIL_TIME_MODE=conservative90` to use the default conservative timing rule: if the feed does not expose true remaining time, the bot only enters after `period=2H` and `elapsed >= 90:00`. Set `POLY_LIVE_AUDIT_FILE=data/live-sports-audit.ndjson` to write raw updates for replay and debugging.
```

- [ ] **Step 3: Run doc diff check**

Run:

```bash
git diff --check -- .env.example README.md
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document live sports timing config"
```

---

## Task 9: Full Verification And Acceptance Prep

**Files:**
- No source files should be modified in this task unless a verification command exposes a defect.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: all test files pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Check secret hygiene**

Run:

```bash
rg -n "PRIVATE_KEY|POLY_PRIVATE|POLY_API|gho_|sk-|BEGIN .*PRIVATE|0x[a-fA-F0-9]{64}" . --glob '!node_modules/**' --glob '!package-lock.json' --glob '!.env.local'
```

Expected: only placeholders, tests, docs examples, and known public addresses appear; no real private key or live API secret appears.

- [ ] **Step 5: Summarize live acceptance commands**

Prepare this command list for the user:

```bash
npm run live:status
HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808 POLY_LIVE_AUDIT_FILE=data/live-sports-audit.ndjson npm run live:watch:worldcup
```

Expected: `live:status` reports pUSD balance; watch mode waits for Sports WebSocket updates and only evaluates trades in the tail window.

- [ ] **Step 6: Confirm working tree contains only intended changes**

Run:

```bash
git status --short
```

Expected: no unexpected files. If Task 9 only ran verification commands, there is no Task 9 commit.

---

## Self-Review Checklist

- Spec coverage: Tasks 1-2 cover tail-window correctness, Tasks 3-5 cover Sports WebSocket event matching and watch flow, Task 6 covers confirmed live fills, Task 7 covers event-level duplicate protection, Task 8 covers config docs, Task 9 covers verification and live acceptance prep.
- Scope check: blended multi-level orderbook sweeping is intentionally excluded from this plan because the user prioritized it last.
- Type consistency: `TailWindowMode`, `TailWindowSource`, `WorldCupEventRef`, and extended `TradeResult.status` are introduced before downstream tasks use them.
- Test strategy: each functional task starts with failing Vitest coverage, then implementation, then targeted verification, then commit.
