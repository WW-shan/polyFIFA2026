# Balanced Locked Goal Guard Design

**Goal:** Replace return-threshold-only locked buying with a fast state machine that requires source sanity, orderbook delta confirmation, trade-time refresh, and post-buy monitoring.

**Approved mode:** Balanced fast mode. The bot does not wait 60s, does not buy solely because return is high, and does not use the old unconfirmed 5%/2% cap tiers. A locked goal incident may buy only when event-source checks do not conflict and market microstructure confirms stable post-goal liquidity without a retrace.

## Signals

- **Hard block:** PM rollback, 365 score conflict without a matching goal signal, 365 event/PBP no-goal or disallowed VAR, active VAR/no-goal language, 365 post-regulation/extra-time scoring events, orderbook retrace, locked asks below `0.80` that would be crossed by a limit buy, or related-market desync.
- **Source pass:** 365 score matches or contains a matching normal goal event/PBP, with no no-goal/VAR-cancel signal. Missing 365 confirmation is not enough to buy in default mode.
- **Market pass:** A pre-goal S0 cache exists for the same token(s), immediate S1 and delayed S2 books show stable profitable liquidity, and best ask does not move down in a way that indicates retrace. Cheap liquidity appearing after the score change is allowed when the score source confirms the goal and the S1-to-S2 price does not retrace, but a locked buy is skipped if the refreshed book contains asks below `0.80` that the limit order would cross.
- **Related pass:** At least two related locked markets for the same score incident are visible when such markets exist, so one isolated cheap market does not trigger a buy by itself.

## Trading

- The per-score locked incident cap remains 20% of current total bankroll.
- Buy size is also limited by stable post-goal cheap liquidity measured as `min(S1, S2)`. The audit still records stale `min(S0, S1, S2)` for analysis.
- Before submitting a live order, the executor still refreshes the orderbook and only consumes asks that satisfy `minimumNetReturn >= 0.005`.
- If prices move but still satisfy the guard and return threshold, buying is allowed; if liquidity disappears or best ask retraces, buying is blocked.

## Monitoring

- After a locked buy, the watch loop keeps running.
- For the next three minutes of live ticks/refill checks, hard block signals stop refill and mark the incident blocked.
- A later rollback and re-score is treated as a new incident, matching the user's requested risk model.

## Testing

- Parser tests cover 365 normal goal and Goal Disallowed/VAR/PBP no-goal signals.
- CLI tests cover removal of old high/medium unconfirmed buying, 365 no-goal blocking, post-regulation goal blocking, stable-liquidity pass, confirmed post-goal liquidity pass, retrace blocking, and two-match isolation.
- Stress tests run locked refill and two-match live chains.
