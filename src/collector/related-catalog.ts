import { normalizeCollectorEvent, type CatalogDependencies } from "./catalog.js";
import type { CollectorEvent } from "./types.js";

export interface RelatedCatalogOptions {
  baseUrl?: string;
  pageSize?: number;
  maxPages?: number;
  now?: () => number;
}

function fail(code: string, message: string): never {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  throw error;
}

function validateOptions(options: RelatedCatalogOptions): string {
  for (const [name, value] of [["pageSize", options.pageSize], ["maxPages", options.maxPages]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      fail("RELATED_CATALOG_OPTIONS_INVALID", `${name} must be a positive safe integer`);
    }
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    fail("RELATED_CATALOG_OPTIONS_INVALID", "now must be a function");
  }
  const base = options.baseUrl === undefined ? "https://gamma-api.polymarket.com" : options.baseUrl;
  let url: URL;
  try {
    if (typeof base !== "string") throw new Error("Invalid base URL");
    url = new URL(base);
  } catch {
    fail("RELATED_CATALOG_OPTIONS_INVALID", "baseUrl must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.href.includes("?") || url.href.includes("#")) {
    fail("RELATED_CATALOG_OPTIONS_INVALID", "baseUrl must be HTTP(S) without a query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function timestamp(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) {
    fail("RELATED_CATALOG_OPTIONS_INVALID", "now must return a valid timestamp in milliseconds");
  }
  return new Date(value).toISOString();
}

async function requestPage(url: string, deps: CatalogDependencies, now: () => number): Promise<unknown> {
  const requestStartedAt = timestamp(now);
  let response: unknown;
  try {
    response = await deps.request(url);
  } catch (error) {
    const requestEndedAt = timestamp(now);
    deps.onRequest?.({ url, requestStartedAt, requestEndedAt, error });
    throw error;
  }
  const requestEndedAt = timestamp(now);
  deps.onRequest?.({ url, requestStartedAt, requestEndedAt, response });
  deps.onPage?.({ url, requestStartedAt, requestEndedAt, response });
  return response;
}

function normalizePage(response: unknown, gameId: string): { events: CollectorEvent[]; nextCursor: string | null } {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    fail("RELATED_CATALOG_RESPONSE_INVALID", `expected an events envelope for game ${gameId}`);
  }
  const raw = response as Record<string, unknown>;
  if (!Array.isArray(raw.events)) {
    fail("RELATED_CATALOG_RESPONSE_INVALID", `expected an events array for game ${gameId}`);
  }
  const cursor = raw.next_cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
    fail("RELATED_CATALOG_RESPONSE_INVALID", `invalid next_cursor for game ${gameId}`);
  }
  const events = raw.events.map((value, index) => {
    const event = normalizeCollectorEvent(value);
    if (!event) fail("RELATED_CATALOG_RESPONSE_INVALID", `invalid event at index ${index} for game ${gameId}`);
    if (event.gameId !== gameId) {
      fail("RELATED_CATALOG_GAME_ID_MISMATCH", `event ${event.eventId} has gameId ${event.gameId}; queried ${gameId}`);
    }
    return event;
  });
  return { events, nextCursor: cursor === undefined || cursor === null || cursor === "" ? null : cursor };
}

/** Expand only games present in the seeds; return only after every game explicitly ends pagination. */
export async function expandRelatedEvents(
  events: readonly CollectorEvent[],
  options: RelatedCatalogOptions,
  deps: CatalogDependencies
): Promise<CollectorEvent[]> {
  const base = validateOptions(options);
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 20;
  const now = options.now ?? Date.now;
  const expanded: CollectorEvent[] = [];
  const byId = new Map<string, CollectorEvent>();
  const bySlug = new Map<string, CollectorEvent>();
  const gameIds = new Set<string>();
  const addEvent = (event: CollectorEvent): void => {
    const idMatch = byId.get(event.eventId);
    const slugMatch = bySlug.get(event.eventSlug);
    for (const existing of [idMatch, slugMatch]) {
      if (existing && (existing.eventId !== event.eventId || existing.eventSlug !== event.eventSlug || existing.gameId !== event.gameId)) {
        fail("RELATED_CATALOG_IDENTITY_CONFLICT", `conflicting ID, slug, or gameId for event ${event.eventId} (${event.eventSlug})`);
      }
    }
    if (idMatch || slugMatch) return;
    byId.set(event.eventId, event);
    bySlug.set(event.eventSlug, event);
    expanded.push(event);
  };

  // Seed objects take precedence over matching responses, and conflicts fail before requesting data.
  for (const event of events) {
    addEvent(event);
    if (event.gameId !== null) gameIds.add(event.gameId);
  }

  for (const gameId of gameIds) {
    const params = new URLSearchParams({ game_id: gameId, limit: String(pageSize) });
    const seenCursors = new Set<string>();
    const seenPages = new Set<string>();
    for (let index = 0; ; index += 1) {
      if (index >= maxPages) {
        fail("RELATED_CATALOG_PAGINATION_LIMIT", `no explicit pagination end for game ${gameId} within ${maxPages} pages`);
      }
      const response = await requestPage(`${base}/events/keyset?${params}`, deps, now);
      const page = normalizePage(response, gameId);
      for (const event of page.events) addEvent(event);
      if (page.events.length > 0) {
        const signature = JSON.stringify(page.events.map((event) => event.eventId).sort());
        if (seenPages.has(signature)) {
          fail("RELATED_CATALOG_PAGINATION_STALLED", `repeated nonempty events page for game ${gameId}`);
        }
        seenPages.add(signature);
      }
      if (page.nextCursor === null) break;
      if (seenCursors.has(page.nextCursor)) {
        fail("RELATED_CATALOG_PAGINATION_STALLED", `repeated next_cursor for game ${gameId}`);
      }
      seenCursors.add(page.nextCursor);
      params.set("after_cursor", page.nextCursor);
    }
  }
  return expanded;
}
