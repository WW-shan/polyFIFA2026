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

  test("records live result raw details for rejected orders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-raw-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordResult({
      action: "BUY",
      eventSlug: "event-raw",
      marketSlug: "market-raw",
      question: "Raw vs. Error",
      tokenId: "token-raw",
      conditionId: "condition-raw",
      outcome: "Over",
      bestAsk: 0.98,
      availableSize: 10,
      shares: 1,
      notional: 0.98,
      estimatedFee: 0,
      estimatedNetReturn: 0.01,
      strategy: "team_total_over_locked",
      locked: true,
      legs: [{
        eventSlug: "event-raw",
        marketSlug: "market-raw",
        question: "Raw vs. Error",
        tokenId: "token-raw",
        conditionId: "condition-raw",
        outcome: "Over",
        price: 0.98,
        availableSize: 10,
        shares: 1,
        notional: 0.98,
        estimatedFee: 0,
        estimatedNetReturn: 0.01,
        strategy: "team_total_over_locked",
        lossRequiresGoals: 999,
        locked: true
      }]
    }, {
      mode: "live",
      status: "rejected",
      orderId: "live-rejected-token-raw",
      tokenId: "token-raw",
      price: 0.98,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0,
      legs: [{
        mode: "live",
        status: "rejected",
        orderId: "live-rejected-token-raw",
        tokenId: "token-raw",
        price: 0.98,
        shares: 0,
        notional: 0,
        fee: 0,
        estimatedPayout: 0,
        estimatedProfit: 0,
        raw: { code: "LIVE_ORDER_REJECTED", message: "order couldn't be fully filled" }
      }]
    });

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({
        eventSlug: "event-raw",
        status: "rejected",
        legs: [
          expect.objectContaining({
            raw: expect.objectContaining({
              message: "order couldn't be fully filled"
            })
          })
        ]
      })
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

  test("detects active locked event trades separately from other active trades", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-06-23T10:00:00.000Z",
      mode: "live",
      status: "filled",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Under",
      strategy: "total_under_loss_ge2",
      orderId: "order-1",
      price: 0.97,
      shares: 1,
      notional: 0.97
    });
    await ledger.recordTrade({
      timestamp: "2026-06-23T10:01:00.000Z",
      mode: "live",
      status: "partial",
      eventSlug: "event-2",
      marketSlug: "market-2",
      tokenId: "token-2",
      conditionId: "condition-2",
      outcome: "Over",
      strategy: "total_over_locked",
      orderId: "order-2",
      price: 0.91,
      shares: 1,
      notional: 0.91
    });

    expect(await ledger.hasActiveLockedEventTrade("event-1")).toBe(false);
    expect(await ledger.hasActiveLockedEventTrade("event-2")).toBe(true);
  });

  test("does not treat rejected, canceled, or lost entries as active event trades", async () => {
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
    await ledger.recordTrade({
      timestamp: "2026-06-23T10:02:00.000Z",
      mode: "live",
      status: "lost",
      eventSlug: "event-1",
      marketSlug: "market-3",
      tokenId: "token-3",
      conditionId: "condition-3",
      outcome: "Over",
      orderId: "order-3",
      price: 0.18,
      shares: 1,
      notional: 0.18
    });

    expect(await ledger.hasActiveEventTrade("event-1")).toBe(false);
    expect(await ledger.readEntries()).toContainEqual(expect.objectContaining({ status: "lost", eventSlug: "event-1" }));
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

  test("marks redeemed condition ids inactive after settlement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-06-23T10:00:00.000Z",
      mode: "live",
      status: "filled",
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
      mode: "live",
      status: "filled",
      eventSlug: "event-2",
      marketSlug: "market-2",
      tokenId: "token-2",
      conditionId: "condition-2",
      outcome: "No",
      orderId: "order-2",
      price: 0.98,
      shares: 1,
      notional: 0.98
    });

    await ledger.markRedeemedByConditionIds(["condition-1"]);

    expect(await ledger.hasActiveEventTrade("event-1")).toBe(false);
    expect(await ledger.hasActiveEventTrade("event-2")).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ eventSlug: "event-1", status: "redeemed" }),
      expect.objectContaining({ eventSlug: "event-2", status: "filled" })
    ]);
  });

  test("marks lost condition ids inactive after resolution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-lost-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-06-23T10:00:00.000Z",
      mode: "live",
      status: "filled",
      eventSlug: "event-lost",
      marketSlug: "market-lost",
      tokenId: "token-lost",
      conditionId: "condition-lost",
      outcome: "Over",
      orderId: "order-lost",
      price: 0.97,
      shares: 1,
      notional: 0.97
    });

    await ledger.markLostByConditionIds(["condition-lost"]);

    expect(await ledger.hasActiveEventTrade("event-lost")).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ eventSlug: "event-lost", status: "lost" })
    ]);
  });
});
