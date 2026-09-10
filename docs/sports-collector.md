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

The export attaches only the latest matching sports record, using canonical event/game identifiers. Heartbeats and unrelated matches never supply score context. Receipt age uses the journal's monotonic clock; quotes include score, period, clock, and explicit `missing`, `matched`, `stale` (over 60 seconds) or `disconnected` sports status. Missing clock fields remain missing. Array indices identify multiple observations in the same raw frame. Future scores never rewrite earlier quotes.

It does not calculate time remaining, final winners, maker fills, queue position, or strategy returns. An old/illiquid game may produce only initial books and unrelated global Sports messages; that is not evidence of a complete score history. Storage grows with frame rate and market depth, so measure actual run bytes over elapsed time before provisioning a continuous run. Segment size defaults to 64 MiB and pending buffer to 32 MiB; these bounds do not limit total disk usage.

## Options

Useful collection options include:

- `--root-dir`, `--run-id`, `--max-segment-bytes`, and `--max-buffer-bytes` for local storage.
- `--gamma-base-url`, `--clob-base-url`, `--clob-ws-url`, and `--sports-ws-url` for endpoint fixtures or mirrors.
- `--page-size`, `--max-pages`, `--lookback-hours`, `--ahead-hours`, and `--all-open` for discovery.
- `--discovery-interval-ms`, `--snapshot-interval-ms`, `--snapshot-concurrency`, `--http-timeout-ms`, and `--duration-seconds` for runtime control.

The collector uses `HTTP_PROXY`/`HTTPS_PROXY` (and their lowercase variants) when no explicit `--proxy-url` is supplied. Supported proxy URLs use `http:` or `https:`; unsupported protocols such as `socks5:` fail before opening a connection. For a local mixed-protocol proxy, use its HTTP URL, for example `--proxy-url http://127.0.0.1:10808`. HTTP requests own and release their transport through success, timeout and cancellation, including unfinished TLS and CONNECT handshakes.
