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
  min_order_size?: string | number;
  minOrderSize?: string | number;
  minimum_order_size?: string | number;
  minimumOrderSize?: string | number;
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
  const minimumOrderSize = numberValue(
    raw.min_order_size ?? raw.minOrderSize ?? raw.minimum_order_size ?? raw.minimumOrderSize
  );
  if (minimumOrderSize !== undefined && minimumOrderSize > 0) snapshot.minimumOrderSize = minimumOrderSize;
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

export const SUPPORTED_TICK_SIZES = ["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"] as const;

export function tickSizeValue(value: unknown): SpreadMarket["tickSize"] | undefined {
  const parsed = typeof value === "number" ? value.toString() : value;
  return (SUPPORTED_TICK_SIZES as readonly unknown[]).includes(parsed)
    ? (parsed as SpreadMarket["tickSize"])
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
