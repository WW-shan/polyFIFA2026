/**
 * Settlement cache from the public CLOB market endpoint.
 *
 *   node --import tsx tools/settlement-cache-clob.mts \
 *     --out data/research/settlements/clob-latest.json \
 *     --proxy-url http://127.0.0.1:10808 --concurrency 30
 *
 * Gamma stops listing older sports markets, but CLOB keeps every market with
 * its per-token winner flag, so this walks the store's condition ids directly.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fetchHttpResponseText } from '../src/polymarket/http.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const dataRoot = resolve(argument('--data-root') ?? 'data/collector/continuous');
const outPath = resolve(argument('--out') ?? 'data/research/settlements/clob-latest.json');
const proxyUrl = argument('--proxy-url');
const concurrency = Number(argument('--concurrency') ?? 30);

const db = new DatabaseSync(join(dataRoot, 'tail.sqlite'), { readOnly: true });
const markets = new Map<string, { tokenIds: string[]; marketId: string; type: string }>();
for (const row of db.prepare('SELECT metadata_json FROM matches').all() as Array<{ metadata_json: string | null }>) {
  let meta: any; try { meta = JSON.parse(row.metadata_json ?? '{}'); } catch { continue; }
  for (const mk of meta.markets ?? []) {
    let ids = mk.clobTokenIds;
    if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
    if (!mk.conditionId || !Array.isArray(ids) || ids.length < 2) continue;
    markets.set(String(mk.conditionId), { tokenIds: ids.map(String), marketId: String(mk.id ?? ''), type: String(mk.sportsMarketType ?? '') });
  }
}
db.close();
const conditions = [...markets.keys()];
console.log('markets to resolve:', conditions.length, 'concurrency:', concurrency);

const settlements: Array<{ conditionId: string; marketId: string; tokenId: string; payout: number; source: string }> = [];
const errors: Array<{ conditionId: string; error: string }> = [];
let done = 0, closed = 0, voided = 0;
const t0 = Date.now();

async function resolveOne(conditionId: string): Promise<void> {
  const known = markets.get(conditionId)!;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchHttpResponseText(`https://clob.polymarket.com/markets/${conditionId}`, { timeoutMs: 20_000, ...(proxyUrl ? { proxyUrl } : {}) });
      if (response.status === 404) { errors.push({ conditionId, error: 'not found' }); return; }
      if (response.status < 200 || response.status >= 300) throw new Error('HTTP ' + response.status);
      const raw = JSON.parse(response.body) as Record<string, any>;
      if (raw.condition_id !== conditionId) throw new Error('condition mismatch');
      if (raw.closed !== true) { errors.push({ conditionId, error: 'not closed' }); return; }
      const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
      const ids = tokens.map((t: any) => String(t?.token_id));
      if (ids.length !== known.tokenIds.length || !ids.every((id: string, i: number) => id === known.tokenIds[i])) {
        // the archive order can differ; fall back to a set comparison
        if (![...ids].sort().every((id, i) => id === [...known.tokenIds].sort()[i])) throw new Error('token mismatch');
      }
      const winners = tokens.map((t: any) => t?.winner === true);
      const winning = winners.filter(Boolean).length;
      if (winning !== 1) {
        if (winning === 0) { voided++; for (const tokenId of known.tokenIds) settlements.push({ conditionId, marketId: known.marketId, tokenId, payout: 0.5, source: 'clob-voided' }); return; }
        throw new Error('ambiguous winner flags');
      }
      closed++;
      for (const token of tokens) settlements.push({ conditionId, marketId: known.marketId, tokenId: String(token.token_id), payout: token.winner === true ? 1 : 0, source: 'clob-winner-flags' });
      return;
    } catch (error) {
      if (attempt === 2) errors.push({ conditionId, error: String(error).slice(0, 120) });
      else await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

let cursor = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < conditions.length) {
    const id = conditions[cursor++]!;
    await resolveOne(id);
    done++;
    if (done % 2000 === 0) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  ${done}/${conditions.length} settled=${settlements.length} voided=${voided} errors=${errors.length} elapsed=${mins}min`);
    }
  }
}));

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({ schemaVersion: 1, kind: 'clob-settlement-cache', observedAtMs: Date.now(),
  conditions: conditions.length, closed, voided, errors, settlements }, null, 1));
console.log(`done ${done}/${conditions.length} tokens=${settlements.length} closed=${closed} voided=${voided} errors=${errors.length} -> ${outPath}`);
