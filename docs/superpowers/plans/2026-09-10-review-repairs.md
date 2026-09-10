# Code Review Repairs Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and superpowers:dispatching-parallel-agents for independent file scopes. The user authorized all fixes and local integration; execute without additional approval checkpoints. Write failing behavioral regressions before implementation, then perform independent spec and code review.

**Goal:** Resolve every finding T1–T6, C1–C15, O1–O7 in the 7295f2b review, with repository regressions and reproducible verification.

**Architecture:** Keep existing trading and collector entry points. Make execution/ledger outcomes conservative and durable; require event-specific goal evidence and market ownership; use cancellable bounded stream lifecycles and sequential incremental replay/export. Original NDJSON frames remain unchanged.

**Tech Stack:** TypeScript, Node, undici, Vitest; public-only finite collector smoke.

## 1. Execution and durable ledger (T1–T3, O1–O3)

Files: src/execution/live-executor.ts, src/execution/settlement.ts, src/persistence/ledger.ts, src/domain/types.ts if needed, corresponding tests/execution and tests/persistence; dedicated integration test for mixed baskets.

- [x] Reproduce mixed basket success/throw, concurrent record/settlement, canceled positive match size, explicit failed trades with stale MATCHED order, two-condition partial redemption, and STATE_NEW/STATE_FAILED submission.
- [x] Preserve successful legs and represent uncertain submission as active pending, never zero-evidence rejection; prevent duplicate retry through ledger results.
- [x] Serialize per-file read-modify-write and use exclusive temporary writes plus atomic rename; correctly track and settle individual basket conditions, preserving older data conservatively.
- [x] Preserve matched canceled orders; let explicit failed/pending trade evidence prevent order fallback.
- [x] Mark redeemed only on confirmed terminal success or verified on-chain reconciliation; retain pending/failed conditions.
- [x] Run `npx vitest run tests/execution tests/persistence tests/integration/execution-recovery.test.ts`.

Required assertions include:

```ts
expect(await ledger.hasActiveEventTrade(eventSlug)).toBe(true);
expect(entriesAfterConcurrentUpdates).toEqual(expect.arrayContaining([newTrade]));
expect(activeNotionalAfterOneCondition).toBeCloseTo(9.7);
expect(markRedeemed).not.toHaveBeenCalled(); // pending/failed submission
```

## 2. Locked-goal lifecycle (T4–T5)

Files: src/cli.ts; tests/cli.test.ts or new tests/stress/locked-recovery.test.ts.

- [x] Encode 2–0 → 1–0 → 1–0 rollback and fast score/late No Goal fixtures with injected feeds and paper execution.
- [x] Preserve blocking/revalidation state after rollback; every locked decision retains incident protection and budget.
- [x] Collect authoritative contradictory evidence within the existing deadline and recheck evidence before execution; immediate hard blocks may resolve promptly. Do not let score-only confirmation permanently suppress detailed negative evidence.
- [x] Test recovery after a subsequent confirmed score, provider rejection/timeout, and delayed hard blocks before submission.
- [x] Run `npx vitest run tests/cli.test.ts tests/stress`.

```ts
expect(executedAfterRollback).toHaveLength(0);
expect(executedWithNoGoalBeforeSubmission).toHaveLength(0);
```

## 3. Event parsing and HTTP lifecycle (T6, O4–O7)

Files: src/polymarket/event-page.ts, src/polymarket/scores365-clock.ts, src/polymarket/http.ts; tests/polymarket.

- [x] Reproduce parent-owned foreign markets, Flight-only match HTML, extra-time clock, historical canceled goals and stalled response bodies.
- [x] Carry explicit parent event ownership through traversal and reject conflicting child ownership; preserve direct single-event Gamma responses.
- [x] Share existing Flight decoding with match-state lookup.
- [x] Validate regulation phase before clock math; scope event cancellation/review evidence to the current incident while conservatively handling ambiguous current signals.
- [x] Add optional AbortSignal to HttpOptions. Timeout and cancellation cover both headers and body consumption; preserve proxy behavior and clear timers/listeners on all outcomes.
- [x] Run `npx vitest run tests/polymarket`.

```ts
expect(findStrategyMarkets(multiEventPage, requestedSlug)).not.toContainEqual(expect.objectContaining({conditionId: foreignCondition}));
expect(extract365ScoresClock(extraTime, laggingSecondHalf)).toBeNull();
await expect(fetchJson(stalledBodyUrl, {timeoutMs: 30})).rejects.toThrow();
```

## 4. Journal and sockets (C9–C11)

Files: src/collector/journal.ts, src/collector/streams.ts; their tests.

- [x] Test no incoming heartbeat, ignored close handshake, connecting-socket timeout, date revisit, write errors, and pending-byte accounting.
- [x] Add heartbeat/connection timeouts and bounded reconnect; default transport must support forced teardown after a bounded close handshake. Record invalidation before disposing a connection.
- [x] Guarantee idempotent stop leaves no sockets/timers/listeners; all recording failures stop input and surface to runtime.
- [x] Allocate unique monotonic segment indices even when wall date goes backwards. listJournalSegments must expose journal sequence order, including existing date-local-index archives.
- [x] Run `npx vitest run tests/collector/journal.test.ts tests/collector/streams.test.ts`, including a local ignored-close peer.

```ts
expect(reconnectedEpoch).not.toBe(previousEpoch);
expect(recordsAfterDateRollback.map(r => r.sequence)).toEqual([1, 2, 3]);
expect(resourcesAfterStop).toEqual([]);
```

## 5. Runtime and collector CLI (C12–C15)

Files: src/collector/collector.ts, src/collector/cli.ts, src/collector/types.ts, src/collector/catalog.ts only if needed; tests/collector for those modules.

- [x] Reproduce fatal exit 0, failed flush with unresolved run, cancellation during journal/discovery/snapshot startup, and failed/still-open reconciliation.
- [x] Use one lifecycle promise and cancellation controller; run rejects on fatal errors, stop is idempotent, failed cleanup settles run, and canceled initialization cannot install new resources.
- [x] Pass journal onError into runtime; persist effective config/status and serializable failures; use HTTP AbortSignal (from task 3), allow optional signal in JsonRequestOptions.
- [x] Keep pending/still-open disappeared events and retry until terminal status is actually observed. Discovery failure preserves prior subscriptions.
- [x] Bound HTTP snapshot concurrency; apply timeout/proxy consistently. Keep periodic scans non-overlapping.
- [x] Run `npx vitest run tests/collector/collector.test.ts tests/collector/cli.test.ts tests/collector/catalog.test.ts`.

```ts
await expect(runtime.run()).rejects.toThrow('JOURNAL');
expect(timersAfterCanceledStartup).toHaveLength(0);
expect(runtime.tokenIds).toContain(previouslySubscribedToken);
```

## 6. Replay and streaming export (C1–C8)

Files: src/collector/replay.ts, src/collector/export.ts, optional bounded streaming reader/replay helper files; corresponding tests.

- [x] Turn all replay-audit examples into failing repository regressions: unrelated sports, slug aliases, ping, equivalent price strings, partial book, malformed frame, source-time regression, unsubscribe/resubscribe, run mismatch and unterminated tail.
- [x] Use canonical decimal price keys while preserving received values; validate full books and changes before applying atomically.
- [x] Require same active connection/subscription plus current full snapshot. Invalidate on gaps, corrupt/unknown mutating frames, timestamp regression, and subscription changes; only new snapshots restore depth.
- [x] Correlate sports only by canonical event/game identifiers; carry observed score/clock, missing/stale/connection status and monotonic receipt age without future-data lookahead.
- [x] Stream complete journal lines, strictly validate envelopes/runId/order, ignore incomplete tails with quality diagnostics. Support old archives and task-4 date rollback ordering.
- [x] Implement incremental replay callbacks/rows and backpressured CSV writing; keep only current books/metadata/latest sports, not all history. Preserve readJournalRecords/replayRecords convenience APIs for small tests.
- [x] Use exclusive output creation by default and preserve explicit overwrite compatibility; stage outputs and publish only after replay succeeds so a failed overwrite keeps the previous export.
- [x] Run `npx vitest run tests/collector/replay.test.ts tests/collector/export.test.ts`; verify deterministic CSV plus a bounded-memory long-input subprocess.

```ts
expect(unmatchedQuote.sportsSequence).toBeUndefined();
expect(zeroUpdateForEquivalentPrice.asks).toEqual([]);
expect(quotesAfterBadFrame).toEqual([initialQuote]);
expect(streamedAndInMemoryOutputs).toEqual(eachOther);
```

## 7. Integration and verification

- [x] Independently review each task against the finding IDs, then code quality; resolve findings and rerun affected checks.
- [x] Review mixed-basket CLI retry, concurrent settlement, guard evidence and collector shutdown across module boundaries.
- [x] Run `npm test`, `npm run typecheck`, `git diff --check`.
- [x] Run a finite public collector on a small explicit scope, export twice into distinct outputs and verify row counts, deterministic data, quality, canceled close and no surviving process.
- [x] Update docs/sports-collector.md, README and a durable finding-to-regression verification matrix; correct previous unsupported completion claims.
- [ ] Commit intentionally and fast-forward local main after final checks. No remote push or long-running deployment.
