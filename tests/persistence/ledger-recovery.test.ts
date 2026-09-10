import { lstat, mkdir, mkdtemp, open, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { buyDecisionFromLegs } from "../../src/domain/decision.js";
import type { BuyTradeLeg, TradeResult, TradeResultLeg } from "../../src/domain/types.js";
import { LiveLedger, type LedgerTradeEntry } from "../../src/persistence/ledger.js";

function entry(id = "a"): LedgerTradeEntry {
  return {
    timestamp: "2026-09-10T00:00:00.000Z", mode: "live", status: "filled",
    eventSlug: `event-${id}`, marketSlug: `market-${id}`, tokenId: `token-${id}`,
    conditionId: `condition-${id}`, outcome: "Over", strategy: "total_over_locked",
    orderId: `order-${id}`, price: 0.97, shares: 10, notional: 9.7
  };
}

function resultLeg(id: string): TradeResultLeg {
  return {
    mode: "live", status: "filled", orderId: `order-${id}`, tokenId: `token-${id}`,
    price: 0.97, shares: 10, notional: 9.7, fee: 0.00873,
    estimatedPayout: 10, estimatedProfit: 0.29127
  };
}

const plannedLegs: BuyTradeLeg[] = ["a", "b"].map((id) => ({
  eventSlug: "basket-event", marketSlug: `market-${id}`, question: "O/U 0.5",
  tokenId: `token-${id}`, conditionId: `condition-${id}`, outcome: "Over",
  strategy: "total_over_locked", locked: true,
  price: 0.97, availableSize: 10, shares: 10, notional: 9.7,
  estimatedFee: 0.00873, estimatedNetReturn: 0.03
}));

function basketResult(): TradeResult {
  return {
    ...resultLeg("a"), orderId: "live-basket-order-a", shares: 20, notional: 19.4,
    fee: 0.01746, estimatedPayout: 20, estimatedProfit: 0.58254,
    legs: [resultLeg("a"), resultLeg("b")]
  };
}

async function temporaryLedger() {
  const dir = await mkdtemp(join(tmpdir(), "poly-ledger-recovery-"));
  const file = join(dir, "ledger.json");
  return { dir, file, ledger: new LiveLedger(file) };
}

describe("ledger recovery", () => {
  test("T2 serializes appends from separate instances of the same ledger", async () => {
    const { file, ledger } = await temporaryLedger();
    const expected = Array.from({ length: 12 }, (_, index) => entry(String(index)));

    await Promise.all(expected.map((trade) => new LiveLedger(file).recordTrade(trade)));

    expect(await ledger.readEntries()).toHaveLength(expected.length);
    expect(await ledger.readEntries()).toEqual(expect.arrayContaining(expected));
  });

  test("T2 concurrent settlement cannot overwrite a successfully recorded trade", async () => {
    const { file, ledger } = await temporaryLedger();
    await ledger.recordTrade(entry("a"));
    const settlementLedger = new LiveLedger(file);
    let signalSnapshot!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotTaken = new Promise<void>((resolve) => { signalSnapshot = resolve; });
    const resume = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const readSettlement = settlementLedger.readEntries.bind(settlementLedger);
    vi.spyOn(settlementLedger, "readEntries").mockImplementationOnce(async () => {
      const snapshot = await readSettlement();
      signalSnapshot();
      await resume;
      return snapshot;
    });
    let recordingReadStarted = false;
    const readTrades = ledger.readEntries.bind(ledger);
    vi.spyOn(ledger, "readEntries").mockImplementationOnce(async () => {
      recordingReadStarted = true;
      return readTrades();
    });

    const settlement = settlementLedger.markRedeemedByConditionIds(["condition-a"]);
    await snapshotTaken;
    const recording = ledger.recordTrade(entry("b"));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      // An unlocked writer can finish before the stale settlement snapshot resumes.
      // A serialized writer has not read yet and must wait for that snapshot's update.
      if (recordingReadStarted) await recording;
    } finally {
      releaseSnapshot();
      await Promise.all([settlement, recording]);
    }

    expect(await ledger.readEntries()).toEqual([
      { ...entry("a"), status: "redeemed" }, entry("b")
    ]);
    expect(await ledger.hasActiveEventTrade("event-b")).toBe(true);
  });

  test("T2 relative, normalized and symlink paths share one update queue", async () => {
    const { dir, file, ledger } = await temporaryLedger();
    await ledger.recordTrade(entry("seed"));
    await mkdir(join(dir, "nested"));
    await symlink(dir, join(dir, "alias"));
    await symlink(file, join(dir, "ledger-alias.json"));
    const aliases = [
      file, relative(process.cwd(), file), join(dir, "nested", "..", "ledger.json"),
      join(dir, "alias", "ledger.json"), join(dir, "ledger-alias.json")
    ];

    await Promise.all(aliases.map((alias, index) => new LiveLedger(alias).recordTrade(entry(String(index)))));

    expect(await ledger.readEntries()).toHaveLength(6);
    for (const alias of aliases) expect(await new LiveLedger(alias).readEntries()).toHaveLength(6);
  });

  test("T2 publishes complete replacement files without changing an already-open reader", async () => {
    const { file, ledger, dir } = await temporaryLedger();
    await ledger.recordTrade(entry("a"));
    const reader = await open(file, "r");
    try {
      await ledger.recordTrade(entry("b"));
      expect(JSON.parse(await reader.readFile("utf8"))).toEqual([entry("a")]);
    } finally {
      await reader.close();
    }
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([entry("a"), entry("b")]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["ledger.json"]);
  });

  test("T2 follows a ledger symlink even before its target file exists", async () => {
    const { dir } = await temporaryLedger();
    const target = join(dir, "new", "ledger.json");
    const alias = join(dir, "ledger-alias.json");
    await symlink("new/ledger.json", alias);

    await new LiveLedger(alias).recordTrade(entry("a"));
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    await new LiveLedger(target).recordTrade(entry("b"));
    expect(await new LiveLedger(alias).readEntries()).toEqual([entry("a"), entry("b")]);
  });

  test("T2 failed durability sync leaves the old ledger intact and releases the update queue", async () => {
    const { file, ledger, dir } = await temporaryLedger();
    await ledger.recordTrade(entry("a"));
    const reader = await open(file, "r");
    const sync = vi.spyOn(Object.getPrototypeOf(reader), "sync").mockRejectedValueOnce(new Error("disk sync failed"));
    try {
      await expect(new LiveLedger(file).recordTrade(entry("b"))).rejects.toThrow("disk sync failed");
    } finally {
      sync.mockRestore();
      await reader.close();
    }
    expect(await ledger.readEntries()).toEqual([entry("a")]);
    expect(await readdir(dir)).toEqual(["ledger.json"]);
    await new LiveLedger(file).recordTrade(entry("c"));
    expect(await ledger.readEntries()).toEqual([entry("a"), entry("c")]);
  });

  test.each([
    "{", "null", "{}", '[{"eventSlug":"event-a","tokenId":"token-a","status":"filled"}]',
    JSON.stringify([entry("a"), { ...entry("b"), status: "unknown" }]),
    JSON.stringify([{ ...entry("a"), legs: [{ tokenId: "token-b", status: "filled" }] }])
  ])("T2 refuses to treat corrupt ledger content as an empty safe ledger: %s", async (content) => {
    const { file, ledger } = await temporaryLedger();
    await writeFile(file, content);

    await expect(ledger.hasActiveEventTrade("event-a")).rejects.toThrow();
    await expect(ledger.recordTrade(entry("new"))).rejects.toThrow();
    await expect(ledger.markRedeemedByConditionIds(["condition-a"])).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(content);
  });

  test("O1 allocates a basket to its decision conditions and settles only the selected leg", async () => {
    const { ledger } = await temporaryLedger();
    await ledger.recordResult(buyDecisionFromLegs(plannedLegs), basketResult());

    expect(await ledger.hasActiveTrade("basket-event", "token-b")).toBe(true);
    expect(await ledger.readActiveEntries()).toEqual(plannedLegs.map((leg) => expect.objectContaining({
      tokenId: leg.tokenId, conditionId: leg.conditionId, marketSlug: leg.marketSlug,
      status: "filled", shares: 10, notional: 9.7
    })));

    await ledger.markRedeemedByConditionIds(["CONDITION-A"]);
    expect(await ledger.readActiveEntries()).toEqual([
      expect.objectContaining({ tokenId: "token-b", conditionId: "condition-b", notional: 9.7 })
    ]);
    expect(await ledger.hasActiveTrade("basket-event", "token-a")).toBe(false);
    expect(await ledger.hasActiveLockedEventTrade("basket-event")).toBe(true);
    expect((await ledger.readEntries())[0]?.status).toBe("partial");

    await ledger.markLostByConditionIds(["condition-b"]);
    expect(await ledger.readActiveEntries()).toEqual([]);
    expect((await ledger.readEntries())[0]?.legs).toEqual([
      expect.objectContaining({ conditionId: "condition-a", status: "redeemed" }),
      expect.objectContaining({ conditionId: "condition-b", status: "lost" })
    ]);
  });

  test("O1 maps a refreshed basket by the executed token when its original first leg was skipped", async () => {
    const { ledger } = await temporaryLedger();
    const result = { ...resultLeg("b"), legs: [resultLeg("b")] };
    await ledger.recordResult(buyDecisionFromLegs(plannedLegs), result);

    expect(await ledger.readActiveEntries()).toEqual([
      expect.objectContaining({ tokenId: "token-b", conditionId: "condition-b", marketSlug: "market-b" })
    ]);
    await ledger.markRedeemedByConditionIds(["condition-a"]);
    expect(await ledger.hasActiveTrade("basket-event", "token-b")).toBe(true);
  });

  test.each(["filled", "redeemed"] as const)("O1 retains unknown legacy basket conditions even if its parent is %s", async (status) => {
    const { file, ledger } = await temporaryLedger();
    await writeFile(file, JSON.stringify([{
      ...entry("a"), eventSlug: "basket-event", orderId: "live-basket-order-a",
      shares: 20, notional: 19.4, status, legs: [resultLeg("a"), resultLeg("b")]
    }]));

    expect(await ledger.hasActiveTrade("basket-event", "token-b")).toBe(true);
    await ledger.markRedeemedByConditionIds(["condition-a", "condition-b"]);
    expect(await ledger.readActiveEntries()).toEqual([
      expect.objectContaining({ tokenId: "token-b", conditionId: "", shares: 10, notional: 9.7 })
    ]);
    expect(await ledger.hasActiveEventTrade("basket-event")).toBe(true);
  });

  test("O1 retains legacy aggregate quantities that are missing from its leg breakdown", async () => {
    const { file, ledger } = await temporaryLedger();
    await writeFile(file, JSON.stringify([{
      ...entry("a"), orderId: "live-basket-order-a", shares: 20, notional: 19.4,
      legs: [resultLeg("a")]
    }]));

    await ledger.markRedeemedByConditionIds(["condition-a"]);
    const active = await ledger.readActiveEntries();
    expect(active.reduce((total, trade) => total + trade.notional, 0)).toBeCloseTo(9.7);
    expect(active).toEqual([expect.objectContaining({ status: "posted", conditionId: "", shares: 10 })]);
  });

  test("O1 cannot assign a legacy basket without a leg breakdown entirely to its first condition", async () => {
    const { file, ledger } = await temporaryLedger();
    await writeFile(file, JSON.stringify([{
      ...entry("a"), orderId: "live-basket-order-a", shares: 20, notional: 19.4
    }]));

    await ledger.markRedeemedByConditionIds(["condition-a"]);
    expect(await ledger.readActiveEntries()).toEqual([
      expect.objectContaining({ status: "posted", conditionId: "", shares: 20, notional: 19.4 })
    ]);
  });

  test("T1/O1 an uncertain submitted leg stays active when a known fill is redeemed", async () => {
    const { ledger } = await temporaryLedger();
    const result = basketResult();
    result.status = "partial";
    result.shares = 10;
    result.notional = 9.7;
    result.legs![1] = { ...resultLeg("b"), status: "posted", shares: 0, notional: 0, fee: 0, estimatedPayout: 0, estimatedProfit: 0 };
    await ledger.recordResult(buyDecisionFromLegs(plannedLegs), result);

    await ledger.markRedeemedByConditionIds(["condition-a"]);
    expect(await ledger.hasActiveTrade("basket-event", "token-a")).toBe(false);
    expect(await ledger.hasActiveTrade("basket-event", "token-b")).toBe(true);
    expect(await ledger.readActiveEntries()).toEqual([
      expect.objectContaining({ tokenId: "token-b", status: "posted", shares: 0, notional: 0 })
    ]);
  });

  test("T1/O1 redeeming a condition does not clear a still uncertain order for that same condition", async () => {
    const { ledger } = await temporaryLedger();
    await ledger.recordTrade(entry("a"));
    await ledger.recordTrade({ ...entry("a"), orderId: "unknown-order", status: "posted", shares: 0, notional: 0 });

    await ledger.markRedeemedByConditionIds(["condition-a"]);

    expect(await ledger.readActiveEntries()).toEqual([
      expect.objectContaining({ orderId: "unknown-order", status: "posted", shares: 0 })
    ]);
  });

  test("T1/O1 a basket's posted leg remains active even when its own condition is redeemed", async () => {
    const { ledger } = await temporaryLedger();
    const result = basketResult();
    result.status = "partial";
    result.shares = 10;
    result.notional = 9.7;
    result.legs![1] = { ...resultLeg("b"), status: "posted", shares: 0, notional: 0, fee: 0, estimatedPayout: 0, estimatedProfit: 0 };
    await ledger.recordResult(buyDecisionFromLegs(plannedLegs), result);

    await ledger.markRedeemedByConditionIds(["condition-a", "condition-b"]);

    expect(await ledger.readActiveEntries()).toEqual([
      expect.objectContaining({ tokenId: "token-b", status: "posted", shares: 0 })
    ]);
  });
});
