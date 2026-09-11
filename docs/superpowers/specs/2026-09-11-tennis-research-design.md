# Tennis-first collection and resting-order research

## Confirmed objective

Continue the user's existing public-data collector and begin reproducible backtesting of advance resting BUY orders. Prioritize tennis; inspect table tennis, badminton and esports as comparison candidates. Bid price, entry rule, duration and size are parameters, not collection filters. Preserve losing, unfilled, unresolved and incomplete samples. No live trading, credentials, remote publishing or permanent service deployment.

## Approach

Use two complementary evidence sources: bounded historical public-trade downloads for immediate screening, and the existing raw WebSocket/order-book journal for future execution-quality research. Minute price history alone is not sufficient to claim a fill. Waiting for many complete live matches would postpone useful screening; selecting only eventual winners would answer the wrong question. The historical screen selects by the last available price before entry, never final outcome.

The first working slice consists of tennis-safe discovery, lossless public-response caching, a configurable price/window resting-order screen, and actual downloaded results. Existing trading logic stays unchanged. Historical finish-relative windows are explicitly retrospective labels; they are not claimed to be deployable tennis clocks. An additional price-trigger/holding-duration entry can operate without knowing the finish in advance.

## Data contract

- Preserve source event/market metadata, full market rules, exact string token IDs, both outcome mappings, actual finish timestamp when supplied, and explicit resolution provenance.
- Historical public trades retain source timestamps, side, size, price and a deduplication identity. Requests, pagination bounds, failures and raw replies are cached. A short page establishes API exhaustion, not proof of exchange-wide completeness.
- Do not substitute Gamma `endDate`, `closedTime` or event creation `startDate` for actual game finish/start. A tennis event observed on 2026-09-11 had start 10:00Z, finish 11:26Z and endDate 2026-09-18.
- Resolution requires explicit resolved state and a valid payout vector, or confirmed CLOB resolution. Prices near 0/1 while open are not payouts. 0.5/0.5 outcomes remain 0.5 payouts.
- Downloads may be incomplete; such samples must be identified and excluded from aggregate profitability claims by default. No matching trade is distinct from missing data.

## Discovery change

Add a `game-start` date-window mode. Fetch the bounded open catalog without metadata end-date bounds, then filter by actual `startTime` / market `gameStartTime`; retain live games and unknown start times. Keep explicit event selection, `all-open`, all market types, paused books and existing pagination safeguards. Expose the mode in CLI and provide a tennis collection command using tag 864. Preserve legacy metadata-end mode for existing callers.

## Research outputs

Per outcome/order trial: event, market type, entry time and information source, bid, size, entry price, price-touch evidence, qualifying sell volume, simulated filled size, fill model, payout, simulated P&L, and exclusion reasons. Per parameter group: sample count, eligible trials, filled/unfilled/unknown outcomes, winning/losing/void fills, capital used, P&L and return. Keep raw evidence separate from assumptions; never label a historical touch as a guaranteed fill.

Default historical passive model uses SELL-aggressor prints below the limit, with equality/queue-ahead behavior explicit and configurable. A separate all-trade touch screen exposes price excursions without asserting our order execution. Charge the limit price on modeled fills, not a better observed print. Default maker fee is zero and configurable. Prices such as 0.7 are grid examples only.

## Verification and acceptance

Use failing regression tests before changes. Check no forward-looking side selection, no duplicate or BUY-volume fills, partial fills, equality queues, stale/missing entry evidence, resolution/void losses, incomplete pagination, filesystem no-overwrite and CLI validation. Run a bounded real tennis download and screen, compare currently available sports, and exercise finite live collection. Run full tests and typecheck; independently review scope then correctness. Integrate locally only, preserving the user's untracked documents.
