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

Data files are intentionally ignored by git. A run can be stopped with Ctrl-C or SIGTERM; the collector closes sockets, writes a session-end record, and flushes pending journal data. Storage failures are fatal and are not silently converted into a successful run.

## Export

```bash
npm run collect:export -- \
  --run-dir data/collector/<runId> \
  --output-dir data/collector/<runId>/export
```

Export produces `quotes.csv`, `trades.csv`, `sports.csv`, `markets.csv`, and `quality.json`. Existing output files are rejected unless `--overwrite` is explicit.

Quotes are emitted only after a complete CLOB book snapshot and valid same-connection updates. Price-change sizes are absolute quantities; size zero removes a level. A disconnect, connection epoch change, sequence gap, missing snapshot, malformed line, or incomplete final line is recorded in the quality summary and does not become valid book history. Bid and ask levels remain separate from public trades.

The export attaches the latest matching sports record and its receipt age when an event slug or game ID can be matched. It does not calculate time remaining, final winners, maker fills, queue position, or strategy returns. Re-run strategy research against the exported raw evidence with those limitations visible.

## Options

Useful collection options include:

- `--root-dir`, `--run-id`, `--max-segment-bytes`, and `--max-buffer-bytes` for local storage.
- `--gamma-base-url`, `--clob-base-url`, `--clob-ws-url`, and `--sports-ws-url` for endpoint fixtures or mirrors.
- `--page-size`, `--max-pages`, `--lookback-hours`, `--ahead-hours`, and `--all-open` for discovery.
- `--discovery-interval-ms`, `--snapshot-interval-ms`, `--http-timeout-ms`, and `--duration-seconds` for runtime control.

The collector uses the existing `HTTP_PROXY`/`HTTPS_PROXY` behavior through the HTTP and WebSocket clients when no explicit proxy option is supplied. It has no Polymarket account or order credentials.
