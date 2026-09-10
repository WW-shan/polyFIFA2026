import type { CollectorEvent, CollectorMarket, JsonRequester } from "./types.js";

export interface CatalogOptions {
  baseUrl?: string;
  tagId?: string;
  sports?: string[];
  eventSlugs?: string[];
  lookbackHours?: number;
  aheadHours?: number;
  allOpen?: boolean;
  pageSize?: number;
  maxPages?: number;
  now?: () => number;
}

export interface CatalogDependencies {
  request: JsonRequester;
  onPage?: (page: { url: string; requestStartedAt: string; requestEndedAt?: string; response: unknown }) => void;
  onRequest?: (request: { url: string; requestStartedAt: string; requestEndedAt: string; response?: unknown; error?: unknown }) => void;
}

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const HOUR_MS = 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return nonemptyString(value);
}

function stringArray(value: unknown): string[] | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  // Numeric token IDs may already have lost precision during JSON parsing.
  if (!Array.isArray(parsed) || !parsed.every((item) => nonemptyString(item) !== null)) return null;
  return [...parsed] as string[];
}

function normalizeMarket(value: unknown, eventUnavailable: boolean): CollectorMarket | null {
  const raw = record(value);
  if (!raw) return null;
  const marketId = identifier(raw.id);
  const conditionId = nonemptyString(raw.conditionId);
  const outcomes = stringArray(raw.outcomes);
  const tokenIds = stringArray(raw.clobTokenIds);
  if (!marketId || !conditionId || !outcomes || !tokenIds || outcomes.length < 2 || tokenIds.length !== outcomes.length) return null;
  const marketSlug = nonemptyString(raw.slug) ?? marketId;
  const closed = raw.closed === true;
  return {
    marketId,
    conditionId,
    marketSlug,
    question: nonemptyString(raw.question) ?? marketSlug,
    outcomes,
    tokenIds,
    closed,
    collectable: !eventUnavailable && !closed && raw.archived !== true && raw.enableOrderBook !== false,
    raw
  };
}

export function normalizeCollectorEvent(value: unknown): CollectorEvent | null {
  const raw = record(value);
  if (!raw) return null;
  const eventId = identifier(raw.id);
  const eventSlug = nonemptyString(raw.slug);
  if (!eventId || !eventSlug) return null;
  const eventUnavailable = raw.closed === true || raw.archived === true;
  const markets: CollectorMarket[] = [];
  for (const value of Array.isArray(raw.markets) ? raw.markets : []) {
    const market = normalizeMarket(value, eventUnavailable);
    if (market) markets.push(market);
  }
  const tags: string[] = [];
  for (const value of Array.isArray(raw.tags) ? raw.tags : []) {
    const slug = nonemptyString(record(value)?.slug);
    if (slug) tags.push(slug);
  }
  return {
    eventId,
    eventSlug,
    title: nonemptyString(raw.title) ?? eventSlug,
    tags,
    sport: nonemptyString(raw.sport) ?? nonemptyString(record(raw.sport)?.sport),
    gameId: identifier(raw.gameId) ?? identifier(record(raw.eventMetadata)?.gameId),
    parentEventId: identifier(raw.parentEventId),
    markets,
    raw
  };
}

function baseUrl(value = GAMMA_BASE_URL): string {
  return value.replace(/\/+$/, "");
}

async function requestPage(url: string, deps: CatalogDependencies, now: () => number): Promise<unknown> {
  const requestStartedAt = new Date(now()).toISOString();
  try {
    const response = await deps.request(url);
    const requestEndedAt = new Date(now()).toISOString();
    deps.onRequest?.({ url, requestStartedAt, requestEndedAt, response });
    deps.onPage?.({ url, requestStartedAt, requestEndedAt, response });
    return response;
  } catch (error) {
    const requestEndedAt = new Date(now()).toISOString();
    deps.onRequest?.({ url, requestStartedAt, requestEndedAt, error });
    throw error;
  }
}

async function eventBySlug(slug: string, deps: CatalogDependencies, base: string, now: () => number): Promise<CollectorEvent> {
  if (!nonemptyString(slug)) throw new Error("CATALOG_OPTIONS_INVALID: event slugs must not be blank");
  const url = `${base}/events/slug/${encodeURIComponent(slug.trim())}`;
  const response = await requestPage(url, deps, now);
  const event = normalizeCollectorEvent(response);
  if (!event) throw new Error(`CATALOG_RESPONSE_INVALID: invalid event for slug ${slug}`);
  return event;
}

export async function fetchCollectorEvent(slug: string, deps: CatalogDependencies, url?: string): Promise<CollectorEvent> {
  return eventBySlug(slug, deps, baseUrl(url), Date.now);
}

function validateOptions(options: CatalogOptions): void {
  for (const [name, value] of [["pageSize", options.pageSize], ["maxPages", options.maxPages]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`CATALOG_OPTIONS_INVALID: ${name} must be a positive integer`);
    }
  }
  for (const [name, value] of [["lookbackHours", options.lookbackHours], ["aheadHours", options.aheadHours]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`CATALOG_OPTIONS_INVALID: ${name} must be finite and nonnegative`);
    }
  }
  if (options.eventSlugs?.some((slug) => !nonemptyString(slug))) {
    throw new Error("CATALOG_OPTIONS_INVALID: event slugs must not be blank");
  }
}

function responseEvents(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  const events = record(response)?.events;
  if (Array.isArray(events)) return events;
  throw new Error("CATALOG_RESPONSE_INVALID: expected an events array");
}

function pageSignature(page: unknown[]): string {
  // Identify repeated pages even if live volume changes or the API reorders them.
  return JSON.stringify(page.map((value) => {
    const raw = record(value);
    const id = identifier(raw?.id);
    if (id) return `id:${id}`;
    const slug = nonemptyString(raw?.slug);
    return slug ? `slug:${slug}` : JSON.stringify(value);
  }).sort());
}

export async function discoverSportsEvents(options: CatalogOptions, deps: CatalogDependencies): Promise<CollectorEvent[]> {
  validateOptions(options);
  const base = baseUrl(options.baseUrl);
  const now = options.now ?? Date.now;
  const events: CollectorEvent[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  const addEvent = (event: CollectorEvent | null): void => {
    if (!event || seenIds.has(event.eventId) || seenSlugs.has(event.eventSlug)) return;
    seenIds.add(event.eventId);
    seenSlugs.add(event.eventSlug);
    events.push(event);
  };

  if (options.eventSlugs?.length) {
    for (const slug of new Set(options.eventSlugs.map((value) => value.trim()))) {
      addEvent(await eventBySlug(slug, deps, base, now));
    }
    return events;
  }

  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 200;
  const params = new URLSearchParams({
    tag_id: options.tagId ?? "100639",
    closed: "false",
    limit: String(pageSize),
    offset: "0",
    order: "id",
    ascending: "true"
  });
  if (!options.allOpen) {
    // Gamma end dates are metadata dates, not observed finish clocks.
    const current = now();
    params.set("end_date_min", new Date(current - (options.lookbackHours ?? 48) * HOUR_MS).toISOString());
    params.set("end_date_max", new Date(current + (options.aheadHours ?? 24) * HOUR_MS).toISOString());
  }
  const sports = new Set((options.sports ?? []).map((sport) => sport.trim().toLowerCase()).filter(Boolean));
  const seenPages = new Set<string>();
  for (let index = 0; index < maxPages; index += 1) {
    params.set("offset", String(index * pageSize));
    const response = await requestPage(`${base}/events?${params}`, deps, now);
    const page = responseEvents(response);
    if (page.length > 0) {
      const signature = pageSignature(page);
      if (seenPages.has(signature)) throw new Error("CATALOG_PAGINATION_STALLED: repeated nonempty events page");
      seenPages.add(signature);
    }
    for (const raw of page) addEvent(normalizeCollectorEvent(raw));
    if (page.length < pageSize) {
      return events.filter((event) => sports.size === 0 || [event.sport, ...event.tags].some(
        (sport) => sport !== null && sports.has(sport.trim().toLowerCase())
      ));
    }
  }
  throw new Error(`CATALOG_PAGINATION_LIMIT: no short page within ${maxPages} pages`);
}

export function collectableTokenIds(events: readonly CollectorEvent[]): string[] {
  const tokens = new Set<string>();
  for (const event of events) {
    for (const market of event.markets) {
      if (market.collectable) {
        for (const tokenId of market.tokenIds) tokens.add(tokenId);
      }
    }
  }
  return [...tokens];
}
