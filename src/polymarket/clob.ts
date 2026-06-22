import type { OrderbookSnapshot, PriceLevel, SpreadMarket } from "../domain/types.js";
import { fetchJson } from "./http.js";

export interface RawOrderbook {
  market?: string;
  asset_id?: string;
  assetId?: string;
  tokenId?: string;
  timestamp?: string;
  bids?: Array<{ price: string | number; size: string | number }>;
  asks?: Array<{ price: string | number; size: string | number }>;
  tick_size?: string;
  tickSize?: string;
  neg_risk?: boolean;
  negRisk?: boolean;
  hash?: string;
}

export async function fetchOrderbook(tokenId: string, baseUrl = "https://clob.polymarket.com"): Promise<OrderbookSnapshot> {
  const url = `${baseUrl.replace(/\/$/, "")}/book?token_id=${encodeURIComponent(tokenId)}`;
  const raw = await fetchJson<RawOrderbook>(url);
  return normalizeOrderbook(raw);
}

export function normalizeOrderbook(raw: RawOrderbook): OrderbookSnapshot {
  const tokenId = raw.asset_id ?? raw.assetId ?? raw.tokenId;
  if (!tokenId) {
    throw new Error("ORDERBOOK_TOKEN_MISSING");
  }

  const snapshot: OrderbookSnapshot = {
    tokenId,
    bids: normalizeLevels(raw.bids ?? [], "desc"),
    asks: normalizeLevels(raw.asks ?? [], "asc")
  };

  if (raw.market) snapshot.market = raw.market;
  const tickSize = tickSizeValue(raw.tick_size ?? raw.tickSize);
  if (tickSize) snapshot.tickSize = tickSize;
  if (typeof raw.neg_risk === "boolean") snapshot.negRisk = raw.neg_risk;
  if (typeof raw.negRisk === "boolean") snapshot.negRisk = raw.negRisk;
  if (raw.hash) snapshot.hash = raw.hash;
  if (raw.timestamp) snapshot.timestamp = raw.timestamp;

  return snapshot;
}

function normalizeLevels(levels: Array<{ price: string | number; size: string | number }>, direction: "asc" | "desc"): PriceLevel[] {
  return levels
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
    .sort((a, b) => (direction === "asc" ? a.price - b.price : b.price - a.price));
}

function tickSizeValue(value: unknown): SpreadMarket["tickSize"] | undefined {
  return value === "0.1" || value === "0.01" || value === "0.001" || value === "0.0001" ? value : undefined;
}
