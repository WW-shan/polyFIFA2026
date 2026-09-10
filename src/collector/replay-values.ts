import type { ReplayLevel } from "./replay-types.js";

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
export function identifier(value: unknown): string | undefined {
  return textValue(value) ?? (typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined);
}
export function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}
export function arrayValue(value: unknown): unknown[] {
  const parsed = parsedJson(value);
  return Array.isArray(parsed) ? parsed : [];
}
export function frameType(value: Record<string, unknown>): string {
  return String(value.event_type ?? value.eventType ?? value.type ?? "").toLowerCase();
}
export function assetId(value: Record<string, unknown>): string | undefined {
  return identifier(value.asset_id ?? value.assetId ?? value.token_id ?? value.tokenId);
}
export function heartbeat(value: unknown): boolean {
  if (typeof value === "string" && /^(ping|pong)$/i.test(value.trim())) return true;
  const raw = objectValue(value);
  return raw !== undefined && /^(ping|pong)$/i.test(String(raw.type ?? raw.event ?? raw.action ?? ""));
}

export interface Decimal { raw: string; key: string }
/** Canonical decimal keys avoid float rounding and preserve original output strings. */
export function decimal(value: unknown, price = false): Decimal | undefined {
  let raw = typeof value === "number" && Number.isFinite(value) ? String(value) : textValue(value);
  if (raw === undefined) return undefined;
  if (typeof value === "number" && /e/i.test(raw)) {
    const [coefficient = "", exponent = ""] = raw.toLowerCase().split("e");
    const [integer = "", fraction = ""] = coefficient.split(".");
    const digits = integer + fraction;
    const position = integer.length + Number(exponent);
    raw = position <= 0 ? "0." + "0".repeat(-position) + digits
      : position >= digits.length ? digits + "0".repeat(position - digits.length)
      : digits.slice(0, position) + "." + digits.slice(position);
  }
  if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) return undefined;
  const [integer = "0", fraction = ""] = raw.split(".");
  const whole = integer.replace(/^0+(?=\d)/, "");
  const tail = fraction.replace(/0+$/, "");
  const key = whole + (tail ? "." + tail : "");
  if (price && (whole.length > 1 || Number(whole) > 1 || (whole === "1" && tail !== ""))) return undefined;
  return { raw, key };
}
export function level(value: unknown): { key: string; value: ReplayLevel } | undefined {
  const raw = objectValue(value);
  const price = decimal(raw?.price, true);
  const size = decimal(raw?.size);
  return price && size ? { key: price.key, value: { price: price.raw, size: size.raw } } : undefined;
}
export function levelMap(value: unknown): Map<string, ReplayLevel> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = new Map<string, ReplayLevel>();
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = level(item);
    if (!parsed || seen.has(parsed.key)) return undefined;
    seen.add(parsed.key);
    if (decimal(parsed.value.size)?.key !== "0") result.set(parsed.key, parsed.value);
  }
  return result;
}
export function sortedLevels(values: Map<string, ReplayLevel>, descending: boolean): ReplayLevel[] {
  return [...values.entries()].sort(([a], [b]) => {
    const width = Math.max(a.length, b.length);
    const left = (a.includes(".") ? a : a + ".").padEnd(width + 1, "0");
    const right = (b.includes(".") ? b : b + ".").padEnd(width + 1, "0");
    const order = left < right ? -1 : left > right ? 1 : 0;
    return descending ? -order : order;
  }).map(([, value]) => ({ ...value }));
}
export function timestamp(value: unknown): bigint | undefined {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : textValue(value);
  return text !== undefined && /^\d+$/.test(text) ? BigInt(text) : undefined;
}
