import { inflateSync, unzipSync } from "node:zlib";
import type { SpreadMarket } from "../domain/types.js";
import { fetchText } from "./http.js";

export async function fetchEventSpreadMarkets(eventSlug: string): Promise<SpreadMarket[]> {
  const html = await fetchText(`https://polymarket.com/sports/world-cup/${encodeURIComponent(eventSlug)}`);
  const payload = extractNextInitialState(html);
  const state = decodeInitialStatePayload(payload);
  return findSpreadMarkets(state, eventSlug);
}

export function extractNextInitialState(html: string): string {
  const scriptMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!scriptMatch?.[1]) {
    throw new Error("NEXT_DATA_SCRIPT_NOT_FOUND");
  }

  const nextData = JSON.parse(scriptMatch[1]) as unknown;
  const initialState = getPath(nextData, ["props", "pageProps", "initialState"]);
  if (typeof initialState !== "string" || initialState.length === 0) {
    throw new Error("INITIAL_STATE_NOT_FOUND");
  }
  return initialState;
}

export function decodeInitialStatePayload(payload: string): unknown {
  const compressed = Buffer.from(payload, "base64");
  const inflated = inflateOrUnzip(compressed).toString("utf8");
  return JSON.parse(inflated) as unknown;
}

export function findSpreadMarkets(state: unknown, eventSlug?: string): SpreadMarket[] {
  const markets: SpreadMarket[] = [];

  walk(state, (value) => {
    const market = normalizeSpreadMarket(value, eventSlug);
    if (market) markets.push(market);
  });

  return dedupeMarkets(markets);
}

export function normalizeSpreadMarket(value: unknown, eventSlug?: string): SpreadMarket | null {
  if (!isRecord(value)) return null;

  const type = stringValue(value.sportsMarketType ?? value.sports_market_type ?? value.marketType);
  if (type && type.toLowerCase() !== "spreads") return null;
  if (!type && !String(value.question ?? "").toLowerCase().includes("spread")) return null;

  const question = stringValue(value.question ?? value.title ?? value.name);
  const marketSlug = stringValue(value.marketSlug ?? value.slug);
  const conditionId = stringValue(value.conditionId ?? value.condition_id);
  const outcomes = stringArray(value.outcomes);
  const clobTokenIds = stringArray(value.clobTokenIds ?? value.clob_token_ids ?? value.tokenIds);
  const resolvedEventSlug = stringValue(value.eventSlug ?? value.event_slug ?? value.gameSlug) ?? eventSlug;
  const parsedLine = numberValue(value.line ?? value.spreadLine ?? value.spread) ?? (question ? parseSpreadLine(question) : null);

  if (!question || !marketSlug || !conditionId || !resolvedEventSlug || parsedLine === null) return null;
  if (eventSlug && resolvedEventSlug !== eventSlug) return null;
  if (outcomes.length < 2 || clobTokenIds.length < 2) return null;

  const market: SpreadMarket = {
    eventSlug: resolvedEventSlug,
    marketSlug,
    question,
    conditionId,
    clobTokenIds,
    outcomes,
    line: parsedLine
  };

  const tickSize = tickSizeValue(value.tickSize ?? value.tick_size);
  if (tickSize) market.tickSize = tickSize;
  if (typeof value.negRisk === "boolean") market.negRisk = value.negRisk;
  if (typeof value.neg_risk === "boolean") market.negRisk = value.neg_risk;

  return market;
}

export function parseSpreadLine(text: string): number | null {
  const match = text.match(/\(([+-]?\d+(?:\.\d+)?)\)/);
  return match?.[1] ? Number(match[1]) : null;
}

function inflateOrUnzip(buffer: Buffer): Buffer {
  try {
    return inflateSync(buffer);
  } catch {
    return unzipSync(buffer);
  }
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) walk(item, visit);
  }
}

function dedupeMarkets(markets: SpreadMarket[]): SpreadMarket[] {
  const seen = new Set<string>();
  return markets.filter((market) => {
    const key = `${market.conditionId}:${market.marketSlug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseJsonMaybe(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function tickSizeValue(value: unknown): SpreadMarket["tickSize"] | undefined {
  return value === "0.1" || value === "0.01" || value === "0.001" || value === "0.0001" ? value : undefined;
}

function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
