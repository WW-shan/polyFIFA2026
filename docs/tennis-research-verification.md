# Tennis research verification

Verified 2026-09-12 (Asia/Shanghai), against the tennis-research worktree based on `9594f84`.

## Automated checks

```sh
npm test
npm run typecheck
git diff --check
git diff --cached --check
```

Latest full result: **46 test files, 866 tests passed**; typecheck and both diff checks passed. Public-data calls are separate finite acceptance checks, not hidden network dependencies of the unit tests.

Regression coverage includes tennis +7-day metadata expiry, CLI/runtime propagation, live/unknown scheduled starts, strict token/outcome mappings, payout conservation and provenance, duplicate identities, time-window pagination, malformed and nonmonotonic observations, incomplete history, same-second ordering, payout-independent side selection, partial fills, queue/equality scenarios, fees, missing/void/losing samples, fixed price-trigger lifetime, CSV safety, input hashes and no-overwrite.

## Independent review and repairs

The collector slice passed independent spec review. The research slice was independently inspected against the requirements, then reviewed for code quality in separate data/transport and model/report/collector scopes. All material findings below were reproduced with failing tests, fixed, and re-reviewed; there are no outstanding findings in those scopes.

| Finding | Fix and regression |
| --- | --- |
| Price-trigger entry was censored by the eventual finish label | Entry no longer consults finish; moving the finish to signal +1 second preserves entry, outcome and expiry. `tests/research/backtest.test.ts`. |
| HTTP/JSON error responses lost their bodies | `fetchHttpResponseText` preserves status, headers and decoded text before interpretation; 429 and malformed-200 responses are cached. Existing `fetchJson` error behavior is unchanged. `tests/polymarket/http.test.ts`, `tests/research/download.test.ts`. |
| Recording failures could publish a complete manifest | Recording errors propagate fatally; no success manifest is published. `tests/research/download.test.ts`. |
| Download wrapper lost explicit direct routing and bypassed NO_PROXY | Preserve undefined versus empty-string proxy options; let the owned transport resolve environment settings. Both cases exercise the default transport against a local HTTP server. `tests/research/download.test.ts`. |

Raw HTTP timeout/caller cancellation and transport cleanup are tested alongside successful and error-body reads. Proxy regressions were verified as failures before the wrapper fix and passed afterward.

## Real public evidence

- Initial historical batch: 30 matches, 493 markets, 12,978 trades, zero incomplete market windows. Bounded selection, exclusions and raw replies are retained under `data/research/tennis-20260911-v1/`.
- Default raw-text transport follow-up: one closed moneyline, 2,462 trades; all four real requests retained HTTP status/headers/text plus parsed JSON. Evidence: `data/research/tennis-http-evidence-20260912/`.
- Finite live collection: 90 seconds, 23,404 journal records, 44,978 reconstructed quotes, 37 trades, 69 Sports rows. Sequence/format/book-update/out-of-order checks were clean. One connection invalidation coincides with deliberate normal shutdown. Evidence: `data/collector/tennis-research-20260911/`.
- `backtest-tail/` and `backtest-trigger-reviewed/` input hashes match the original dataset. Recomputing each report reproduces all **15,776 scenario trials** exactly. These are alternative scenarios, not that many independent matches or live orders.
- The original `backtest-trigger/` is preserved for traceability but superseded by `backtest-trigger-reviewed/`. The finish-label correction changes 224 submarket scenario rows, all post-finish first triggers, without changing the moneyline results or any finish-relative trial.

See [the research report](tennis-research-2026-09-11.md) for observed price paths, commands and limitations. Historical trade exhaustion is not historical L2 completeness or proof of own fills. Complete-game collection, point/server state, subperiod end labels and queue-level journal backtesting are not claimed as completed.

No trading credentials were used, no orders were submitted, no permanent collector was deployed, and no remote push was performed. All finite data processes completed and stopped.

## Local integration

Implementation commit `08daa12` was fast-forwarded to local `main`. The merged project was reverified: **46 files / 866 tests passed**, typecheck and diff check passed. Existing untracked `docs/collector-data-goal.md` and `docs/sports-opportunity-research-assessment.md` were preserved. Raw data and generated research reports remain under the main project's ignored `data/research/` and `data/collector/` directories.
