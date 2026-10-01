/**
 * Build a Gamma/CLOB settlement cache for every finalized compact tail.
 *
 * The sandbox used by the coding agent has no network, so this script is meant
 * to be run by the operator (or from a session with network enabled):
 *
 *   node --import tsx tools/settlement-cache.mts \
 *     --out data/research/settlements/gamma-latest.json \
 *     --proxy-url http://127.0.0.1:10808
 *
 * Each match is exported to a throwaway archive, settled against the public
 * endpoints, then deleted; only the settlement vectors are kept. The output is
 * the same shape the backtest CLI accepts through --fetch-settlements, so it
 * can be re-used without hitting the network again.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openCompactTailStore } from '../src/collector/continuous-tail-store.js';
import { exportCompactMatch } from '../src/collector/compact-export.js';
import { loadTailArchive } from '../src/research/tail-backtest-io.js';
import { collectTailSettlements } from '../src/research/tail-backtest-io.js';
import type { TailSettlement } from '../src/research/tail-backtest-types.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const dataRoot = resolve(argument('--data-root') ?? 'data/collector/continuous');
const outPath = resolve(argument('--out') ?? 'data/research/settlements/gamma-latest.json');
const proxyUrl = argument('--proxy-url');
const limit = argument('--limit') ? Number(argument('--limit')) : Infinity;
if (!Number.isFinite(limit) && limit !== Infinity) throw new Error('--limit must be a number');

const store = await openCompactTailStore({ dataRoot, tailWindowMs: 181_000, bufferMs: 30_000,
  retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3, readOnly: true });
const matches = store.listFinalizedMatches().slice(0, limit);
const settlements = new Map<string, TailSettlement>();
const errors: Array<{ gameKey: string; error: string }> = [];
const root = await mkdtemp(join(tmpdir(), 'settlement-cache-'));
let done = 0;
try {
  for (const match of matches) {
    const safe = match.gameKey.replace(/[^A-Za-z0-9._-]+/g, '_');
    const dir = join(root, safe), work = join(root, 'w-' + safe);
    try {
      await exportCompactMatch(store, match.gameKey, { outputDirectory: dir, workDirectory: work });
      const { input } = await loadTailArchive(dir);
      const collected = await collectTailSettlements([input], { ...(proxyUrl ? { proxyUrl } : {}) });
      for (const row of collected.settlements) settlements.set(JSON.stringify([row.conditionId, row.marketId, row.tokenId]), row);
      for (const error of collected.errors) errors.push({ gameKey: match.gameKey, error });
    } catch (error) {
      errors.push({ gameKey: match.gameKey, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${matches.length} settlements=${settlements.size} errors=${errors.length}`);
  }
} finally {
  store.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({ schemaVersion: 1, kind: 'gamma-settlement-cache',
  observedAtMs: Date.now(), matches: done, errors, settlements: [...settlements.values()] }, null, 1));
console.log(`done matches=${done} settlements=${settlements.size} errors=${errors.length} -> ${outPath}`);
