# Sports Collector Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the bounded catalog task and review. Follow test-driven-development for data integrity behavior.

**Goal:** Add a standalone public sports recorder and deterministic CSV export for later strategy research.

**Architecture:** Preserve original CLOB/Sports frames with receipt clocks and connection epochs in an append-only segmented journal. Discover generic sports game events through Gamma and keep raw metadata, then reconstruct valid books only during offline export.

**Tech Stack:** Existing TypeScript/Node.js, undici WebSocket/HTTP, Node filesystem streams, Vitest. No new runtime dependencies or trading imports.

## 1. Catalog and metadata

Files: `src/collector/types.ts`, `src/collector/catalog.ts`, `tests/collector/catalog.test.ts`.

- [x] Define shared journal and catalog contracts.
- [x] Write tests for pagination/deduplication, unusual sports/market types, zero liquidity, paused orders, token/outcome mapping and malformed responses; run `npx vitest run tests/collector/catalog.test.ts` and observe failure.
- [x] Implement the public Gamma adapter with injectable requests, page auditing, explicit filters and a hard pagination error. Never use the football strategy selector to restrict recording.
- [x] Re-run catalog tests and review against the spec.

## 2. Journal and public streams

Files: `src/collector/journal.ts`, `src/collector/streams.ts`, `tests/collector/journal.test.ts`, `tests/collector/streams.test.ts`.

- [x] Test unique run directories, sequence ordering, size/date rotation, complete close and bounded buffering. Run the journal test before implementation.
- [x] Implement a bounded serialized writer; every accepted record gets receipt and monotonic timestamps. Report asynchronous storage errors to the collector and fail explicitly.
- [x] Test public subscription frames, both heartbeat protocols, reconnect epochs, dynamic additions/removals and shutdown using controlled sockets/timers.
- [x] Implement stream lifecycle and stable token sharding; persist text frames before interpretation. Re-run focused tests.

## 3. Recorder runtime and CLI

Files: `src/collector/collector.ts`, `src/collector/cli.ts`, `tests/collector/collector.test.ts`, `tests/collector/cli.test.ts`, `package.json`, `.gitignore`.

- [x] Test argument validation, finite runs, periodic discovery, HTTP snapshots, disappeared-event reconciliation, transient failures, clean cancellation and fatal storage failure.
- [x] Implement separate `collect` and `collect:export` scripts. Default recording parameters: lookback 48h, ahead 24h, discovery 60s, snapshots 60s, 200 tokens/socket, 64 MiB segments, 32 MiB buffer.
- [x] Persist config/status/errors and require no credentials. Record every changed subscription and every HTTP request interval. Avoid overlapping periodic scans.
- [x] Re-run focused integration tests and TypeScript checks.

## 4. Offline export

Files: `src/collector/replay.ts`, `src/collector/export.ts`, `tests/collector/replay.test.ts`, `tests/collector/export.test.ts`.

- [x] Test book replacement, absolute quantity changes, deleted levels, different bid/ask order, dropped prices, score corrections, stale/missing sports data, connection invalidation, out-of-order messages and CSV escaping.
- [x] Implement replay and streamed CSV output for quotes, public trades, sports and market mappings. Never infer maker fills, time remaining or final winners from the last quote.
- [x] Reject overwritten export files and damaged journal ordering. Report incomplete final lines/gaps without treating them as valid book history.
- [x] Re-run focused tests, then full `npm test` and `npm run typecheck`.

## 5. Verification and handoff

Files: `README.md`, `docs/sports-collector.md`.

- [x] Run a finite public recording using explicit small event scope; inspect record types, metadata mapping, independent CLOB/Sports connections and saved frames.
- [x] Export that run and verify row counts and quality status; document source coverage limits and disk growth.
- [x] Complete spec and code review; address reproducible findings, then re-run affected checks.
- [x] Provide copyable continuous and finite commands and the observed sample location. Leave long-term process management to an explicit deployment request.
