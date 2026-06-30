import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BuyTradeDecision, TailStrategy, TradeResult } from "../domain/types.js";

export type LedgerStatus = "filled" | "partial" | "posted" | "rejected" | "canceled" | "redeemed" | "lost";

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
}

export class LiveLedger {
  constructor(private readonly filePath: string) {}

  async readEntries(): Promise<LedgerTradeEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isLedgerTradeEntry) : [];
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async readActiveEntries(): Promise<LedgerTradeEntry[]> {
    const entries = await this.readEntries();
    return entries.filter((entry) => isActiveLedgerStatus(entry.status));
  }

  async hasActiveTrade(eventSlug: string, tokenId: string): Promise<boolean> {
    const entries = await this.readEntries();
    return entries.some((entry) =>
      entry.eventSlug === eventSlug
      && entry.tokenId === tokenId
      && isActiveLedgerStatus(entry.status)
    );
  }

  async hasActiveEventTrade(eventSlug: string): Promise<boolean> {
    const entries = await this.readEntries();
    return entries.some((entry) => entry.eventSlug === eventSlug && isActiveLedgerStatus(entry.status));
  }

  async hasActiveLockedEventTrade(eventSlug: string): Promise<boolean> {
    const entries = await this.readEntries();
    return entries.some((entry) =>
      entry.eventSlug === eventSlug
      && isActiveLedgerStatus(entry.status)
      && isLockedStrategy(entry.strategy)
    );
  }

  async recordTrade(entry: LedgerTradeEntry): Promise<void> {
    const entries = await this.readEntries();
    entries.push(entry);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  }

  async markRedeemedByConditionIds(conditionIds: readonly string[]): Promise<void> {
    const conditionSet = new Set(conditionIds.map((conditionId) => conditionId.toLowerCase()));
    if (conditionSet.size === 0) return;
    const entries = await this.readEntries();
    let changed = false;
    const updated = entries.map((entry) => {
      if (!conditionSet.has(entry.conditionId.toLowerCase()) || !isActiveLedgerStatus(entry.status)) return entry;
      changed = true;
      return { ...entry, status: "redeemed" as const };
    });
    if (!changed) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  }

  async recordResult(decision: BuyTradeDecision, result: TradeResult, timestamp = new Date()): Promise<void> {
    const entry: LedgerTradeEntry = {
      timestamp: timestamp.toISOString(),
      mode: result.mode,
      status: result.status,
      eventSlug: decision.eventSlug,
      marketSlug: decision.marketSlug,
      tokenId: decision.tokenId,
      conditionId: decision.conditionId,
      outcome: decision.outcome,
      orderId: result.orderId,
      price: result.price,
      shares: result.shares,
      notional: result.notional
    };
    if (decision.strategy) entry.strategy = decision.strategy;
    await this.recordTrade(entry);
  }
}

export function isActiveLedgerStatus(status: LedgerStatus): boolean {
  return status === "filled" || status === "partial" || status === "posted";
}

export function isLockedStrategy(strategy: TailStrategy | undefined): boolean {
  return strategy === "total_over_locked"
    || strategy === "team_total_over_locked"
    || strategy === "btts_yes_locked";
}

function isLedgerTradeEntry(value: unknown): value is LedgerTradeEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventSlug === "string"
    && typeof record.tokenId === "string"
    && isLedgerStatus(record.status);
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
