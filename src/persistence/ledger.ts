import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BuyTradeDecision, TailStrategy, TradeResult } from "../domain/types.js";

export interface LedgerTradeEntry {
  timestamp: string;
  mode: "paper" | "live";
  status: TradeResult["status"];
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

  async hasActiveTrade(eventSlug: string, tokenId: string): Promise<boolean> {
    const entries = await this.readEntries();
    return entries.some((entry) =>
      entry.eventSlug === eventSlug
      && entry.tokenId === tokenId
      && (entry.status === "filled" || entry.status === "posted")
    );
  }

  async recordTrade(entry: LedgerTradeEntry): Promise<void> {
    const entries = await this.readEntries();
    entries.push(entry);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
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

function isLedgerTradeEntry(value: unknown): value is LedgerTradeEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventSlug === "string"
    && typeof record.tokenId === "string"
    && (
      record.status === "filled"
      || record.status === "partial"
      || record.status === "posted"
      || record.status === "rejected"
      || record.status === "canceled"
    );
}
