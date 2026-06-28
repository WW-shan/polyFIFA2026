/**
 * Tier 3 step 1: for each FIFWC slug already used by the backtest, fetch the
 * FULL strategy-eligible market list from Polymarket. We later split this
 * universe into (a) markets already in the strategy candidates and (b) markets
 * that fail the lossRequiresGoals>=2 filter — the latter is the null universe.
 *
 * Reuses src/polymarket/event-page.ts so behavior matches the live bot.
 *
 * Output: data/event_markets_universe.json
 */
import { writeFile, readFile } from "node:fs/promises";
import { fetchEventStrategyMarkets } from "../src/polymarket/event-page.js";

interface Candidate {
  slug: string;
  conditionId: string;
}

interface UniverseRow {
  slug: string;
  conditionId: string;
  question: string;
  outcomes: string[];
  clobTokenIds: string[];
  marketType?: string;
  line?: number;
  team?: string;
  in_candidates: boolean;
}

const REPO = new URL("..", import.meta.url).pathname;

async function loadSlugsAndKnownIds(): Promise<{ slugs: string[]; known: Set<string> }> {
  const raw = await readFile(`${REPO}data/loss_requires2_strategy_candidates.json`, "utf8");
  const candidates = JSON.parse(raw) as Candidate[];
  const slugs = Array.from(new Set(candidates.map((c) => c.slug))).sort();
  const known = new Set(candidates.map((c) => c.conditionId).filter(Boolean));
  return { slugs, known };
}

async function fetchOne(slug: string, known: Set<string>): Promise<UniverseRow[]> {
  const markets = await fetchEventStrategyMarkets(slug);
  return markets.map((m) => {
    const row: UniverseRow = {
      slug,
      conditionId: m.conditionId,
      question: m.question,
      outcomes: m.outcomes,
      clobTokenIds: m.clobTokenIds,
      in_candidates: known.has(m.conditionId),
    };
    if (m.marketType !== undefined) row.marketType = m.marketType;
    if (m.line !== undefined) row.line = m.line;
    if (m.team !== undefined) row.team = m.team;
    return row;
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { slugs, known } = await loadSlugsAndKnownIds();
  console.log(`[fetch_event_markets] ${slugs.length} slugs, ${known.size} known conditionIds in candidates`);

  const out: UniverseRow[] = [];
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i]!;
    try {
      const rows = await fetchOne(slug, known);
      const nNew = rows.filter((r) => !r.in_candidates).length;
      console.log(`  [${i + 1}/${slugs.length}] ${slug}: ${rows.length} markets (${nNew} not in candidates)`);
      out.push(...rows);
    } catch (err) {
      console.error(`  [${i + 1}/${slugs.length}] ${slug}: FAIL ${(err as Error).message}`);
    }
    await sleep(400);
  }

  const path = `${REPO}data/event_markets_universe.json`;
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nwrote ${path}`);
  console.log(`  total markets: ${out.length}`);
  console.log(`  in candidates: ${out.filter((r) => r.in_candidates).length}`);
  console.log(`  control (not in candidates): ${out.filter((r) => !r.in_candidates).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
