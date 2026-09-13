# Five-minute, per-second market data verification

The user's acceptance target is the accuracy/completeness of each game's different markets during its final five minutes, including every within-second movement and contemporaneous score/state changes. Sport expansion and profitability optimization are deferred until this data layer is verifiable.

## Chosen design

Record every received WebSocket event, not one poll per second. Keep the existing append-only journal; derive a one-second full-depth view and a separate within-second update/trade/state-change log. Trade history or minute-price interpolation cannot supply missing historical L2 books. Default window is the parent match's reported actual finish minus 300 seconds, for every captured market/outcome, including markets already closed. Separate set/half end windows require their own finish evidence; no metadata expiry or closure time is substituted for a finish.

Two offline passes over a completed journal: first catalog identities and explicit finish labels, then sequential replay with one-second buckets. Keep memory bounded by selected windows/current books, not every historical book. Capture both source and receipt timestamps. State displayed at a bucket uses only records received before its right edge; a later score never rewrites earlier seconds. Gamma snapshots are a labeled slower fallback and never overwrite a fresh Sports observation. A score increase/rollback is an observation, not a confirmed goal/VAR event unless the source explicitly supplies it.

## Accuracy gates

- Exact string IDs and decimal book quantities, explicit market/outcome mapping, all captured market types; companion events sharing a game identity group together without allowing conflicting game IDs.
- Snapshot + absolute delta reconstruction; local gaps, disconnects, malformed/out-of-order updates require a real snapshot. Real capture proved that one exchange batch can publish several level fragments with the same final hash/timestamp and advertised final top. Such provisional depth is withheld while fragments apply; only same-batch reconciliation restores validity. A conflict crossing into another batch stays invalid until a snapshot. Raw fragments and provisional/persistent diagnostics remain available.
- No silently carrying a book across a known gap. A healthy unchanged stream may carry the last state, labeled as carried, with last-update age. A source batch fully reconciled within a second is not a missing interval; one unresolved across a bucket edge remains partial. Lost/silent/unknown streams and late subscription remain explicit.
- HTTP book snapshots are audit evidence, not delayed mutations applied over the live stream. Compare full normalized depth only when a shared source hash or source timestamp makes snapshots comparable. Disagreement, no comparability and missing audits are distinct.
- A current delta hash can describe an unfinished source batch even after its top prices reconcile. Keep pending depth uncertainty with the book independently of the bounded HTTP-response queue. It survives queue replacement and makes boundary-crossing seconds partial; only verified same-batch depth or a new independent WS snapshot can clear it. An old historical response cannot quarantine a newer snapshot generation, including snapshots in different elements of one array frame.
- One-second rows also include within-second min/max best bid/ask, update and trade counts, volume, state observation age/source, and every rapid move in a separate change log. A fall-and-recovery inside the same second must remain visible.
- Actual finish labels, missing/conflicting finish evidence, clock discontinuities, start/end run coverage and per-token coverage are reported. Passing local checks is not proof that the upstream exchange never omitted a message.
- Actual finish metadata may be published after collection stops. A separately saved, identity-checked finish-label file may supply only window boundaries, never future scores, market closures or books. Both source bodies and label-observation times are retained.
- Game/slug/alias validation includes all captured identities, even when only one game is selected. Finish accumulation stores compact bounded witnesses; repeated finished metadata must not retain full raw bodies. Gamma fallback source time must not precede a known Sports state; an old cached response with a fresh receipt remains stale, not a new score.

## Deliverables

A reproducible tail-export command producing per-second CSV, compact full-depth snapshots, within-window raw/normalized changes, score/state changes, audit results, per-market quality summary and an offline viewer. Default is the game-end window; preview/manual ends, if supported, are explicitly unverified rather than actual finish. Output directories are new and manifests are published only after all output completes.

Use test-first implementation with a synthetic intra-second drop/rebound, disconnect/reconnect and score rollback; then process a finite real capture across actual match ends. Existing short journals must fail full-window coverage honestly. No live trading, remote push, paid data subscriptions or permanent monitoring deployment.
