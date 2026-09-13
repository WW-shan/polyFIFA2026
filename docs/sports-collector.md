# Public Sports Collector

The collector records public Polymarket sports data for later research. It does not read trading credentials, place orders, infer fills, or turn a public quote/trade into a personal execution.

## Finite run

```bash
npm run collect -- \
  --duration-seconds 60 \
  --event-slugs <one-public-event-slug> \
  --discovery-interval-ms 60000 \
  --snapshot-interval-ms 60000
```

The default discovery scope is the Games tag (`100639`), with a 48-hour lookback and 24-hour forward metadata window. Use `--all-open` to remove the date window, `--sports nba,tennis` to filter by tag or sport code, and `--event-slugs` for a small explicit scope. Event slugs bypass the date and sport filters.

For tennis use `npm run collect:tennis -- --duration-seconds 60`. This selects the Tennis tag (`864`) and `--date-window game-start`: it omits server metadata-date filters, then uses event `startTime` or market `gameStartTime` locally, retaining live and unknown-start events. Gamma `startDate` is not used as a game clock, and `endDate` may be scheduled start plus seven days. The legacy `metadata-end` mode remains the default for existing callers. `--all-open` bypasses either date mode. Broader scans still have explicit pagination caps; unknown-start events may include non-match topics rather than confirmed games.

`collect:tennis` also enables `--include-related-events`. It expands discovered game IDs through Gamma's keyset catalog, retains companion/closed-market metadata and validates returned identities and cursors. Other collection commands can opt in with the same flag. It does not establish that every market on the exchange was discoverable at every earlier instant.

The command creates a new directory under `data/collector/<runId>/`. Every journal line contains a schema version, run ID, process sequence, UTC receipt time, monotonic timestamp, source, kind, optional connection epoch, and source data. CLOB and Sports WebSocket connections are independent. CLOB token subscriptions are sharded at 200 tokens per socket by default; public frames are persisted before interpretation.

A positive `--duration-seconds` includes startup and cancels pending HTTP requests at the deadline. A value of zero performs one initial discovery/snapshot pass. Omit the option for continuous collection:

```bash
npm run collect -- --sports soccer,tennis
```

Discovery and snapshots default to 60-second intervals, with at most 8 simultaneous HTTP snapshots (`--snapshot-concurrency`). Failed discovery keeps the last subscriptions; disappeared events are looked up and retried until closure/archive is explicitly observed. Paused orders and zero liquidity do not exclude markets.

Data files are intentionally ignored by git. A run can be stopped with Ctrl-C or SIGTERM; the collector closes sockets, writes a session-end record, and flushes pending journal data. Storage failures are fatal and are not silently converted into a successful run.

Opening and inbound-silence deadlines detect stalled sockets. Reconnects use capped exponential backoff and new connection epochs. Graceful close has a deadline followed by owned transport teardown, including connections stuck in TLS/proxy handshakes. Startup, storage, and shutdown failures exit nonzero. UTC clock rollback does not reuse segment names; replay orders segments by their first record sequence. Buffer accounting includes in-flight writes.

## Export

```bash
npm run collect:export -- \
  --run-dir data/collector/<runId> \
  --output-dir data/collector/<runId>/export
```

Export produces `quotes.csv`, `trades.csv`, `sports.csv`, `markets.csv`, and `quality.json`. Existing output files are rejected unless `--overwrite` is explicit.

Export reads journal lines and emits reconstructed rows incrementally, including each element of an array frame. It retains current books and metadata instead of historical book copies. Output is staged before publication; replay failure leaves an older export unchanged. The quality file is published last and includes record/row counts. Use the finished run directory for reproducible export; do not export a journal while its collector is still writing it.

Quotes are emitted only after a complete CLOB book snapshot and valid same-connection/subscription updates. Price-change sizes are absolute quantities; size zero removes a level, including equivalent price spellings such as `0.70` and `0.7`. Malformed levels/frames, unsupported mutations, timestamp regressions, disconnects and sequence gaps invalidate affected depth until a valid current snapshot arrives. Unfinished final lines are counted and excluded; incompatible schema/run IDs and broken journal order are rejected. Bid and ask levels remain separate from public trades.

The observed exchange protocol can split one source hash/timestamp batch across multiple frames, temporarily contradicting its advertised final top prices. Such depth remains provisional until same-batch reconciliation. Moving to another batch while still inconsistent requires a real snapshot. `bookConsistency` distinguishes provisional recovery, persistent invalidity and withheld updates; these diagnostics must not be read as a raw count of lost messages. Standalone `best_bid_ask` frames are not depth mutations.

The export attaches only the latest matching sports record, using canonical event/game identifiers. Heartbeats and unrelated matches never supply score context. Receipt age uses the journal's monotonic clock; quotes include score, period, clock, and explicit `missing`, `matched`, `stale` (over 60 seconds) or `disconnected` sports status. Missing clock fields remain missing. Array indices identify multiple observations in the same raw frame. Future scores never rewrite earlier quotes.

It does not calculate time remaining, final winners, maker fills, queue position, or strategy returns. An old/illiquid game may produce only initial books and unrelated global Sports messages; that is not evidence of a complete score history. Storage grows with frame rate and market depth, so measure actual run bytes over elapsed time before provisioning a continuous run. Segment size defaults to 64 MiB and pending buffer to 32 MiB; these bounds do not limit total disk usage.

## Per-second tail export

`npm run collect:tail -- --run-dir PATH --output-dir NEW_PATH` adds a two-pass, match-finish-relative view of the completed journal. It produces full-depth `seconds.ndjson`, indexed `seconds.csv`, `raw-events.ndjson`, `changes.ndjson`, `state-changes.ndjson`, `audit.ndjson`, `quality.json`, an offline `viewer.html`, and a completion manifest published last. See [the detailed acceptance report](second-replay-acceptance.md).

The default window is 300 seconds; `--event-slugs` selects games without removing their captured companion markets. `--max-feed-silence-ms` defaults to 30000 and `--sports-stale-after-ms` to 60000. A source-old or untimed Gamma fallback cannot replace a newer timestamped Sports state just because the HTTP reply arrived recently. Stale score context remains labeled stale.

`collect:labels` makes one bounded public refresh per recorded event and preserves response bodies and identity evidence. `collect:tail --finish-labels FILE` imports only explicit finish boundaries from that sidecar. Finish/identity conflicts are not silently resolved. HTTP book audits use matching source hashes or comparable source timestamps; seed and in-window counts are separate. Current-batch depth disagreement waits for further fragments, and an unfinished audit is not called verified. HTTP snapshots never rewrite historical WS books.

## Options

Useful collection options include:

- `--root-dir`, `--run-id`, `--max-segment-bytes`, and `--max-buffer-bytes` for local storage.
- `--gamma-base-url`, `--clob-base-url`, `--clob-ws-url`, and `--sports-ws-url` for endpoint fixtures or mirrors.
- `--page-size`, `--max-pages`, `--lookback-hours`, `--ahead-hours`, `--date-window metadata-end|game-start`, and `--all-open` for discovery.
- `--discovery-interval-ms`, `--snapshot-interval-ms`, `--snapshot-concurrency`, `--http-timeout-ms`, and `--duration-seconds` for runtime control.

The collector uses `HTTP_PROXY`/`HTTPS_PROXY` (and their lowercase variants) when no explicit `--proxy-url` is supplied. Supported proxy URLs use `http:` or `https:`; unsupported protocols such as `socks5:` fail before opening a connection. For a local mixed-protocol proxy, use its HTTP URL, for example `--proxy-url http://127.0.0.1:10808`. HTTP requests own and release their transport through success, timeout and cancellation, including unfinished TLS and CONNECT handshakes.
