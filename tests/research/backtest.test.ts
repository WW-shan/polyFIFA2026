import { describe, expect, test } from "vitest";
import { backtestDataset } from "../../src/research/backtest.js";
import type { ResearchDataset, ResearchTrade } from "../../src/research/types.js";

const finish = 1_000_000;
const entry = finish - 300_000;
const trade = (id: string, timestampMs: number, price: number, size = 10, side: "BUY" | "SELL" = "SELL", tokenId = "A"): ResearchTrade => ({
  id, timestampMs, price, size, side, tokenId, conditionId: "condition", transactionHash: id
});
function dataset(trades: ResearchTrade[] = [trade("reference", entry - 10_000, .95, 10, "BUY"), trade("sell", entry + 10_000, .69, 3), trade("buy", entry + 20_000, .65, 10, "BUY")], payout = 0): ResearchDataset {
  return { schemaVersion: 1, kind: "public-trade-history", createdAt: "2026-09-11T00:00:00Z", warnings: [],
    selection: { sport: "tennis", tagId: "864", eventSlugs: [], marketTypes: [], maxEvents: 1, requireFinish: true,
      catalogPages: 1, catalogRows: 1, skippedNonMatches: 0, skippedMissingFinish: 0, catalogTruncated: false },
    events: [{ eventId: "event", eventSlug: "atp-a-b", title: "A vs B", sport: "tennis", gameId: "1", startMs: 0,
      startSource: "gamma.startTime", finishMs: finish, finishSource: "gamma.finishedTimestamp", raw: {},
      markets: [{ marketId: "market", conditionId: "condition", marketSlug: "a-b", question: "A vs B", marketType: "moneyline", horizon: "match",
        outcomes: [{ tokenId: "A", name: "A", payout }, { tokenId: "B", name: "B", payout: 1 - payout }],
        resolutionSource: "gamma-resolved-prices", raw: {}, trades,
        coverage: { status: "complete", reason: "api-window-exhausted", fromMs: 0, toMs: finish + 60_000, pages: 1,
          rawRows: trades.length, invalidRows: 0, duplicateRows: 0, oldestMs: trades[0]?.timestampMs ?? null, newestMs: trades.at(-1)?.timestampMs ?? null }
      }]
    }]
  };
}
const options = { prices: [.7], windowsSeconds: [300], shares: 5, entryMinPrice: .9 };

describe("advance resting BUY historical screen", () => {
  test("selects the then-favorite, counts partial SELL-through fills, never BUY prints, and books a losing payout", () => {
    const result = backtestDataset(dataset(), options);
    expect(result.basis).toBe("historical-public-trade-screen");
    expect(result.trials[0]).toMatchObject({ tokenId: "A", entryAtMs: entry, referencePrice: .95, exclusions: [], touchTradeCount: 2,
      touchShares: 13, sellThroughShares: 3, simulatedFilledShares: 3, payoutPerShare: 0 });
    expect(result.trials[0]?.simulatedCost).toBeCloseTo(2.1);
    expect(result.trials[0]?.simulatedPnl).toBeCloseTo(-2.1);
    expect(result.summaries[0]).toMatchObject({ eligibleTrials: 1, filledTrials: 1, losingFills: 1, winningFills: 0 });
  });
  test("future resolution never changes side selection, entry or filled quantity", () => {
    const loser = backtestDataset(dataset(undefined, 0), options).trials[0]!;
    const winner = backtestDataset(dataset(undefined, 1), options).trials[0]!;
    expect([winner.tokenId, winner.entryAtMs, winner.simulatedFilledShares]).toEqual([loser.tokenId, loser.entryAtMs, loser.simulatedFilledShares]);
    expect(winner.simulatedPnl).toBeCloseTo(.9);
  });
  test("uses the binary complement of the latest trade as a labeled entry signal, not a fabricated fill", () => {
    const result = backtestDataset(dataset([trade("ref-B", entry - 5000, .04, 10, "BUY", "B"), trade("sell-A", entry + 10_000, .69, 2)]), options);
    expect(result.trials[0]).toMatchObject({ tokenId: "A", referencePrice: .96, referenceBasis: "last-second-trades-binary-complement", simulatedFilledShares: 2 });
  });
  test("same-second ordering cannot manufacture an entry-before-dip", () => {
    const data = dataset([trade("ref", entry, .95), trade("dip", entry, .69)]);
    expect(backtestDataset(data, options).trials[0]?.exclusions).toContain("missing-entry-reference");
  });
  test("uses a conservative price across ambiguous same-second references", () => {
    const data = dataset([trade("ref1", entry - 1000, .95), trade("ref2", entry - 1000, .85), trade("dip", entry + 1000, .69)]);
    const trial = backtestDataset(data, options).trials[0]!;
    expect(trial.referencePrice).toBe(.85);
    expect(trial.exclusions).toContain("entry-below-threshold");
    expect(trial.simulatedFilledShares).toBe(0);
  });
  test("equality is touch evidence only in the default model", () => {
    const data = dataset([trade("ref", entry - 1000, .95), trade("equal", entry + 1000, .7, 20)]);
    expect(backtestDataset(data, options).trials[0]).toMatchObject({ touchTradeCount: 1, equalSellShares: 20, simulatedFilledShares: 0, simulatedPnl: 0 });
  });
  test("equal-price queue ahead consumes volume before our partial fill in the equality scenario", () => {
    const data = dataset([trade("ref", entry - 1000, .95), trade("equal", entry + 1000, .7, 12)]);
    const trial = backtestDataset(data, { ...options, fillModel: "sell-at-or-below", queueAheadShares: 10 }).trials[0]!;
    expect(trial.simulatedFilledShares).toBe(2);
    expect(trial.simulatedCost).toBeCloseTo(1.4);
  });
  test("equality can clear the queue before a later strict-through fill", () => {
    const data = dataset([trade("ref", entry - 1000, .95), trade("equal", entry + 1000, .7, 10), trade("through", entry + 2000, .69, 3)]);
    expect(backtestDataset(data, { ...options, queueAheadShares: 10 }).trials[0]?.simulatedFilledShares).toBe(3);
  });
  test("does not turn exchange decimal rounding near equality into a through fill", () => {
    const data = dataset([trade("ref", entry - 1000, .95), trade("equal", entry + 1000, .69999996, 20)]);
    expect(backtestDataset(data, options).trials[0]?.simulatedFilledShares).toBe(0);
  });
  test("ignores repeated IDs and is independent of input trade ordering", () => {
    const a = trade("ref", entry - 1000, .95), b = trade("dip", entry + 1000, .69, 3);
    expect(backtestDataset(dataset([b, a, b]), options).trials[0]?.simulatedFilledShares).toBe(3);
  });
  test("price grids and overlapping windows are separate scenarios, not summed portfolio profit", () => {
    const result = backtestDataset(dataset(undefined, 1), { ...options, prices: [.6, .7, .7], windowsSeconds: [300, 300] });
    expect(result.trials).toHaveLength(2);
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries.find(s => s.bidPrice === .6)).toMatchObject({ eligibleTrials: 1, unfilledTrials: 1, simulatedPnl: 0 });
  });
  test("a 50-50 payout is not a win at a .7 bid", () => {
    const result = backtestDataset(dataset(undefined, .5), options);
    expect(result.trials[0]?.simulatedPnl).toBeCloseTo(-.6);
    expect(result.summaries[0]?.splitPayoutFills).toBe(1);
  });
  test("cost uses our limit, not the better historical print, and maker fee is configurable", () => {
    const trial = backtestDataset(dataset(undefined, 1), { ...options, makerFeeBps: 100 }).trials[0]!;
    expect(trial.simulatedFee).toBeCloseTo(.021);
    expect(trial.simulatedPnl).toBeCloseTo(.879);
  });
});

describe("missing and ineligible samples", () => {
  test("unknown finish is retained with an exclusion, never replaced by a metadata expiry", () => {
    const data = dataset(); data.events[0]!.finishMs = null; data.events[0]!.finishSource = null;
    data.events[0]!.raw.endDate = new Date(finish).toISOString();
    expect(backtestDataset(data, options).trials[0]?.exclusions).toContain("missing-actual-finish");
  });
  test("set-level markets cannot use the whole-match finish as their set finish", () => {
    const data = dataset(); data.events[0]!.markets[0]!.horizon = "set";
    expect(backtestDataset(data, options).trials[0]?.exclusions).toContain("market-horizon-not-match");
  });
  test("missing and stale entry prices are not silently counted as unfilled opportunities", () => {
    const missing = backtestDataset(dataset([]), options);
    expect(missing.summaries[0]).toMatchObject({ excludedTrials: 1, unfilledTrials: 0, eligibleTrials: 0 });
    const stale = backtestDataset(dataset([trade("stale", entry - 121_000, .95)]), options);
    expect(stale.trials[0]?.exclusions).toContain("stale-entry-reference");
  });
  test("does not assume absent trades in a truncated window mean no fills", () => {
    const data = dataset(); data.events[0]!.markets[0]!.coverage!.status = "incomplete";
    const result = backtestDataset(data, options);
    expect(result.trials[0]?.exclusions).toContain("incomplete-trade-history");
    expect(result.summaries[0]).toMatchObject({ eligibleTrials: 0, excludedTrials: 1, simulatedPnl: 0 });
  });
  test("coverage must include the entire resting interval", () => {
    const data = dataset(); data.events[0]!.markets[0]!.coverage!.toMs = finish - 1000;
    expect(backtestDataset(data, options).trials[0]?.exclusions).toContain("resting-window-not-covered");
  });
  test("unresolved payouts preserve evidence but do not contribute to profit totals", () => {
    const data = dataset(); data.events[0]!.markets[0]!.outcomes.forEach(o => { o.payout = null; });
    data.events[0]!.markets[0]!.resolutionSource = "unresolved";
    const result = backtestDataset(data, options);
    expect(result.trials[0]).toMatchObject({ simulatedFilledShares: 3, simulatedPnl: null });
    expect(result.trials[0]?.exclusions).toContain("unresolved-payout");
    expect(result.summaries[0]?.simulatedPnl).toBe(0);
  });
  test("a limit at or above the entry signal is excluded from a resting-order screen", () => {
    const result = backtestDataset(dataset(), { ...options, prices: [.97] });
    expect(result.trials[0]?.exclusions).toContain("bid-not-below-reference");
  });
});

describe("price-trigger entries", () => {
  test("entry is triggered by observed price with a fixed lifetime and does not move when the finish moves", () => {
    const data = dataset([trade("low", 100_000, .8), trade("ref", 200_000, .95), trade("dip", 210_000, .69, 3)]);
    const config = { ...options, entryMode: "price-trigger" as const, windowsSeconds: [60] };
    const before = backtestDataset(data, config).trials[0]!;
    data.events[0]!.finishMs = finish + 30_000;
    const after = backtestDataset(data, config).trials[0]!;
    expect(before).toMatchObject({ entryAtMs: 201_000, expiryAtMs: 261_000, simulatedFilledShares: 3 });
    expect(after.entryAtMs).toBe(before.entryAtMs);
  });
  test("does not fill beyond the specified holding duration", () => {
    const data = dataset([trade("ref", 200_000, .95), trade("too-late", 300_000, .69, 3)]);
    expect(backtestDataset(data, { ...options, entryMode: "price-trigger", windowsSeconds: [60] }).trials[0]?.simulatedFilledShares).toBe(0);
  });
  test("eventual finish labels cannot censor a price-trigger decision at the same signal", () => {
    const data = dataset([trade("ref", 200_000, .95), trade("dip", 210_000, .69, 3)]);
    const config = { ...options, entryMode: "price-trigger" as const, windowsSeconds: [60] };
    const before = backtestDataset(data, config).trials[0]!;
    data.events[0]!.finishMs = 201_000;
    const after = backtestDataset(data, config).trials[0]!;
    expect(after.entryAtMs).toBe(before.entryAtMs);
    expect(after.tokenId).toBe(before.tokenId);
    expect(after.expiryAtMs).toBe(before.expiryAtMs);
  });
});

describe("research input validation", () => {
  test.each([{ prices: [] }, { prices: [0] }, { prices: [1] }, { prices: [NaN] }, { windowsSeconds: [-1] }, { windowsSeconds: [] },
    { shares: 0 }, { entryMinPrice: 1.1 }, { queueAheadShares: -1 }, { makerFeeBps: -1 }, { maxEntryAgeSeconds: 0 }])("rejects invalid parameters %j", bad => {
    expect(() => backtestDataset(dataset(), { ...options, ...bad })).toThrow("RESEARCH_OPTIONS_INVALID");
  });
  test("rejects wrong schema and non-finite trade data before simulation", () => {
    expect(() => backtestDataset({ ...dataset(), schemaVersion: 2 } as unknown as ResearchDataset, options)).toThrow("RESEARCH_DATASET_INVALID");
    const data = dataset(); data.events[0]!.markets[0]!.trades[0]!.price = NaN;
    expect(() => backtestDataset(data, options)).toThrow("RESEARCH_DATASET_INVALID");
  });
  test("rejects a corrupted payout vector instead of treating both outcomes as winning", () => {
    const data = dataset(); data.events[0]!.markets[0]!.outcomes.forEach(o => { o.payout = 1; });
    expect(() => backtestDataset(data, options)).toThrow("RESEARCH_DATASET_INVALID");
  });
  test("requires a known resolution provenance and a fully populated payout vector", () => {
    const unknown = dataset();
    unknown.events[0]!.markets[0]!.resolutionSource = "unchecked-price" as never;
    expect(() => backtestDataset(unknown, options)).toThrow("RESEARCH_DATASET_INVALID");
    const partial = dataset(); partial.events[0]!.markets[0]!.outcomes[1]!.payout = null;
    expect(() => backtestDataset(partial, options)).toThrow("RESEARCH_DATASET_INVALID");
  });
  test("cannot count a repeated condition in another event as independent profit", () => {
    const data = dataset();
    data.events.push({ ...data.events[0]!, eventId: "alias", eventSlug: "parent-alias" });
    expect(() => backtestDataset(data, options)).toThrow("RESEARCH_DATASET_INVALID");
  });
  test("unknown coverage statuses are invalid, not complete", () => {
    const data = dataset(); data.events[0]!.markets[0]!.coverage!.status = "assumed" as never;
    expect(() => backtestDataset(data, options)).toThrow("RESEARCH_DATASET_INVALID");
  });
});
