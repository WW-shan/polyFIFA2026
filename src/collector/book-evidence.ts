import { objectValue } from "./replay-values.js";

export function finiteBookSize(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasActiveBookDepth(book: Record<string, unknown>): boolean {
  for (const side of ["bids", "asks"] as const) {
    const levels = book[side];
    if (!Array.isArray(levels)) continue;
    for (const raw of levels) {
      const size = finiteBookSize(objectValue(raw)?.size);
      if (size !== null && size > 0) return true;
    }
  }
  return false;
}

/**
 * Terminal match clearing arrives as a full book with no depth or as a
 * price-change batch that removes every level while publishing an empty top of
 * book. It is real evidence and must be stored, but it is not the last active
 * book second and therefore must not become the `book-quiet` finish anchor.
 */
export function isTerminalClearFrame(frame: Record<string, unknown>): boolean {
  if (frame.event_type === "book") return !hasActiveBookDepth(frame);
  if (frame.event_type !== "price_change" || !Array.isArray(frame.price_changes) || frame.price_changes.length === 0) return false;
  let sawClear = false;
  for (const raw of frame.price_changes) {
    const change = objectValue(raw);
    if (!change || finiteBookSize(change.size) !== 0) return false;
    if (finiteBookSize(change.best_bid) !== 0 || finiteBookSize(change.best_ask) !== 1) return false;
    sawClear = true;
  }
  return sawClear;
}

/** True when a CLOB frame is evidence that at least one side of the book has depth. */
export function frameMarksActiveBook(frame: Record<string, unknown>): boolean {
  if (frame.event_type === "book") return hasActiveBookDepth(frame);
  if (frame.event_type !== "price_change" || !Array.isArray(frame.price_changes) || frame.price_changes.length === 0) return false;
  return !isTerminalClearFrame(frame);
}

/**
 * Tokens with active depth in an HTTP `/books` response. The response index is
 * the fallback identity when the API omits `asset_id`; otherwise a valid
 * snapshot would be recorded but could never anchor a quiet finish.
 */
export function activeSnapshotTokens(data: Record<string, unknown> | undefined,
  fallbackTokens: readonly string[] = []): Set<string> {
  const result = new Set<string>();
  const response = data?.response;
  const books = Array.isArray(response) ? response : response === undefined ? [] : [response];
  for (const [index, raw] of books.entries()) {
    const book = objectValue(raw);
    if (book === undefined || !hasActiveBookDepth(book)) continue;
    const token = typeof book.asset_id === "string" && book.asset_id.length > 0 ? book.asset_id
      : typeof data?.tokenId === "string" && data.tokenId.length > 0 ? data.tokenId
        : fallbackTokens[index];
    if (typeof token === "string" && token.length > 0) result.add(token);
  }
  return result;
}

function parsedFrames(data: unknown): unknown[] {
  let value = data;
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return []; }
  }
  return Array.isArray(value) ? value : [value];
}

function frameTokens(frame: Record<string, unknown>): Set<string> {
  const tokens = new Set<string>();
  if (typeof frame.asset_id === "string") tokens.add(frame.asset_id);
  if (Array.isArray(frame.price_changes)) {
    for (const raw of frame.price_changes) {
      const token = objectValue(raw)?.asset_id;
      if (typeof token === "string") tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Whether a stored record contains active book evidence for one of the game's
 * tokens. Used by offline repair so old `book-quiet` boundaries can be moved
 * off the terminal clearing frame without trusting foreign frames in a legacy
 * batch.
 */
export function recordMarksActiveBook(data: unknown, ownTokens: ReadonlySet<string>): boolean {
  for (const raw of parsedFrames(data)) {
    const frame = objectValue(raw);
    if (frame === undefined) continue;
    if (frame.response !== undefined) {
      const response = frame.response;
      const books = Array.isArray(response) ? response : [response];
      const fallback = Array.isArray(frame.tokenIds) ? frame.tokenIds : [];
      for (const [index, bookRaw] of books.entries()) {
        const book = objectValue(bookRaw);
        if (book === undefined || !hasActiveBookDepth(book)) continue;
        const token = typeof book.asset_id === "string" && book.asset_id.length > 0 ? book.asset_id
          : typeof frame.tokenId === "string" && frame.tokenId.length > 0 ? frame.tokenId
            : typeof fallback[index] === "string" ? fallback[index] as string : undefined;
        if (token !== undefined && ownTokens.has(token)) return true;
      }
      continue;
    }
    const tokens = frameTokens(frame);
    if ([...tokens].some(token => ownTokens.has(token)) && frameMarksActiveBook(frame)) return true;
  }
  return false;
}
