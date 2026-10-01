import { mkdtemp, readFile, unlink, utimes, writeFile } from "node:fs/promises";
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

  test("cancels a resting order by id and releases its reservation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-cancel-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-09-23T10:00:00.000Z",
      mode: "live",
      status: "posted",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      orderId: "resting-1",
      price: 0.7,
      shares: 0,
      notional: 0,
      reservedNotional: 97
    });

    expect(await ledger.markCanceledByOrderId("resting-1")).toBe(true);
    expect(await ledger.hasActiveTrade("event-1", "token-1")).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ orderId: "resting-1", status: "canceled", reservedNotional: 0 })
    ]);
    expect(await ledger.markCanceledByOrderId("unknown-order")).toBe(false);
  });

  test("keeps a partially filled resting order active when it is canceled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-cancel-partial-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-09-23T10:00:00.000Z",
      mode: "live",
      status: "posted",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      orderId: "resting-partial",
      price: 0.7,
      shares: 12,
      notional: 8.4,
      reservedNotional: 88.6
    });

    await ledger.markCanceledByOrderId("resting-partial");

    // Filled shares still need settlement, so the position stays active while the
    // unfilled reservation is released.
    expect(await ledger.hasActiveTrade("event-1", "token-1")).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ status: "partial", shares: 12, reservedNotional: 0 })
    ]);
  });

  test("records a fully filled resting order as an owned position", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-rest-fill-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-09-23T10:00:00.000Z",
      mode: "live",
      status: "posted",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      orderId: "resting-fill",
      price: 0.7,
      shares: 0,
      notional: 0,
      reservedNotional: 97
    });

    // The venue reports a maker bid that traded to completion.
    expect(await ledger.recordRestingOrderFill("resting-fill", { shares: 138.57, price: 0.7, remainingShares: 0 })).toBe(true);
    expect(await ledger.hasActiveTrade("event-1", "token-1")).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({
        orderId: "resting-fill",
        status: "filled",
        shares: 138.57,
        notional: 96.999,
        reservedNotional: 0
      })
    ]);
  });

  test("keeps the unfilled remainder reserved while a resting order still trades", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-rest-partial-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-09-23T10:00:00.000Z",
      mode: "live",
      status: "posted",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      orderId: "resting-partial-live",
      price: 0.7,
      shares: 0,
      notional: 0,
      reservedNotional: 97
    });

    expect(await ledger.recordRestingOrderFill("resting-partial-live", { shares: 20, price: 0.7, remainingShares: 118.57 })).toBe(true);
    // Re-reading the same venue snapshot must not rewrite the ledger.
    expect(await ledger.recordRestingOrderFill("resting-partial-live", { shares: 20, price: 0.7, remainingShares: 118.57 })).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({
        orderId: "resting-partial-live",
        status: "partial",
        shares: 20,
        notional: 14,
        reservedNotional: 82.999
      })
    ]);
  });

  test("applies a later cumulative fill to an already partially filled resting order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-rest-partial-twice-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-09-23T10:00:00.000Z",
      mode: "live",
      status: "posted",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      orderId: "resting-two-fills",
      price: 0.7,
      shares: 0,
      notional: 0,
      reservedNotional: 97
    });

    await ledger.recordRestingOrderFill("resting-two-fills", { shares: 20, price: 0.7, remainingShares: 118.57 });
    expect(await ledger.recordRestingOrderFill("resting-two-fills", { shares: 50, price: 0.7, remainingShares: 88.57 })).toBe(true);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ status: "partial", shares: 50, notional: 35, reservedNotional: expect.closeTo(61.999, 6) })
    ]);
  });

  test("does not downgrade a filled resting order when the venue later closes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-rest-filled-closed-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordTrade({
      timestamp: "2026-09-23T10:00:00.000Z",
      mode: "live",
      status: "posted",
      eventSlug: "event-1",
      marketSlug: "market-1",
      tokenId: "token-1",
      conditionId: "condition-1",
      outcome: "Yes",
      orderId: "resting-filled-closed",
      price: 0.7,
      shares: 0,
      notional: 0,
      reservedNotional: 97
    });

    await ledger.recordRestingOrderFill("resting-filled-closed", { shares: 138.57, price: 0.7, remainingShares: 0 });
    await ledger.markCanceledByOrderId("resting-filled-closed");

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ status: "filled", shares: 138.57, reservedNotional: 0 })
    ]);
  });

  test("a fill on a single-leg basket leaves no phantom unassigned reservation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-rest-leg-fill-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);
    const leg = {
      mode: "live" as const, status: "posted" as const, orderId: "leg-order", tokenId: "token-1",
      eventSlug: "event-1", marketSlug: "market-1", conditionId: "condition-1", outcome: "Yes",
      price: 0.7, shares: 0, notional: 0, fee: 0, estimatedPayout: 0, estimatedProfit: 0, reservedNotional: 96.999
    };
    await ledger.recordTrade({
      timestamp: "2026-09-23T10:00:00.000Z", mode: "live", status: "posted", eventSlug: "event-1",
      marketSlug: "market-1", tokenId: "token-1", conditionId: "condition-1", outcome: "Yes",
      orderId: "leg-order", price: 0.7, shares: 0, notional: 0, reservedNotional: 96.999, legs: [leg]
    });

    expect(await ledger.recordRestingOrderFill("leg-order", { shares: 138.57, price: 0.7, remainingShares: 0 })).toBe(true);

    const active = await ledger.readActiveEntries();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ tokenId: "token-1", status: "filled", shares: 138.57, reservedNotional: 0 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ status: "filled", shares: 138.57, notional: expect.closeTo(96.999, 6), reservedNotional: 0 })
    ]);
  });

  test("canceling every basket leg releases the basket's aggregate reservation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-basket-cancel-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);
    const leg = (orderId: string, tokenId: string) => ({
      mode: "live" as const, status: "posted" as const, orderId, tokenId,
      eventSlug: "event-1", marketSlug: `market-${tokenId}`, conditionId: `condition-${tokenId}`, outcome: "Yes",
      price: 0.5, shares: 0, notional: 0, fee: 0, estimatedPayout: 0, estimatedProfit: 0, reservedNotional: 10
    });
    await ledger.recordTrade({
      timestamp: "2026-09-23T10:00:00.000Z", mode: "live", status: "posted", eventSlug: "event-1",
      marketSlug: "market-t1", tokenId: "t1", conditionId: "condition-t1", outcome: "Yes",
      orderId: "live-basket-o1", price: 0.5, shares: 0, notional: 0, reservedNotional: 20,
      legs: [leg("o1", "t1"), leg("o2", "t2")]
    });

    expect(await ledger.markCanceledByOrderId("o1")).toBe(true);
    expect(await ledger.markCanceledByOrderId("o2")).toBe(true);

    expect(await ledger.readActiveEntries()).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ status: "canceled", reservedNotional: 0 })
    ]);
  });

  test("a write-ahead submission blocks the event and is replaced by the executor result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-pending-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);
    const decision = {
      action: "BUY" as const, eventSlug: "event-1", marketSlug: "market-1", question: "Q", tokenId: "token-1",
      conditionId: "condition-1", outcome: "Yes", bestAsk: 0.7, availableSize: 200, shares: 100, notional: 70,
      estimatedFee: 0, estimatedNetReturn: 0.1
    };

    const pendingId = await ledger.recordPendingSubmission(decision, "live");
    expect(await ledger.hasActiveEventTrade("event-1")).toBe(true);
    expect((await ledger.readActiveEntries())[0]).toMatchObject({ orderId: pendingId, status: "posted", reservedNotional: 70 });

    await ledger.recordResult(decision, {
      mode: "live", status: "filled", orderId: "real-order", tokenId: "token-1", price: 0.7,
      shares: 100, notional: 70, fee: 0, estimatedPayout: 100, estimatedProfit: 30
    }, new Date("2026-09-23T10:00:00.000Z"), pendingId);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      expect.objectContaining({ orderId: "real-order", status: "filled" })
    ]);

    const discarded = await ledger.recordPendingSubmission(decision, "live");
    await ledger.discardPendingSubmission(discarded);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
  });

  test("waits for another writer's lock and recovers a stale one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-lock-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);
    const entry = {
      timestamp: "2026-09-23T10:00:00.000Z", mode: "live" as const, status: "filled" as const, eventSlug: "event-1",
      marketSlug: "market-1", tokenId: "token-1", conditionId: "condition-1", outcome: "Yes",
      orderId: "order-1", price: 0.7, shares: 1, notional: 0.7
    };

    await writeFile(`${file}.lock`, "other-process");
    let written = false;
    const pending = ledger.recordTrade(entry).then(() => { written = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    expect(written).toBe(false);
    await unlink(`${file}.lock`);
    await pending;
    expect(written).toBe(true);

    await writeFile(`${file}.lock`, "dead-process");
    const old = new Date(Date.now() - 120_000);
    await utimes(`${file}.lock`, old, old);
    await ledger.recordTrade({ ...entry, orderId: "order-2" });
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(2);
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
