# Collector source audit: 2026-09-16

## Scope and method

Read-only inspection of the running collector and five sealed gzip journal
segments in run `run-8543da80-8097-4631-b2df-2769a85d9665`:
`2026-09-16-000978.ndjson.gz` through `2026-09-16-000982.ndjson.gz`.
Records span 2026-09-16T12:41:10.164Z through 12:46:10.319Z.
This is a bounded operational sample, not an audit of all historical coverage.
No collector restart, raw-history replacement, or trading action was performed.

## Observed snapshot results

| Measurement | Count |
| --- | ---: |
| Batch responses | 374 |
| Token requests in those batch responses | 18,642 |
| Unambiguous individual snapshots recorded | 18,192 |
| Batch identity diagnostics | 86 |
| Missing token occurrences | 450 |
| Distinct missing tokens | 148 |
| Duplicate, unrequested, or malformed response IDs | 0 |
| Separate HTTP errors | 2 |

Both HTTP errors recorded `AbortError: This operation was aborted` at
12:45:39.381Z and 12:45:39.673Z. Their requests are outside the 18,642
response-associated token requests above. The cause of cancellation was not
established in this audit. These counts are not a WebSocket loss rate or a
per-second coverage percentage.

Missing tokens grouped by the current capture-state identity mapping:

| Sport | Distinct tokens | Missing occurrences |
| --- | ---: | ---: |
| ITF | 96 | 308 |
| Tennis | 14 | 42 |
| ATP doubles | 8 | 24 |
| Setka Ukraine men | 20 | 50 |
| Setka Czech men | 8 | 22 |
| Setka Moldova men | 2 | 4 |

Six discovery diagnostics concerned event IDs `766238` and `775275`, each
reporting `AMBIGUOUS_MATCH_SCOPE: missing-participants`. They must not be
silently accepted as identified matches.

## Reproduced source inconsistency

Read-only public endpoint checks after the sample:

- `GET https://gamma-api.polymarket.com/events/1032280` returned HTTP 200.
- Event: Simchuk Viacheslav vs. Zvolynskyi Yurii.
- Its moneyline market `4609785` reported `closed=false`,
  `acceptingOrders=true`, `enableOrderBook=true`.
- The market explicitly included token
  `47405271006448183286774832834981676631588518417643990487532379107761291157249`.
- `GET https://clob.polymarket.com/book?token_id=47405271006448183286774832834981676631588518417643990487532379107761291157249`
  returned HTTP 404, `No orderbook exists for the requested token id`.

This demonstrates a catalog/book-source inconsistency at observation time.
It does not establish its duration or whether a matching WebSocket book existed.
Do not infer that all missing batch tokens are closed markets, and do not use a
later HTTP response to repair past seconds. The original batch evidence remains
in the journal segments named above. The separate diagnostic GET results were
observed in this session, not admitted as collector journal evidence.

## Confirmed diagnostic-display defect

`ContinuousState.observeUnsafe` serializes the entire error record data;
`ContinuousState.issue` limits the message to 2,000 characters. Batch diagnostics
place token IDs and the request body before the error code and missing-token
lists. Consequently, the visible error may contain only token IDs and omit the
actual reason. The complete journal record is unaffected.

## Finish-source research

The previously pending raw-message sample was recovered. Three tennis examples
contain `eventState.type=tennis`, `score`, `period=S1`, and state
`createdAt`/`updatedAt`. None of those examples has an independent set/game-end
timestamp. This is not evidence that such timestamps can never be supplied.

ITF metadata references `https://www.itftennis.com/en/tournament-calendar/`;
Setka metadata references `https://setkacup.com`. Both page extraction attempts
returned empty content. No external finish adapter has been validated or enabled.

Reproducible retrieval commands:

```sh
smart-search fetch https://setkacup.com --format json --output data/research/source-evidence/setkacup-official-20260916.json
smart-search fetch https://www.itftennis.com/en/tournament-calendar/ --format json --output data/research/source-evidence/itf-calendar-official-20260916.json
```

Those files document retrieval failures, not verified page-content evidence.

## Proposed next change (not implemented)

Recommended: repair bounded error presentation only. Put the diagnostic code,
batch ID, journal run/sequence reference, request time, and affected-token counts
before a short token sample. Retain full payloads exclusively in the existing
raw evidence; preserve the 2,000-character and 50-error bounds. For HTTP failures,
show error name/message before request details. Do not change subscriptions,
retry rates, finish labels, or replay eligibility in this patch.

Alternatives considered: increasing the message size would still flood the
dashboard; adding automatic GET retries would increase request load and cannot
recover historical seconds. Neither addresses the presentation defect as directly.

Acceptance checks: a 50-token diagnostic retains its actual code and counts;
HTTP failures retain their cause; raw input remains unchanged; malformed diagnostic
payloads do not disrupt capture; existing state, status-server, and collector tests
remain green. Implementation awaits design confirmation.

## Operational checkpoint

At 2026-09-16T12:47:42.495Z the collector was `collecting`, with 29 open
connections and approximately 24.84 GiB free. Compression was enabled and had
no last error. The 20 GiB disk protection threshold remains unchanged; this
storage margin does not establish indefinite unattended capacity.

## Later checkpoint and service audit (13:10 UTC onward)

The user narrowed work to tennis and checkpoint storage; database work is deferred.
An inode-based scan of `runs` and `checkpoints` found approximately 18.397 GiB
of allocated blocks shared between those two trees (4,321 distinct files),
9.243 GiB found only in `runs`, and 0.001755 GiB found only in `checkpoints`.
Deleting checkpoint aliases alone would therefore not release the shared 18 GiB.
These are allocated-block measurements, not APFS exclusive-extent guarantees.

At 13:10 UTC the live status endpoint still said `collecting`, but its last
record timestamp was 13:00:07.562 UTC. The queue remained at 2,361,960 bytes.
Several tennis archive attempts reported missing `manifest.json` after their
child process exited, leaving six empty output files. The root causes of the
capture stall and premature exporter exit remain unconfirmed.

A controlled service stop/start was attempted. Startup failed with
`CAPTURE_LOCK_INVALID`: the old lock's hostname was `192.168.5.11`, whereas the
current hostname was `wdeMac-mini.local`. Its owner PID 95588 was the confirmed
old collector and was no longer running. With the service unloaded and no
collector process present, the old lock was moved without overwrite to
`data/research/source-evidence/collector-lock-pid95588-hostname-change-20260916.json`.
No raw data or checkpoint was deleted. A subsequent start created PID 29981
and run `run-900ae1ea-e013-40af-ba43-ce1076b198f1`.
Initial discovery records resumed at 13:13 UTC; this alone is not proof that
live orderbook capture has recovered. The stalled interval remains a real gap.

## User-authorized deletion after project-wide size audit

The project-wide allocated-block scan reported approximately 64 GiB before
cleanup, including worktrees, dependencies, temporary files, and data. The user
explicitly requested deletion of excessive project data.

Seven incomplete export directories were compared file-by-file with full SHA-256.
All six files in each were byte-identical. Retained recovery copy:
`data/collector/continuous/exports/7ce8af82e8f01937-1789438519982-aab8bcdd`.
Deleted duplicate directory names under that same exports root:

- `7ce8af82e8f01937-1789439735351-22a14295`
- `7ce8af82e8f01937-1789442961045-6bd4fae6`
- `7ce8af82e8f01937-1789444181283-f1d22cbe`
- `7ce8af82e8f01937-1789447221602-5dd03fc9`
- `7ce8af82e8f01937-1789448911958-cade7340`
- `7ce8af82e8f01937-1789451952226-cd4754df`

Deleted allocated blocks totaled 3,339,460,608 bytes. These were incomplete
retry copies, not distinct matches. The retained copy has these SHA-256 values:

| File | SHA-256 |
| --- | --- |
| audit.ndjson | 2f25d9d6c6025d19a54b525b34dfe44e9c93dd1a377161aa3e326c4df11791aa |
| changes.ndjson | 63687f4ef0113b3fae243184ee043a68bf774f3d5d3f344af7241f1c46d66e2d |
| raw-events.ndjson | 3864feef2c643cded190d7f8d91b5022046b4cc7101892d7b684345395db6d05 |
| seconds.csv | 95aa8f8fb2f1ddb51ee8b77993f81c8a801ad1d1e395e82d7b98eb785bcd664d |
| seconds.ndjson | 4a96ba3b5e9b56a3213b2365c894028fb88e989f7bf9883b50b710e836a68d40 |
| state-changes.ndjson | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |

Also removed checkpoint `078461b0ef72d664-1789337031523-f1ae806a` after checking
current state, completed-export source references, docs, and research references.
Every one of its 1,214 segment/integrity aliases had the same device and inode as
its preserved counterpart in `runs/run-d3d643d3-daee-4ec1-9fae-dc309f1cc4d3`.
The checkpoint manifest was moved to
`data/research/source-evidence/removed-checkpoint-078461b0ef72d664-1789337031523-f1ae806a.json`.
This removes 4,259,486,764 bytes of repeated path-level logical size, not that
amount of physical storage. The aliases can be reconstructed from the preserved
source and manifest. No unique raw journal or completed export was deleted.

After cleanup, `du -sh .` reported approximately 61 GiB; `df -h .` showed
approximately 32 GiB available. Live status after restart was independently
observed as collecting with 18 open connections and a record age of 92 ms.

## Tennis export regression and backtest rerun (2026-09-17)

The real failed tennis checkpoint reproduced a hang in repeated compressed
segment prefix reads. The cause was an early async-iterator return leaving the
gzip pipeline running while teardown waited for its source. The reader now uses
an iterator with `destroyOnReturn: false`, aborts the gzip pipeline on an early
return, and still waits for the pipeline rejection before closing the file.
This preserves full-stream CRC/truncation errors while making bounded prefix
reads finite. The regression test repeats 100 early prefix reads and compares
all 65,536 bytes exactly.

Verification: the focused compression/checkpoint/export tests passed 76/76;
the full suite passed 2,516/2,516 across 89 test files; TypeScript typecheck
passed. The previously failing real checkpoint exported successfully to
`data/collector/continuous/exports/verified-tennis-gzip-lifecycle-20260917`
with 9,632 one-second rows and 32 token directions. It has zero strict-ready
directions because its source finish evidence remains incomplete/conflicted;
this is a quality result, not an exporter failure.

Two tennis backtests were rerun over the previous 29 tennis sources plus this
new verified export (30 sources, 30 games, 12,240 parameter scenarios):

- `data/research/collected-books/20260917-tennis-all-touch`: 1,044 eligible
  parameter scenarios; **7 eligible quote-touch assumed-fill scenarios across
  5 games**, at prices 0.90/0.97/0.99; no settled fills. The maximum in any one
  parameter group is 2, not the total number of touch scenarios.
- `data/research/collected-books/20260917-tennis-all-sell-through`: the same
  inputs and eligibility; **7 eligible price-touch scenarios but 0 strict
  sell-through modeled fills**.

Corrected on 2026-09-18 by verifying all ten report artifact hashes, all 30
source fingerprint sets, and rerunning both models: each reproduced all 12,240
trial objects and 264 parameter-group summaries exactly, without network
requests or duplicate large report files. See
`data/research/source-evidence/tennis-backtest-audit-20260918.json` and
`data/research/source-evidence/tennis-backtest-replay-20260918.json`.

Across the 30 sources, 23 distinct games, 44 match/window-duration combinations,
and 83 markets reached the engine's comparable eligible set. This is far too
small to estimate a stable positive expectation. The reports retain exclusions such as incomplete tail,
snapshot-audit failure, missing entry reference, clock-affected data and
conflicting finishes rather than treating them as losses or no-touch samples.

At the 2026-09-17 final check the service process was present and reported
open connections, but the measured receipt age was **61,142,136 ms (about
16.98 hours)**. The earlier “61 minutes” description was a unit-conversion
error, corrected on 2026-09-18. The status also contained batch and archive
errors. Process existence and reported open connections were not proof of
continued collection; this interval remains an uncovered data gap.

The 2026-09-18 resumption found the same old PID 29981, with the last persisted
record at `2026-09-16T19:58:19.933Z`, sequence 14,971,447, `checkpoint_end`.
The HTTP endpoint manufactured a current `updatedAtMs` on each read even though
the saved state and raw journal had stopped advancing. The patched reader
listed all 359 segments of that real run in 243 ms. Pre-restart observations
and the last segment hash are preserved in
`data/research/source-evidence/tennis-collector-pre-restart-20260918.json`;
operational recovery and fresh verification are recorded in
[the continuation report](tennis-continuation-verification-2026-09-18.md).
