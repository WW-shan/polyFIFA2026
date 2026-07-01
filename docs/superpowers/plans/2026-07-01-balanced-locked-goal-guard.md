# Balanced Locked Goal Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship balanced fast locked-goal buying: 365 event/PBP guard, orderbook delta guard, no old unconfirmed return tiers, and verified live-route tests.

**Architecture:** Add a 365 locked-goal signal parser to the existing `Scores365ClockProvider`, keep pre-goal orderbook snapshots in the watch loop, and pass a guard context into locked risk assessment. The guard returns the existing `capFraction` plus an optional absolute stable post-goal liquidity `stakeLimit` so downstream sizing remains centralized.

**Tech Stack:** TypeScript, Vitest, existing CLI/watch loop, Polymarket CLOB orderbooks, 365Scores public web/game/PBP endpoints.

---

### Task 1: 365 Signal Parser

**Files:**
- Modify: `src/polymarket/scores365-clock.ts`
- Test: `tests/polymarket/scores365-clock.test.ts`

- [ ] Add failing tests for normal goal, Goal Disallowed Var event, and PBP `VAR Decision: No Goal`.
- [ ] Implement exported `extract365ScoresGoalSignal` and provider `fetchGoalSignal`.
- [ ] Run `npx vitest run tests/polymarket/scores365-clock.test.ts`.

### Task 2: Guard Contract And Old Tier Removal

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] Add failing tests showing high-return unconfirmed locked opportunities are skipped by default.
- [ ] Add failing tests showing 365 no-goal hard blocks a locked buy.
- [ ] Remove high/medium unconfirmed cap constants and branches.
- [ ] Add `fetchLockedGoalSignal` dependency for tests and live provider wiring.

### Task 3: Orderbook Delta Guard

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] Add failing tests for stable post-goal liquidity pass, growth capped to S1/S2 liquidity, and best-ask retrace block.
- [ ] Cache one-goal-ahead locked token orderbooks as S0.
- [ ] Fetch S1/S2 concurrently enough for the guard and derive tradable notional from stable post-goal liquidity `min(S1, S2)`.
- [ ] Return a guard stake limit to the existing sizing path.

### Task 4: Full Verification And Deploy

**Files:**
- Modify only if tests reveal regressions.

- [ ] Run targeted parser/CLI tests.
- [ ] Run stress tests for locked refill and two-match live chains.
- [ ] Run project typecheck/test command from package scripts.
- [ ] Review `git diff`.
- [ ] Restart `poly-live` watcher after verification.
