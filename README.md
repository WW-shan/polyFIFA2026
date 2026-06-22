# polyFIFA2026

Research and implementation workspace for a Polymarket World Cup single-match spread tail-entry bot.

Start here:

- `docs/worldcup_tail_spread_research.md` — research conclusions, API notes, backtest summaries.
- `docs/superpowers/specs/2026-06-22-worldcup-tail-spread-bot-design.md` — implementation design.
- `docs/superpowers/plans/2026-06-22-worldcup-tail-spread-bot.md` — implementation plan.
- `data/price_history_summary.csv` — CLOB price-history summary.
- `data/trades_summary.csv` — Data API trade summary.

## What The Bot Does

This phase handles World Cup single-match `Spreads` markets, not futures or moneyline markets. It accepts an explicit match state, finds the highest spread line already covered by the current score, checks best ask/depth against thresholds, and sends the decision to either a paper executor or an opt-in live CLOB executor.

Examples:

- 4-0 Spain selects `Spain -3.5`.
- 3-0 winner selects `winner -2.5`.
- 2-0 winner selects `winner -1.5`.

## Setup

```bash
npm install
npm test
npm run typecheck
```

## Paper Acceptance Run

The fixture command proves the full automated path: identify spread -> check orderbook -> submit paper trade -> output filled result.

```bash
npm run paper:fixture
```

Expected top-level output includes:

```json
{
  "mode": "paper",
  "status": "filled",
  "action": "BUY",
  "outcome": "Spain",
  "line": -3.5,
  "bestAsk": 0.97
}
```

## CLI Usage

```bash
npm run cli -- \
  --mode paper \
  --match-file tests/fixtures/matches/spain-4-0.json \
  --markets-file tests/fixtures/markets/spain-spreads.json \
  --orderbook-file tests/fixtures/orderbooks/spain-3p5-ask-097.json \
  --stake 97 \
  --max-entry-price 0.98 \
  --minimum-net-return 0.019
```

If `--markets-file` is omitted, the CLI fetches the Polymarket sports page for the match event slug and extracts spread markets from the Next.js initial state. If `--orderbook-file` is omitted, it fetches the CLOB orderbook for the selected token.

## Live Smoke Guard

Live trading requires explicit environment credentials and is not faked by tests.

```bash
npm run live:smoke
```

Without credentials this must fail clearly with `LIVE_CREDENTIALS_MISSING`. With real credentials, it attempts the configured FOK/FAK order through `@polymarket/clob-client`.

Required live env vars:

- `POLY_PRIVATE_KEY`
- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_PASSPHRASE`

Optional live env vars:

- `POLY_FUNDER_ADDRESS`
- `POLY_SIGNATURE_TYPE` defaults to `1`
- `POLY_CHAIN_ID` defaults to `137`
- `POLY_CLOB_HOST` defaults to `https://clob.polymarket.com`

## Network Proxy

`HTTP_PROXY` / `HTTPS_PROXY` are read as ordinary network settings, for example `http://127.0.0.1:10808`. The project does not implement geoblock bypass logic; trading availability is determined by Polymarket responses.

## Secret Safety

No private keys or Polymarket credentials should be committed. Runtime credentials must be provided through environment variables only.
