import { createHash } from "node:crypto";
import type { JournalRecord } from "./types.js";
import type { ReplayQuoteRow } from "./replay-types.js";
import type { TailAuditBook, TailSnapshotAudit } from "./tail-types.js";
import { decimal, levelMap, objectValue, sortedLevels, timestamp } from "./replay-values.js";

export function sourceMilliseconds(value: unknown): number | null {
  const parsed = timestamp(value);
  return parsed !== undefined && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}
function hash(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return /^(0x)?[0-9a-f]{32,}$/i.test(value) ? value.replace(/^0x/i, "").toLowerCase() : value;
}
function fingerprint(bids: unknown, asks: unknown): string | null {
  const bidLevels = levelMap(bids), askLevels = levelMap(asks);
  if (!bidLevels || !askLevels) return null;
  const levels = [sortedLevels(bidLevels, true), sortedLevels(askLevels, false)]
    .map(side => side.map(level => [decimal(level.price, true)!.key, decimal(level.size)!.key]));
  return createHash("sha256").update(JSON.stringify(levels)).digest("hex");
}
export function auditBook(quote: ReplayQuoteRow): TailAuditBook {
  const value = fingerprint(quote.bids, quote.asks);
  if (value === null) throw new Error("TAIL_AUDIT_INVALID_REPLAY_BOOK");
  return { tokenId: quote.tokenId, sequence: quote.sequence, frameIndex: quote.frameIndex??0, observedAtMs: quote.receivedAtMs, sourceAtMs: sourceMilliseconds(quote.serverTimestamp),
    hash: hash(quote.bookHash), fingerprint: value };
}
export function auditSnapshot(record: JournalRecord, books: readonly TailAuditBook[], windowKey: string, checkedAtMs = record.receivedAtMs): TailSnapshotAudit {
  const data = objectValue(record.data), response = objectValue(data?.response);
  const tokenId = typeof data?.tokenId === "string" ? data.tokenId : "";
  const snapshotAtMs = sourceMilliseconds(response?.timestamp);
  const result: TailSnapshotAudit = { windowKey, tokenId, sequence: record.sequence, observedAtMs: record.receivedAtMs, checkedAtMs,
    snapshotAtMs, websocketAtMs: null, status: "not_comparable", basis: "none", reason: "no-comparable-websocket-state" };
  const value = fingerprint(response?.bids, response?.asks);
  if (!tokenId || !response || response.asset_id !== tokenId || value === null ||
      (response.timestamp !== undefined && snapshotAtMs === null)) {
    return { ...result, status: "invalid_snapshot", reason: "invalid-snapshot-identity-levels-or-time" };
  }
  const candidates = books.filter(book => book.tokenId === tokenId && book.observedAtMs <= checkedAtMs);
  const sourceHash = hash(response.hash);
  const sameHash = sourceHash === null ? [] : candidates.filter(book => book.hash === sourceHash);
  if (sameHash.length) {
    // One exchange batch can publish several fragments with its final hash.
    // Only its latest reconstructed version is comparable to the full snapshot.
    const candidate=sameHash.at(-1)!;
    const mismatch = candidate.fingerprint !== value;
    return { ...result, websocketAtMs: candidate.sourceAtMs, websocketSequence: candidate.sequence, websocketFrameIndex: candidate.frameIndex, basis: "hash",
      status: mismatch ? "mismatch" : "match", reason: mismatch ? "same-hash-depth-mismatch" : "same-hash-depth-agreement" };
  }
  const sameTime = snapshotAtMs === null ? [] : candidates.filter(book => book.sourceAtMs === snapshotAtMs && (sourceHash === null || book.hash === null));
  const match = sameTime.find(book => book.fingerprint === value);
  if (match) return { ...result, websocketAtMs: match.sourceAtMs, websocketSequence: match.sequence, websocketFrameIndex: match.frameIndex, basis: "source_timestamp", status: "match", reason: "same-source-time-depth-agreement" };
  // Multiple updates may share a millisecond. Distinct hashes or unequal
  // same-time states alone do not prove loss; do not overwrite the WS book.
  return { ...result, reason: sameTime.length ? "same-time-order-ambiguous" : result.reason };
}
