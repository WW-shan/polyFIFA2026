# Balanced Locked Goal Guard Design

**Goal:** Replace return-threshold-only locked buying with a fast state machine that requires source sanity, orderbook delta confirmation, trade-time refresh, and post-buy monitoring.

**Approved mode:** Balanced fast mode. The bot does not wait 60s, does not buy solely because return is high, and does not use the old unconfirmed 5%/2% cap tiers. A locked goal incident may buy only when event-source checks do not conflict and market microstructure confirms stale liquidity rather than post-goal repricing.

## Signals

- **Hard block:** PM rollback, 365 score conflict without a matching goal signal, 365 event/PBP no-goal or disallowed VAR, active VAR/no-goal language, orderbook retrace, or related-market desync.
- **Source pass:** 365 score matches or contains a matching normal goal event/PBP, with no no-goal/VAR-cancel signal. Missing 365 confirmation is not enough to buy in default mode.
- **Market pass:** A pre-goal S0 cache exists for the same token(s), immediate S1 and delayed S2 books do not show cheap-quantity growth, and best ask does not move down in a way that indicates retrace.
- **Related pass:** At least two related locked markets for the same score incident are visible when such markets exist, so one isolated cheap market does not trigger a buy by itself.

## Trading

- The per-score locked incident cap remains 20% of current total bankroll.
- Buy size is also limited by stale cheap liquidity measured as `min(S0, S1, S2)`.
- Before submitting a live order, the executor still refreshes the orderbook and only consumes asks that satisfy `minimumNetReturn >= 0.005`.
- If prices move but still satisfy the guard and return threshold, buying is allowed; if new cheap liquidity or retrace appears, buying is blocked.

## Monitoring

- After a locked buy, the watch loop keeps running.
- For the next three minutes of live ticks/refill checks, hard block signals stop refill and mark the incident blocked.
- A later rollback and re-score is treated as a new incident, matching the user's requested risk model.

## Testing

- Parser tests cover 365 normal goal and Goal Disallowed/VAR/PBP no-goal signals.
- CLI tests cover removal of old high/medium unconfirmed buying, 365 no-goal blocking, stale-liquidity pass, new-cheap-liquidity blocking, retrace blocking, and two-match isolation.
- Stress tests run locked refill and two-match live chains.
