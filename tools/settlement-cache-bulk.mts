/**
 * Bulk Gamma settlement cache for the compact tail store.
 *
 *   node --import tsx tools/settlement-cache-bulk.mts \
 *     --out data/research/settlements/gamma-bulk.json \
 *     --proxy-url http://127.0.0.1:10808
 *
 * Reads every market the store knows, asks Gamma in batches of condition ids,
 * and records the resolved payout vector (1/0 per token) for markets that are
 * closed and settled. Markets that are not settled yet are counted but not
 * written, so the file can be merged with a later run.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fetchHttpResponseText } from '../src/polymarket/http.js';
import { resolvePayouts } from '../src/research/history.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const dataRoot = resolve(argument('--data-root') ?? 'data/collector/continuous');
const outPath = resolve(argument('--out') ?? 'data/research/settlements/gamma-bulk.json');
const proxyUrl = argument('--proxy-url');
const batchSize = Number(argument('--batch') ?? 40);
const concurrency = Number(argument('--concurrency') ?? 4);

const db = new DatabaseSync(join(dataRoot, 'tail.sqlite'), { readOnly: true });
const markets = new Map<string, { conditionId: string; tokenIds: string[]; marketType: string }>();
for (const row of db.prepare('SELECT metadata_json FROM matches').all() as Array<{ metadata_json: string | null }>) {
  let meta: any; try { meta = JSON.parse(row.metadata_json ?? '{}'); } catch { continue; }
  for (const mk of meta.markets ?? []) {
    let ids = mk.clobTokenIds;
    if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
    if (!mk.conditionId || !Array.isArray(ids) || ids.length < 2) continue;
    markets.set(String(mk.conditionId), { conditionId: String(mk.conditionId), tokenIds: ids.map(String), marketType: String(mk.sportsMarketType ?? '') });
  }
}
db.close();
const conditions = [...markets.keys()];
console.log('markets:', conditions.length, 'batch:', batchSize, 'concurrency:', concurrency);

const settlements = new Map<string, { conditionId: string; tokenId: string; payout: number; source: string }>();
const errors: string[] = [];
let notSettled = 0, returned = 0, batches = 0;
const batchesList: string[][] = [];
for (let i = 0; i < conditions.length; i += batchSize) batchesList.push(conditions.slice(i, i + batchSize));

async function runBatch(batch: string[]): Promise<void> {
  const query = batch.map(id => 'condition_ids=' + encodeURIComponent(id)).join('&');
  const url = `https://gamma-api.polymarket.com/markets?${query}&limit=${batch.length}`;
  try {
    const response = await fetchHttpResponseText(url, { timeoutMs: 30_000, ...(proxyUrl ? { proxyUrl } : {}) });
    if (response.status < 200 || response.status >= 300) throw new Error('HTTP ' + response.status);
    const rows = JSON.parse(response.body) as Array<Record<string, unknown>>;
    returned += rows.length;
    for (const raw of rows) {
      const conditionId = String(raw.conditionId ?? '');
      const known = markets.get(conditionId);
      if (!known) continue;
      const payouts = resolvePayouts(raw, known.tokenIds.length);
      if (!payouts) { notSettled++; continue; }
      for (let i = 0; i < known.tokenIds.length; i++) {
        settlements.set(known.tokenIds[i]!, { conditionId, tokenId: known.tokenIds[i]!, payout: payouts[i]!, source: 'gamma-resolved-prices' });
      }
    }
  } catch (error) { errors.push(String(error).slice(0, 160)); }
  batches++;
  if (batches % 25 === 0) console.log(`  batches=${batches}/${batchesList.length} markets returned=${returned} settledTokens=${settlements.size} notSettled=${notSettled} errors=${errors.length}`);
}

let cursor = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < batchesList.length) {
    const batch = batchesList[cursor++]!;
    await runBatch(batch);
  }
}));

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({ schemaVersion: 1, kind: 'gamma-settlement-cache',
  observedAtMs: Date.now(), conditions: conditions.length, errors, settlements: [...settlements.values()] }, null, 1));
console.log(`done conditions=${conditions.length} settledTokens=${settlements.size} notSettledMarkets=${notSettled} errors=${errors.length} -> ${outPath}`);
