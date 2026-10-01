# Late-game shadow monitor implementation plan

Spec: `docs/superpowers/specs/2026-09-28-late-game-shadow-monitor-design.md`

## Steps

1. **Model export + golden fixture (RED/GREEN)**
   - Add `tools/research/export_late_score_model.py` reusing
     `late_score_walk_forward.fit/fit_row/load_games`; write artifact JSON.
   - Generate `data/research/models/late-score-nfl.json` and a committed
     golden fixture in `tests/fixtures/shadow/` whose probabilities are
     computed by the Python implementation.
2. **Model module** `src/research/shadow/model.ts`
   - `parseLateScoreModel`, `lateScoreFeatures`, `predictHomeProbability`,
     `evaluateLateScoreSignal`, `walkBook`.
   - Tests in `tests/research/shadow/model.test.ts`.
3. **ESPN module** `src/research/shadow/espn.ts`
   - `parseScoreboard`, `findScoreboardGame`, `parseSummaryLastPlay`,
     team matching. Real trimmed fixtures captured 2026-09-28.
   - Tests in `tests/research/shadow/espn.test.ts`.
4. **Link + market module** `src/research/shadow/market.ts`
   - Gamma discovery reuse via `discoverSportsEvents`; moneyline selection;
     ESPN/Poly name matching; book fetch via `fetchJson` + `normalizeOrderbook`;
     `walkBook` fill.
   - Tests in `tests/research/shadow/market.test.ts`.
5. **Monitor loop** `src/research/shadow/monitor.ts`
   - discovery cadence, per-game poll, evaluation, follow-ups, settlement,
     NDJSON records. Pure `tick` for tests.
   - Tests in `tests/research/shadow/monitor.test.ts`.
6. **CLI** `src/research/shadow/cli.ts` + npm scripts
   - `--league`, `--model`, `--out`, `--proxy-url`, `--interval-ms`,
     `--once`, `--duration-minutes`, `--print`.
   - Tests in `tests/research/shadow/cli.test.ts`.
7. **Isolation test** `tests/research/shadow/isolation.test.ts`
   - forbidden imports; also assert the run-start record declares shadow-only.
8. **Docs + dry run**
   - `tools/research/README.md`, main `README.md`, npm scripts.
   - Pre-game dry run against the 2026-09-29 Eagles/Bears event.
9. **Verify**
   - `npm run typecheck`, `npm test`, `npm run paper:fixture`,
     ledger hash unchanged.
