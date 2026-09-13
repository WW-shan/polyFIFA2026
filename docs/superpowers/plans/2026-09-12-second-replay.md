# Five-minute second replay implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow test-first steps and keep disjoint file ownership.

**Goal:** Deliver an auditable per-second full-book view of each captured market in a match's last 300 seconds, preserving intra-second movements and state changes.

**Architecture:** Extend the existing journal replay's validity observability, normalize match context with provenance, then perform bounded two-pass window replay and export/view. HTTP snapshots audit comparable source states; they never replace later WebSocket books.

**Tech Stack:** TypeScript, Node, existing collector/journal, Vitest, public Polymarket WebSockets/Gamma/CLOB.

---

### 1. Replay integrity and observability

Files: `src/collector/replay.ts`, `replay-types.ts`, `tests/collector/replay-integrity.test.ts`.

- [x] Add failing tests for invalidation callback/status, hash provenance, crossed books and best-price contradictions, and shared-game companion matching without conflicting strong IDs.
- [x] Run `npm test -- tests/collector/replay-integrity.test.ts` and observe the expected failures.
- [x] Implement `getBookStatus(connectionId,tokenId)`, optional invalidation callback, book hash/update type; preserve existing exporters and bounded-memory replay.
- [x] Run replay/export suites and typecheck; review the diff.

### 2. Match context and finish evidence

Files: `src/collector/tail-types.ts`, `tail-context.ts`, `tests/collector/tail-context.test.ts`.

- [x] Test event/market normalization, both outcomes, all/closed market types, actual finish only, raw source retention and state-change timing.
- [x] Add tests for score increase/decrease, tennis set strings not misclassified as goals, and missing source clocks.
- [x] Implement pure `metadataFromRecord`, `observationsFromRecord`, `changesBetween` using the shared contract.
- [x] Verify `npm test -- tests/collector/tail-context.test.ts`; no forward propagation of later scores.

### 3. Streaming window replay and snapshot audit

Files: `src/collector/tail-replay.ts`, `tail-audit.ts`, `tail-export.ts`, respective tests.

- [x] Fixture: true finish at 310000ms; books before 10000ms; .95 -> .60 -> .94 between 11000 and 12000ms. Assert 300 rows/token, intra-second low .60 and unchanged last-second price .94, with both raw updates preserved.
- [x] Assert disconnect/reconnect and mid-second invalidation never become a flat complete second; missing leading/trailing run coverage remains missing; source/receipt timestamps stay distinct.
- [x] Assert same-hash/depth agreement versus mismatch, incomparable HTTP snapshots, clock rollback rejection and lack of finish labels.
- [x] Implement two-pass scan, bounded current-window state and explicit per-token coverage; use complete journals only.
- [x] Export exclusive JSON/CSV/NDJSON artifacts and quality manifest; test no-overwrite and partial-write failure behavior.

### 4. Human inspection and real acceptance

Files: `src/collector/tail-view.ts`, collector CLI/package scripts, tests, `docs/second-replay-acceptance.md`.

- [x] Test CLI validation before file reads and add the tail-export command.
- [x] Build an offline viewer with event/market/outcome selection, bid/ask chart, state-change markers, second rows and depth inspection. Escape untrusted metadata; no external requests from the viewer.
- [x] Run finite real collection across match ends, then export selected tails; retain source evidence and report exact coverage/audit results, not just test counts.
- [x] Compare old short runs as negative controls. Defer sport expansion if data gates fail.

### 5. Review and integration

- [x] Independent spec and correctness review, regression fixes, fresh full tests/typecheck/diff checks.
- [x] Document observed coverage, remaining source limits and commands; locally integrate after verification while preserving existing untracked documents and raw data. No push or trades.

## Final validation notes (2026-09-13)

- Core regression fixes cover pre-emission journal gaps, within-second liveness, canonical source clocks, seed audits, fragment-finality and snapshot generations. Old/untimed Gamma fallback cannot roll back newer Sports state.
- Identity validation uses all captured window identities, including filtered-out games; finish evidence retains bounded compact witnesses instead of repeated raw metadata.
- Final raw re-export: `tail-final-20260913/`; 49,379 raw window records match the source and all 39,000 viewer depth offsets validate.
- Dodig: six active directions each have 300 valid book seconds and 119 combined in-window full-depth matches. Score context is fresh for 273 seconds, stale for 27, so strict `readyForReplay` is false. This is a source-data limitation, not waived acceptance.
- The prior 90-second capture remains a negative control with zero complete tail windows. No sport expansion, orders or permanent monitoring was started.
- Full suite: 56 files / 1,297 tests; typecheck and diff checks passed both in the feature worktree and after local integration to `main`.
- Independent context/catalog/labels and core recovery reviews passed after regression fixes. Latest-code replay SHA-256 outputs for all five NDJSON streams and the quality object match both final real-data exports.
- Feature commit `a28d8a4` was fast-forwarded locally. Main also passed the tail help command and all 13 local README/acceptance links; the two pre-existing untracked user notes retained their original SHA-256 hashes. No remote push or trading action occurred.
