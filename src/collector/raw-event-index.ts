import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { scanJournal } from "./journal-reader.js";
import { emptyReplayQuality } from "./replay-types.js";
import { metadataFromRecord } from "./tail-context.js";
import { allMarketsClosed, compactEventMetadata } from "./continuous-state.js";
import type { TailMetadata } from "./tail-types.js";

/**
 * One recovered event document, scored so a terminal copy cannot win.
 *
 * A raw run keeps every distinct `event_metadata` for an event, in journal
 * order: the discovery page while the market trades, then the reconciled
 * document after Gamma closes it. Only the trading-time copy describes the
 * market the tail actually captured. The terminal copy carries `closed: true`
 * on every market, and a replay seeded with it classifies each captured second
 * as resolved and drops the whole depth ladder - a silently empty archive.
 */
interface Candidate {
  shape: Record<string, unknown>;
  marketCount: number;
  allClosed: boolean;
  receivedAtMs: number;
}

/**
 * True when `candidate` describes the captured market better than `current`.
 *
 * Ordering is deliberate: preserving the live market shape beats everything,
 * because an all-closed document loses every second of depth. After that a
 * document covering more markets keeps more tokens attributable, and the
 * earliest copy is the trading-time shape the live path keeps as well.
 */
function preferred(candidate: Candidate, current: Candidate): boolean {
  if (candidate.allClosed !== current.allClosed) return !candidate.allClosed;
  if (candidate.marketCount !== current.marketCount) return candidate.marketCount > current.marketCount;
  return candidate.receivedAtMs < current.receivedAtMs;
}

function candidateFor(metadata: TailMetadata): Candidate {
  const shape = compactEventMetadata(metadata);
  const markets = Array.isArray(shape.markets) ? shape.markets : [];
  return { shape, marketCount: markets.length, allClosed: allMarketsClosed(shape), receivedAtMs: metadata.observedAtMs };
}

/**
 * Market identity for events seen in retained raw runs, keyed by both the
 * `game:<id>` and `event:<id>` spellings a compact match can use.
 *
 * Compact storage keeps order books and market identity separately, and the
 * identity column only exists for matches finalized after it was added. Raw
 * runs are pruned after `rawRunRetentionHours`, so this recovers what is still
 * on disk rather than guessing the rest.
 */
export async function loadRawEventIndex(runsRoot: string): Promise<Map<string, Record<string, unknown>>> {
  const index = new Map<string, Record<string, unknown>>();
  const best = new Map<string, Candidate>();
  const consider = (key: string, candidate: Candidate): void => {
    const current = best.get(key);
    if (current === undefined || preferred(candidate, current)) {
      best.set(key, candidate);
      index.set(key, candidate.shape);
    }
  };
  let entries: string[];
  try { entries = await readdir(runsRoot); } catch { return index; }
  for (const entry of entries) {
    const directory = join(runsRoot, entry);
    try {
      await scanJournal(directory, record => {
        if (record.source !== "gamma" || record.kind !== "event_metadata") return;
        // A single malformed or identity-conflicting document must not discard
        // every later event recovered from the same run.
        let metadata: TailMetadata | null = null;
        try { metadata = metadataFromRecord(record); } catch { return; }
        if (!metadata) return;
        const candidate = candidateFor(metadata);
        consider(`event:${metadata.eventId}`, candidate);
        if (metadata.gameId !== null) consider(`game:${metadata.gameId}`, candidate);
      }, emptyReplayQuality(), () => {});
    } catch {
      // A missing, active or damaged run simply contributes nothing.
    }
  }
  return index;
}
