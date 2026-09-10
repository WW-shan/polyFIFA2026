import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readlink, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { BuyTradeDecision, TailStrategy, TradeResult, TradeResultLeg } from "../domain/types.js";

export type LedgerStatus = "filled" | "partial" | "posted" | "rejected" | "canceled" | "redeemed" | "lost";

export interface LedgerTradeLeg extends Omit<TradeResultLeg, "status"> {
  status: LedgerStatus;
}

export interface LedgerTradeEntry {
  timestamp: string;
  mode: "paper" | "live";
  status: LedgerStatus;
  eventSlug: string;
  marketSlug: string;
  tokenId: string;
  conditionId: string;
  outcome: string;
  strategy?: TailStrategy;
  orderId: string;
  price: number;
  shares: number;
  notional: number;
  reservedNotional?: number;
  legs?: LedgerTradeLeg[];
  raw?: unknown;
}

export class LiveLedger {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async readEntries(): Promise<LedgerTradeEntry[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(await resolvedLedgerPath(this.filePath), "utf8"));
      assertLedgerEntries(parsed);
      return parsed.map(normalizeLedgerEntry);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async readActiveEntries(): Promise<LedgerTradeEntry[]> {
    const entries = await this.readEntries();
    return entries.flatMap(ledgerPositions).filter((entry) => isActiveLedgerStatus(entry.status));
  }

  async hasActiveTrade(eventSlug: string, tokenId: string): Promise<boolean> {
    const entries = await this.readActiveEntries();
    return entries.some((entry) =>
      entry.eventSlug === eventSlug
      && entry.tokenId === tokenId
    );
  }

  async hasActiveEventTrade(eventSlug: string): Promise<boolean> {
    const entries = await this.readActiveEntries();
    return entries.some((entry) => entry.eventSlug === eventSlug);
  }

  async hasActiveLockedEventTrade(eventSlug: string): Promise<boolean> {
    const entries = await this.readActiveEntries();
    return entries.some((entry) =>
      entry.eventSlug === eventSlug
      && isLockedStrategy(entry.strategy)
    );
  }

  async recordTrade(entry: LedgerTradeEntry): Promise<void> {
    assertLedgerEntries([entry]);
    const safeEntry = { ...entry };
    if (entry.raw !== undefined) safeEntry.raw = serializeDiagnostic(entry.raw);
    if (entry.legs !== undefined) {
      safeEntry.legs = entry.legs.map((leg) => leg.raw === undefined ? { ...leg } : { ...leg, raw: serializeDiagnostic(leg.raw) });
    }
    await this.updateEntries((entries) => [...entries, normalizeLedgerEntry(safeEntry)]);
  }

  async markRedeemedByConditionIds(conditionIds: readonly string[]): Promise<void> {
    await this.markConditionIds(conditionIds, "redeemed");
  }

  async markLostByConditionIds(conditionIds: readonly string[]): Promise<void> {
    await this.markConditionIds(conditionIds, "lost");
  }

  private async markConditionIds(conditionIds: readonly string[], status: "redeemed" | "lost"): Promise<void> {
    const conditionSet = new Set(conditionIds.map((conditionId) => conditionId.trim().toLowerCase()).filter(Boolean));
    if (conditionSet.size === 0) return;
    await this.updateEntries((entries) => {
      let changed = false;
      const updated = entries.map((entry) => {
        if (entry.legs?.length) {
          let legChanged = false;
          const legs = entry.legs.map((leg) => {
            if (!leg.conditionId || !conditionSet.has(leg.conditionId.toLowerCase()) || !isEstablishedPosition(leg.status)) return leg;
            legChanged = true;
            return { ...leg, status };
          });
          if (!legChanged) return entry;
          changed = true;
          return normalizeLedgerEntry({ ...entry, legs });
        }
        if (isUnallocatedBasket(entry) || !conditionSet.has(entry.conditionId.toLowerCase()) || !isEstablishedPosition(entry.status)) return entry;
        changed = true;
        return { ...entry, status };
      });
      return changed ? updated : undefined;
    });
  }

  private async updateEntries(update: (entries: LedgerTradeEntry[]) => LedgerTradeEntry[] | undefined): Promise<void> {
    const filePath = await resolvedLedgerPath(this.filePath);
    await serializeLedgerUpdate(filePath, async () => {
      const entries = await this.readEntries();
      const updated = update(entries);
      if (updated) await writeLedgerAtomically(filePath, updated);
    });
  }

  async recordResult(decision: BuyTradeDecision, result: TradeResult, timestamp = new Date()): Promise<void> {
    const planned = decision.legs?.length ? decision.legs : [decision];
    const primary = planned.find((leg) => leg.tokenId === result.tokenId);
    const entry: LedgerTradeEntry = {
      timestamp: timestamp.toISOString(),
      mode: result.mode,
      status: result.status,
      eventSlug: primary?.eventSlug ?? decision.eventSlug,
      marketSlug: primary?.marketSlug ?? "",
      tokenId: result.tokenId,
      conditionId: primary?.conditionId ?? "",
      outcome: primary?.outcome ?? "",
      orderId: result.orderId,
      price: result.price,
      shares: result.shares,
      notional: result.notional
    };
    if (primary?.strategy) entry.strategy = primary.strategy;
    if (result.reservedNotional !== undefined) entry.reservedNotional = result.reservedNotional;
    if (result.legs !== undefined) {
      entry.legs = result.legs.map((leg) => {
        const mapping = planned.find((candidate) => candidate.tokenId === leg.tokenId);
        if (!mapping) return { ...leg };
        const mapped: LedgerTradeLeg = {
          ...leg,
          eventSlug: mapping.eventSlug,
          marketSlug: mapping.marketSlug,
          conditionId: mapping.conditionId,
          outcome: mapping.outcome
        };
        if (mapping.strategy !== undefined) mapped.strategy = mapping.strategy;
        return mapped;
      });
    }
    if (result.raw !== undefined) entry.raw = result.raw;
    await this.recordTrade(entry);
  }
}

// All instances addressing the same canonical path share one read/modify/write
// transaction. Reads can observe either complete version because publication is
// an atomic rename, including for readers outside this process.
const ledgerUpdates = new Map<string, Promise<void>>();

async function serializeLedgerUpdate(filePath: string, update: () => Promise<void>): Promise<void> {
  const previous = ledgerUpdates.get(filePath) ?? Promise.resolve();
  const current = previous.then(update);
  const tail = current.catch(() => {});
  ledgerUpdates.set(filePath, tail);
  try {
    await current;
  } finally {
    if (ledgerUpdates.get(filePath) === tail) ledgerUpdates.delete(filePath);
  }
}

async function resolvedLedgerPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    let link: string | undefined;
    try {
      link = await readlink(filePath);
    } catch (linkError) {
      if (!hasErrorCode(linkError, "ENOENT") && !hasErrorCode(linkError, "EINVAL")) throw linkError;
    }
    if (link !== undefined) return resolvedLedgerPath(resolve(dirname(filePath), link));
    const parent = dirname(filePath);
    if (parent === filePath) throw error;
    return join(await resolvedLedgerPath(parent), basename(filePath));
  }
}

async function writeLedgerAtomically(filePath: string, entries: LedgerTradeEntry[]): Promise<void> {
  const contents = `${JSON.stringify(entries, null, 2)}\n`;
  const directoryPath = dirname(filePath);
  await mkdir(directoryPath, { recursive: true });
  const temporaryPath = join(directoryPath, `.${basename(filePath)}.${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    });
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function normalizeLedgerEntry(entry: LedgerTradeEntry): LedgerTradeEntry {
  if (!entry.legs?.length) return isUnallocatedBasket(entry) ? { ...entry, status: "posted" } : entry;
  const legs = entry.legs.map((leg): LedgerTradeLeg => {
    const isPrimary = leg.tokenId === entry.tokenId;
    const normalized: LedgerTradeLeg = {
      ...leg,
      eventSlug: leg.eventSlug ?? entry.eventSlug,
      marketSlug: leg.marketSlug ?? (isPrimary ? entry.marketSlug : ""),
      conditionId: leg.conditionId ?? (isPrimary ? entry.conditionId : ""),
      outcome: leg.outcome ?? (isPrimary ? entry.outcome : "")
    };
    // Historical basket settlement only identified the parent's condition. It
    // provides no evidence that any other token or condition was settled.
    if (leg.conditionId === undefined && isPrimary && isEstablishedPosition(leg.status)
      && (entry.status === "redeemed" || entry.status === "lost")) normalized.status = entry.status;
    if (normalized.strategy === undefined && entry.strategy !== undefined) normalized.strategy = entry.strategy;
    return normalized;
  });
  const normalized = { ...entry, legs };
  return { ...normalized, status: aggregateLedgerStatus(ledgerPositions(normalized)) };
}

function isUnallocatedBasket(entry: LedgerTradeEntry): boolean {
  return !entry.legs?.length && entry.orderId.startsWith("live-basket-")
    && (entry.shares > 0 || entry.notional > 0 || isActiveLedgerStatus(entry.status));
}

function ledgerPositions(entry: LedgerTradeEntry): LedgerTradeEntry[] {
  const { legs, reservedNotional, ...base } = entry;
  if (!legs?.length) {
    return isUnallocatedBasket(entry)
      ? [{ ...entry, status: "posted", conditionId: "", marketSlug: "", outcome: "" }]
      : [entry];
  }
  const positions: LedgerTradeEntry[] = legs.map((leg) => ({
    ...base,
    ...leg,
    eventSlug: leg.eventSlug ?? entry.eventSlug,
    conditionId: leg.conditionId ?? "",
    marketSlug: leg.marketSlug ?? "",
    outcome: leg.outcome ?? ""
  }));
  const missingShares = Math.max(0, entry.shares - legs.reduce((total, leg) => total + leg.shares, 0));
  const missingNotional = Math.max(0, entry.notional - legs.reduce((total, leg) => total + leg.notional, 0));
  const missingReservation = Math.max(0, (reservedNotional ?? 0) - legs.reduce((total, leg) => total + (leg.reservedNotional ?? 0), 0));
  if (missingShares > 1e-8 || missingNotional > 1e-8 || missingReservation > 1e-8) {
    // Preserve incomplete legacy allocations as active, unassigned exposure.
    // In particular, never attach this remainder to the first condition.
    positions.push({
      ...base, status: "posted", tokenId: "", conditionId: "", marketSlug: "", outcome: "",
      shares: missingShares, notional: missingNotional,
      ...(missingReservation > 0 ? { reservedNotional: missingReservation } : {})
    });
  }
  return positions;
}

function aggregateLedgerStatus(positions: readonly LedgerTradeEntry[]): LedgerStatus {
  const active = positions.filter((position) => isActiveLedgerStatus(position.status));
  if (active.length > 0) {
    if (positions.every((position) => position.status === "filled")) return "filled";
    if (active.every((position) => position.status === "posted")) return "posted";
    return "partial";
  }
  if (positions.some((position) => position.status === "redeemed")) return "redeemed";
  if (positions.some((position) => position.status === "lost")) return "lost";
  if (positions.some((position) => position.status === "canceled")) return "canceled";
  return "rejected";
}

export function isActiveLedgerStatus(status: LedgerStatus): boolean {
  return status === "filled" || status === "partial" || status === "posted";
}

function isEstablishedPosition(status: LedgerStatus): boolean {
  // A redemption can precede a delayed fill. Keep unresolved submissions active
  // until their own execution outcome is established.
  return status === "filled" || status === "partial";
}

export function isLockedStrategy(strategy: TailStrategy | undefined): boolean {
  return strategy === "total_over_locked"
    || strategy === "team_total_over_locked"
    || strategy === "btts_yes_locked";
}

function isLedgerTradeEntry(value: unknown): value is LedgerTradeEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["timestamp", "eventSlug", "marketSlug", "tokenId", "conditionId", "outcome", "orderId"]
    .every((key) => typeof record[key] === "string")
    && (record.mode === "paper" || record.mode === "live")
    && isLedgerStatus(record.status)
    && ["price", "shares", "notional"].every((key) => isNonnegativeNumber(record[key]))
    && (record.reservedNotional === undefined || isNonnegativeNumber(record.reservedNotional))
    && (record.legs === undefined || (Array.isArray(record.legs) && record.legs.every(isLedgerTradeLeg)));
}

function isLedgerTradeLeg(value: unknown): value is LedgerTradeLeg {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.tokenId === "string" && typeof record.orderId === "string"
    && (record.mode === "paper" || record.mode === "live")
    && isLedgerStatus(record.status)
    && ["price", "shares", "notional", "fee", "estimatedPayout"].every((key) => isNonnegativeNumber(record[key]))
    && (record.reservedNotional === undefined || isNonnegativeNumber(record.reservedNotional))
    && typeof record.estimatedProfit === "number" && Number.isFinite(record.estimatedProfit)
    && ["eventSlug", "marketSlug", "conditionId", "outcome", "strategy"]
      .every((key) => record[key] === undefined || typeof record[key] === "string");
}

function isNonnegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertLedgerEntries(value: unknown): asserts value is LedgerTradeEntry[] {
  if (!Array.isArray(value) || !value.every(isLedgerTradeEntry)) {
    throw new Error("LEDGER_CORRUPT: expected an array of valid ledger entries; refusing to discard existing trade evidence");
  }
}

function isLedgerStatus(value: unknown): value is LedgerStatus {
  return value === "filled"
    || value === "partial"
    || value === "posted"
    || value === "rejected"
    || value === "canceled"
    || value === "redeemed"
    || value === "lost";
}

type JsonDiagnostic = null | boolean | number | string | JsonDiagnostic[] | { [key: string]: JsonDiagnostic };

/** Bounded evidence for logs and the ledger; never invokes arbitrary toJSON/getters. */
export function serializeDiagnostic(value: unknown): JsonDiagnostic {
  const ancestors = new Set<object>();
  let nodes = 0;
  let characters = 0;
  const text = (value: string): string => {
    const limit = Math.max(0, Math.min(2048, 12_000 - characters));
    const kept = value.slice(0, limit);
    characters += kept.length;
    return kept.length === value.length ? kept : `${kept}[Truncated]`;
  };
  const visit = (value: unknown, depth: number): JsonDiagnostic => {
    if (++nodes > 256 || characters >= 12_000) return "[Truncated]";
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return text(value);
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return text(value.toString());
    if (typeof value !== "object") return `[${typeof value}]`;
    if (ancestors.has(value)) return "[Circular]";
    if (depth >= 6) return "[MaxDepth]";
    ancestors.add(value);
    try {
      if (ArrayBuffer.isView(value)) return { type: "Binary", byteLength: value.byteLength };
      if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", byteLength: value.byteLength };
      if (value instanceof Date) return text(Date.prototype.toISOString.call(value));
      if (Array.isArray(value)) {
        const result: JsonDiagnostic[] = [];
        for (let index = 0; index < Math.min(value.length, 32); index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          result.push(descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Getter]");
        }
        if (value.length > 32) result.push(`[Truncated ${value.length - 32} items]`);
        return result;
      }
      const result: { [key: string]: JsonDiagnostic } = Object.create(null);
      const keys = new Set<string>();
      if (value instanceof Error) {
        // Error name/message are normally non-enumerable; Axios also keeps the
        // useful request/response evidence outside its lossy toJSON result.
        for (const key of ["name", "message", "code", "status", "request", "response", "raw", "cause", "stack"]) keys.add(key);
      }
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (keys.size >= 32) { result._truncated = true; break; }
        keys.add(key);
      }
      for (const key of keys) {
        let owner: object | null = value;
        let descriptor: PropertyDescriptor | undefined;
        while (owner && !descriptor) {
          descriptor = Object.getOwnPropertyDescriptor(owner, key);
          owner = Object.getPrototypeOf(owner) as object | null;
        }
        if (!descriptor) continue;
        const safeKey = text(key);
        if (/authorization|api[_-]?key|private[_-]?key|secret|password|passphrase|signature|cookie|headers?|^_?config$|^auth$/i.test(key)) result[safeKey] = "[Redacted]";
        else result[safeKey] = "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Getter]";
      }
      return result;
    } catch {
      return "[Unserializable diagnostic]";
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(value, 0);
}
