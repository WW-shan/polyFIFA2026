/**
 * Read-only helpers for reconciling resting maker bids against the venue.
 *
 * Shared by the soccer-locked watch CLI and the tennis tail watch so a resting
 * bid is never left behind as a phantom `posted` reservation after it traded.
 */
import { sportsTakerFeePerShare } from "../domain/fees.js";

/** Normalized without the venue's `ORDER_STATUS_` prefix. */
export const TERMINAL_ORDER_SNAPSHOT_STATUSES = new Set([
  "canceled", "cancelled", "canceledmarketresolved", "cancelledmarketresolved", "expired", "invalid", "rejected"
]);

/** `unmatched` is intentionally absent: it is an accepted order whose matching was delayed. */
export function orderSnapshotStatus(snapshot: unknown): string | undefined {
  if (!isRecord(snapshot) || snapshot.status === undefined || snapshot.status === null) return undefined;
  const lower = String(snapshot.status).toLowerCase();
  return (lower.startsWith("order_status_") ? lower.slice("order_status_".length) : lower).replace(/[\s_-]+/g, "");
}

/**
 * Reads how much of a resting bid actually traded. `size_matched` is the
 * authoritative fill size, so a maker bid that got hit is never left behind as a
 * phantom `posted` reservation that also blocks the next pass as a duplicate.
 */
export function restingFillFromSnapshot(
  entry: { price: number; shares: number; reservedNotional?: number },
  snapshot: unknown
): { shares: number; price: number; remainingShares?: number; fee?: number } | undefined {
  if (!isRecord(snapshot)) return undefined;
  const matched = numericField(snapshot, "size_matched") ?? numericField(snapshot, "sizeMatched");
  if (matched === undefined || matched <= 0) return undefined;
  const price = numericField(snapshot, "price") ?? entry.price;
  if (!(price > 0)) return undefined;
  const original = numericField(snapshot, "original_size") ?? numericField(snapshot, "originalSize");
  // The reservation only describes the full order before anything traded;
  // after a partial fill it is the remainder, not the requested size.
  const requested = original
    ?? (entry.shares <= 0 && entry.reservedNotional !== undefined && entry.price > 0 ? entry.reservedNotional / entry.price : undefined);
  // Immediate-or-kill orders only ever take liquidity and pay the taker fee.
  const orderType = String(snapshot.order_type ?? snapshot.orderType ?? "").toUpperCase();
  const fee = orderType === "FAK" || orderType === "FOK" ? matched * sportsTakerFeePerShare(price) : undefined;
  const fill = { shares: matched, price, ...(fee === undefined ? {} : { fee }) };
  if (requested === undefined) return fill;
  return { ...fill, remainingShares: Math.max(0, requested - matched) };
}

export function numericField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
