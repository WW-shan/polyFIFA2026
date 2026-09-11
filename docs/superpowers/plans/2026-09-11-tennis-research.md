# Tennis-first research implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect tennis without the metadata-date blind spot and deliver a reproducible initial resting-BUY price/window screen on real public data.

**Architecture:** Keep research independent from all live-execution modules. Reuse public HTTP transport and raw journals; normalize historical evidence into a versioned dataset, apply pure simulation functions, then export inspectable JSON/CSV and a short evidence report.

**Tech Stack:** TypeScript/Node, existing fetchJson and collector, Vitest, public Gamma/Data/CLOB APIs.

---

### Task 1: Tennis-safe discovery (parallel, disjoint collector files)

**Files:** `src/collector/catalog.ts`, `src/collector/collector.ts`, `src/collector/cli.ts`, corresponding `tests/collector/{catalog,collector,cli}.test.ts`.

- [x] Add a regression with `startTime: "2026-09-11T10:00:00Z"`, `endDate: "2026-09-18T10:00:00Z"`, `now: 2026-09-11T12:00Z`; `dateWindow: "game-start"` must retain the match and omit server end-date filters.
- [x] Run `npm test -- tests/collector/catalog.test.ts`; observe the missing-mode failure.
- [x] Implement the mode, CLI validation and option propagation. Test market gameStartTime fallback, unknown start retention, live retention, no event-creation-date substitution, allOpen override and unchanged pagination.
- [x] Run the three collector suites and inspect the diff. Preserve all existing raw-market retention rules.

### Task 2: Versioned historical evidence and bounded cache

**Files:** create `src/research/types.ts`, `src/research/history.ts`, `src/research/download.ts`, `tests/research/history.test.ts`, `tests/research/download.test.ts`.

- [x] Define `ResearchDataset`/`ResearchMarket`/`ResearchTrade` with explicit time, resolution and coverage provenance. Tests exercise outcome mappings as string IDs and missing finish without fallback.
- [x] Test that open `["1","0"]` is unresolved, resolved `["0.5","0.5"]` pays 0.5, malformed mappings are rejected, and a duplicated page cannot inflate volume.
- [x] Run `npm test -- tests/research/history.test.ts tests/research/download.test.ts`; observe intended missing implementation failures.
- [x] Implement typed normalization plus bounded public-trade pagination. Cache every request/reply, raw metadata, per-market status and dataset.json; fail safely on an existing output directory. Default `takerOnly=true`; do not silently turn off pagination limits.
- [x] Test short-page exhaustion, page caps, network failures, invalid/mismatched trades and nonmonotonic pages. Run both suites to green. The API offset cap remains an additional explicit guard.

### Task 3: Pure resting-order price/window research

**Files:** create `src/research/backtest.ts`, `src/research/backtest-types.ts`, `src/research/report.ts`, `tests/research/backtest.test.ts`, `tests/research/report.test.ts`.

- [x] Write fixtures with an entry price of .95, later SELL .69 size 3, BUY .65 size 10 and a final payout of 0. For a .70 bid and size 5 the below-only model fills 3, costs 2.10 and loses 2.10; BUY volume must not fill it.
- [x] Test that swapping final payout never changes the selected side or entry time; equality consumes configured queue first; no trade gives unfilled only with usable coverage; stale entry and incomplete history are excluded explicitly.
- [x] Run `npm test -- tests/research/backtest.test.ts`; observe failures, then implement parameter validation and pure trials/aggregation.
- [x] Add retrospective finish-relative windows and price-trigger entries with bounded lifetime and no finish-label input to the entry decision. Each parameter is a separate scenario; do not add overlapping windows or mutually exclusive price scenarios as portfolio profit.
- [x] Export per-trial and per-parameter summaries, with limit-price cost, filled/unfilled/incomplete counts and basis labels. Verify quoting, no-overwrite and finite outputs.

### Task 4: Reproducible CLI and real evidence

**Files:** create `src/research/cli.ts`, `tests/research/cli.test.ts`, update `package.json`, `README.md`, add `docs/tennis-research-2026-09-11.md`.

- [x] Test CLI parsing before implementation: `download --sport tennis --max-events 30 --output-dir ...`; `backtest --input ... --prices 0.5,0.6,0.7,0.8,0.9,0.95 --windows 60,180,300,480 --shares 10`.
- [x] Run `npm test -- tests/research/cli.test.ts`; implement CLI without trading imports, validating every parameter before network/output writes.
- [x] Run bounded public downloads and save raw evidence under `data/research/`; run the backtest on those files. Document sample selection, availability and actual results rather than claiming tennis is less competitive.
- [x] Check table tennis/badminton/esports directory and bounded catalog inventory independently. Retain URLs/commands and count only observed matches.
- [x] Run a finite tennis collector smoke test using the corrected mode and examine raw books/trades/game-state availability.

### Task 5: Review and local integration

- [x] Review spec compliance independently, fix actionable findings with regression tests, then review code quality.
- [x] Run `npm test`, `npm run typecheck`, `git diff --check`; record exact results and live sample limitations in `docs/tennis-research-verification.md`.
- [ ] Commit only the scoped implementation/docs; integrate into local main according to the user's existing preference, preserving unrelated root documents. Do not push or trade.
