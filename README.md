# polyFIFA2026

Research and implementation workspace for a Polymarket World Cup single-match tail-entry bot.

Start here:

- `docs/worldcup_tail_spread_research.md` — research conclusions, API notes, backtest summaries.
- `docs/loss_requires_two_goals_strategy_backtest.md` — latest `lossRequiresGoals >= 2` strategy research.
- `docs/loss_requires2_last3min_review.md` — last-3-minutes review and ranking.
- `docs/superpowers/specs/2026-06-22-worldcup-tail-spread-bot-design.md` — implementation design.
- `docs/superpowers/plans/2026-06-22-worldcup-tail-spread-bot.md` — implementation plan.
- `data/price_history_summary.csv` — CLOB price-history summary.
- `data/trades_summary.csv` — Data API trade summary.

## What The Bot Does

This phase handles World Cup single-match markets where the selected bet only loses after at least two adverse goals, plus locked result markets. It accepts an explicit match state, builds all eligible strategy candidates, checks CLOB asks after fees, and sends the highest estimated net-return positive decision to either a paper executor or an opt-in live CLOB executor.

Examples:

- 1-0 strong team lead: buy weak team win `No`, equivalent to strong team not losing.
- 2-0 lead: buy leader win `Yes` or draw `No`.
- Current total 1 with `O/U 2.5`: buy `Under`, because two more goals are required to lose.
- 4-0 Spain: buy `Spain -2.5`, because one adverse goal still covers and two adverse goals lose.
- Already-hit markets such as total `Over` or BTTS `Yes` are included as locked candidates.

Default entry logic has no minimum profit hurdle beyond positive estimated net return after the Polymarket sports taker fee. Since orderbook asks must be `< 1`, the default `minimumNetReturn` is `0` and `maxEntryPrice` is `0.999999`.

Capital allocation is edge-first, not strategy-name-first: once candidates pass `lossRequiresGoals >= 2`, the bot chooses the currently executable candidate with the largest `estimatedNetReturn`. It only counts size available at that best ask price, so worse ask levels are not treated as part of the same edge.

## Setup

```bash
npm install
npm test
npm run typecheck
```

## Paper Acceptance Run

The fixture command proves the full automated path: identify latest strategy -> check orderbook -> submit paper trade -> output filled result.

```bash
npm run paper:fixture
```

Expected top-level output includes:

```json
{
  "mode": "paper",
  "status": "filled",
  "action": "BUY",
  "strategy": "spread_tight_loss_ge2",
  "outcome": "Spain",
  "line": -2.5,
  "lossRequiresGoals": 2,
  "bestAsk": 0.97
}
```

## CLI Usage

```bash
npm run cli -- \
  --mode paper \
  --match-file tests/fixtures/matches/spain-4-0.json \
  --markets-file tests/fixtures/markets/spain-spreads.json \
  --orderbook-file tests/fixtures/orderbooks/spain-2p5-ask-097.json \
  --stake 97
```

If `--markets-file` is omitted, the CLI fetches the Polymarket sports page for the match event slug and extracts strategy markets from the Next.js initial state. If `--orderbook-file` is omitted, it fetches CLOB orderbooks for all eligible candidate tokens, then picks the highest estimated net-return BUY.

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
