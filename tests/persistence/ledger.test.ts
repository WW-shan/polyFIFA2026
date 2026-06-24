import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LiveLedger } from "../../src/persistence/ledger.js";

describe("LiveLedger", () => {
  test("records trades and detects duplicate event token buys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    expect(await ledger.hasActiveTrade("event-1", "token-1")).toBe(false);

    await ledger.recordTrade({
      timestamp: "2026-06-23T10:00:00.000Z",
      mode: "paper",
      status: "filled",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      strategy: "leader_yes_lead_ge2",
      orderId: "order-1",
      price: 0.97,
      shares: 1,
      notional: 0.97
    });

    expect(await ledger.hasActiveTrade("event-1", "token-1")).toBe(true);
    expect(await ledger.hasActiveTrade("event-2", "token-1")).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ eventSlug: "event-1", tokenId: "token-1", status: "filled" })
    ]);
  });

  test("detects active event trades across tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-06-23T10:00:00.000Z",
      mode: "paper",
      status: "filled",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      strategy: "leader_yes_lead_ge2",
      orderId: "order-1",
      price: 0.97,
      shares: 1,
      notional: 0.97
    });

    expect(await ledger.hasActiveEventTrade("event-1")).toBe(true);
    expect(await ledger.hasActiveEventTrade("event-2")).toBe(false);
  });

  test("does not treat rejected or canceled entries as active event trades", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-06-23T10:00:00.000Z",
      mode: "paper",
      status: "rejected",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      orderId: "order-1",
      price: 0.97,
      shares: 1,
      notional: 0.97
    });
    await ledger.recordTrade({
      timestamp: "2026-06-23T10:01:00.000Z",
      mode: "paper",
      status: "canceled",
      eventSlug: "event-1",
      marketSlug: "market-2",
      tokenId: "token-2",
      conditionId: "condition-2",
      outcome: "No",
      orderId: "order-2",
      price: 0.98,
      shares: 1,
      notional: 0.98
    });

    expect(await ledger.hasActiveEventTrade("event-1")).toBe(false);
  });

  test("treats partial entries as active event trades", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-06-23T10:00:00.000Z",
      mode: "live",
      status: "partial",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      orderId: "order-1",
      price: 0.97,
      shares: 1,
      notional: 0.97
    });

    expect(await ledger.hasActiveEventTrade("event-1")).toBe(true);
    expect(await ledger.hasActiveTrade("event-1", "token-1")).toBe(true);
  });
});
