import { createHash } from "node:crypto";
import { normalizeCollectorEvent } from "../collector/catalog.js";
import type { ResearchEvent, ResearchMarket, ResearchTrade } from "./types.js";

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function numberValue(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function timeValue(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export function resolvePayouts(raw: Record<string, unknown>, count: number): number[] | null {
  if (raw.closed !== true || raw.umaResolutionStatus !== "resolved") return null;
  let prices: unknown = raw.outcomePrices;
  if (typeof prices === "string") {
    try { prices = JSON.parse(prices) as unknown; } catch { return null; }
  }
  if (!Array.isArray(prices) || prices.length !== count || count < 2) return null;
  const values = prices.map(numberValue);
  if (!values.every((p): p is number => p !== null && p >= 0 && p <= 1)) return null;
  return Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) < 1e-8 ? values : null;
}

function horizon(type: string): ResearchMarket["horizon"] {
  if (["tennis_first_set_winner", "tennis_set_winner", "tennis_first_set_totals", "tennis_set_games_totals"].includes(type)) return "set";
  if (["moneyline", "tennis_completed_match", "tennis_exact_score", "tennis_game_handicap", "tennis_match_totals", "tennis_set_handicap", "tennis_set_totals", "table_tennis_game_handicap", "table_tennis_match_totals"].includes(type)) return "match";
  return "unknown";
}

export function normalizeResearchEvent(raw: unknown, sport: string): ResearchEvent | null {
  const event = normalizeCollectorEvent(raw);
  if (!event) return null;
  let startMs = timeValue(event.raw.startTime);
  let startSource: ResearchEvent["startSource"] = startMs === null ? null : "gamma.startTime";
  if (startMs === null) {
    for (const market of event.markets) {
      startMs = timeValue(market.raw.gameStartTime);
      if (startMs !== null) { startSource = "gamma.market.gameStartTime"; break; }
    }
  }
  const finishMs = timeValue(event.raw.finishedTimestamp);
  return {
    eventId: event.eventId, eventSlug: event.eventSlug, title: event.title, sport, gameId: event.gameId,
    startMs, startSource, finishMs, finishSource: finishMs === null ? null : "gamma.finishedTimestamp", raw: event.raw,
    markets: event.markets.map(market => {
      const payouts = resolvePayouts(market.raw, market.outcomes.length);
      const type = typeof market.raw.sportsMarketType === "string" ? market.raw.sportsMarketType : "unknown";
      return {
        marketId: market.marketId, conditionId: market.conditionId, marketSlug: market.marketSlug, question: market.question,
        marketType: type, horizon: horizon(type), raw: market.raw, trades: [], coverage: null,
        resolutionSource: payouts === null ? "unresolved" : "gamma-resolved-prices",
        outcomes: market.outcomes.map((name, index) => ({ tokenId: market.tokenIds[index]!, name, payout: payouts?.[index] ?? null }))
      };
    })
  };
}

export function isResearchMatch(event: ResearchEvent): boolean {
  return event.markets.length > 0 && (event.gameId !== null ||
    (event.startMs !== null && event.markets.some(market => market.marketType !== "unknown")));
}

export function normalizeResearchTrade(value: unknown, conditionId: string, tokenIds: readonly string[]): ResearchTrade | null {
  const raw = objectValue(value);
  if (!raw || raw.conditionId !== conditionId || typeof raw.asset !== "string" || !tokenIds.includes(raw.asset)) return null;
  if (raw.side !== "BUY" && raw.side !== "SELL") return null;
  if (typeof raw.transactionHash !== "string" || !raw.transactionHash.trim()) return null;
  const timestamp = numberValue(raw.timestamp);
  const price = numberValue(raw.price);
  const size = numberValue(raw.size);
  if (timestamp === null || timestamp < 0 || !Number.isSafeInteger(timestamp * 1000) || price === null || price < 0 || price > 1 || size === null || size <= 0) return null;
  // The API has no log index. Exact repeats are conservatively deduplicated;
  // raw responses are retained so ambiguous same-transaction rows are auditable.
  const identity = [raw.transactionHash, raw.asset, timestamp, raw.side, price, size, raw.proxyWallet ?? null];
  return {
    id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"), tokenId: raw.asset, conditionId,
    timestampMs: timestamp * 1000, price, size, side: raw.side, transactionHash: raw.transactionHash
  };
}
