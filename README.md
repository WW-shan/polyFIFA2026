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

For live page state, `--event-slug` can replace `--match-file`:

```bash
npm run cli -- \
  --mode live \
  --event-slug fifwc-fra-irq-2026-06-22 \
  --order-type FOK
```

If `--event-slug` is used, the CLI fetches the Polymarket sports page, extracts the current `score`, `period`, `elapsed`, and remaining-time fields, then extracts strategy markets from the same event. If `--markets-file` is omitted, the CLI fetches the Polymarket sports page for the match event slug and extracts strategy markets from the Next.js initial state. If `--orderbook-file` is omitted, it fetches CLOB orderbooks for all eligible candidate tokens, then picks the highest estimated net-return BUY.

The tail-entry window is controlled by `--entry-window-minutes` and the live timing mode described below.

Live automation modes:

```bash
# Load local credentials/proxy for this shell before live commands.
set -a; source .env.local; set +a

# Check deposit-wallet pUSD balance and ledger state without placing orders.
npm run live:status

# Watch one match repeatedly.
npm run cli -- \
  --mode live \
  --watch true \
  --event-slug fifwc-fra-irq-2026-06-22 \
  --entry-window-minutes 3

# Discover open World Cup single-match events from Gamma, then watch all of them.
npm run live:watch:worldcup -- --entry-window-minutes 3
```

### Live sports timing

Single-event watch mode (`--watch true --event-slug ...`) polls the Polymarket sports page for that match. If no trade is available, it sleeps `--interval-ms` milliseconds before retrying. `--max-iterations` limits page-poll iterations and is mainly for tests/dry runs.

World Cup watch mode (`--watch --worldcup true`) discovers open World Cup events and uses Polymarket Sports WebSocket updates as the primary live score source. Incoming updates are matched to events by `slug`, `gameId`, and `sportradarGameId`. If no trade is available for an update, it waits for the next matched Sports WebSocket update instead of sleeping; `--interval-ms` does not apply. `--max-iterations` counts matched Sports WebSocket updates.

The entry window is strict: World Cup watch mode overlays Polymarket Sports updates with the 365Scores public single-game clock, then opens only when `2nd Half + addedTime + preciseGameTime` computes verified `remainingSeconds <= 180`. There is no `87'` or `90:00+` fallback. If 365Scores does not provide the required clock fields, the bot returns `MATCH_NOT_LATE_ENOUGH` and does not fetch balances, orderbooks, or place orders.

Set `POLY_LIVE_AUDIT_FILE=data/live-sports-audit.ndjson` to append raw Sports WebSocket updates and normalized match-update audit records as NDJSON for replay/debugging.

Watch mode stops as soon as one order is filled/partial/posted/rejected or a live error occurs.

Live capital allocation is all-in by default: if `--stake` is omitted, the bot selects the best executable positive-edge candidate, then uses `pUSD balance - POLY_BALANCE_BUFFER` as the order notional. Passing `--stake N` changes this to `min(N, pUSD balance - POLY_BALANCE_BUFFER)`.

## Live Smoke Guard

Live trading requires explicit environment credentials and is not faked by tests.

```bash
npm run live:smoke
```

Without credentials this must fail clearly with `LIVE_CREDENTIALS_MISSING`. With real credentials, it attempts the configured FOK/FAK order through `@polymarket/clob-client-v2`.

Required live env vars:

- `POLY_PRIVATE_KEY`
- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_PASSPHRASE`

Optional live env vars:

- `POLY_FUNDER_ADDRESS`
- `POLY_DEPOSIT_WALLET_ADDRESS` for CLOB v2 deposit-wallet accounts; this overrides `POLY_FUNDER_ADDRESS` and forces `POLY_SIGNATURE_TYPE=3`
- `POLY_LEDGER_FILE` defaults to `data/live-ledger.json` in live mode; filled/partial/posted orders are recorded as active ledger entries, and any active same-event trade is skipped
- `POLY_USE_LIVE_BALANCE=true` to size live orders from pUSD balance; this is automatic when a funder/deposit wallet is configured unless explicitly disabled
- `POLY_BALANCE_BUFFER` defaults to `0.02` pUSD so stake sizing leaves a small balance cushion
- `POLY_SIGNATURE_TYPE` defaults to `1` unless `POLY_DEPOSIT_WALLET_ADDRESS` is set
- `POLY_SYNC_BALANCE_ALLOWANCE=true` to call CLOB balance/allowance sync before posting an order
- `POLY_LIVE_AUDIT_FILE` writes raw Sports WebSocket updates and normalized match-update audit records as NDJSON
- `POLY_365SCORES_TIMEZONE` defaults to `Asia/Shanghai`; it is used only for 365Scores discovery/date parameters
- `POLY_RPC_URL` for viem wallet transport
- `POLY_CHAIN_ID` defaults to `137`
- `POLY_CLOB_HOST` defaults to `https://clob.polymarket.com`

Polymarket CLOB v2 may reject older proxy/profile makers with `maker address not allowed, please use the deposit wallet flow`. In that case, use the deposit wallet that holds pUSD as `POLY_DEPOSIT_WALLET_ADDRESS`; do not use `RELAYER_API_KEY_ADDRESS` as the funder. The private key must recover the owner/session signer for that same Polymarket account, and the CLOB API key must be derived from that signer.

## Network Proxy

`HTTP_PROXY` / `HTTPS_PROXY` are read as ordinary network settings, for example `http://127.0.0.1:10808`. The project does not implement geoblock bypass logic; trading availability is determined by Polymarket responses.

## Secret Safety

No private keys or Polymarket credentials should be committed. Runtime credentials must be provided through environment variables only.
