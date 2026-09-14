import { describe, expect, test } from "vitest";
import { emptyReplayQuality } from "../../src/collector/replay-types.js";
import type { TailBookChange, TailBookStatus, TailSecond, TailSummary } from "../../src/collector/tail-types.js";
import { backtestTailArchives } from "../../src/research/tail-backtest.js";
import type { TailBacktestInput, TailBacktestOptions } from "../../src/research/tail-backtest-types.js";

const finish = 1_000_000;
const entry = finish - 3_000;
const options: TailBacktestOptions = { prices: ["0.70"], windowsSeconds: [3], shares: 5 };

function setBook(row: TailSecond, bid: string | null, ask: string | null, observedAtMs = row.bookObservedAtMs!): void {
  row.bestBid = bid; row.bestAsk = ask;
  row.bids = bid === null ? [] : [{ price: bid, size: "10" }];
  row.asks = ask === null ? [] : [{ price: ask, size: "12" }];
  row.bookObservedAtMs = observedAtMs; row.bookSourceAtMs = observedAtMs;
  row.bookAgeMs = row.endAtMs - observedAtMs;
  row.minBestBid = row.maxBestBid = bid === null ? null : Number(bid);
  row.minBestAsk = row.maxBestAsk = ask === null ? null : Number(ask);
}

/** Typed, entirely synthetic archives; no collector, filesystem, network or services. */
function archive(archiveSeconds = 4): TailBacktestInput {
  const start = finish - archiveSeconds * 1_000;
  const markets = ["A", "B"].map(tokenId => ({ eventId: "event", eventSlug: "a-b", gameId: "g",
    marketId: "market", marketSlug: "winner", conditionId: "condition", tokenId, outcome: tokenId,
    question: "A vs B", marketType: "moneyline", closed: false, acceptingOrders: true, raw: {} }));
  const summary: TailSummary = {
    schemaVersion: 1, basis: "received-order-book-tail", runId: "run", firstReceivedAtMs: start - 1_000,
    lastReceivedAtMs: finish + 1_000, windowSeconds: archiveSeconds, records: 100, seconds: archiveSeconds * 2,
    changes: 0, stateChanges: 0, audits: 2, warnings: [], journalQuality: emptyReplayQuality(),
    windows: [{ key: "game:g", gameId: "g", eventIds: ["event"], eventSlugs: ["a-b"], title: "A vs B",
      startAtMs: start, endAtMs: finish, finishSources: ["gamma.finishedTimestamp"], finishConflict: false,
      finishEvidence: [{ atMs: finish, observedAtMs: finish + 100, source: "gamma.finishedTimestamp", eventSlug: "a-b" }], markets }],
    tokens: markets.map(market => ({ windowKey: "game:g", tokenId: market.tokenId, marketId: market.marketId,
      outcome: market.outcome, marketType: market.marketType, expectedSeconds: archiveSeconds, validSeconds: archiveSeconds,
      closedSeconds: 0, partialSeconds: 0, missingSeconds: 0, staleSeconds: 0, contextSeconds: archiveSeconds,
      snapshotMatches: 1, snapshotMismatches: 0, snapshotNotComparable: 0,
      seedSnapshotMatches: 0, seedSnapshotMismatches: 0, seedSnapshotNotComparable: 0,
      observedWindowComplete: true, snapshotAuditPassed: true, readyForReplay: true, reasons: [] }))
  };
  const seconds: TailSecond[] = markets.flatMap(market => Array.from({ length: archiveSeconds }, (_, secondIndex) => {
    const startAtMs = start + secondIndex * 1_000;
    const row: TailSecond = { windowKey: "game:g", eventSlug: market.eventSlug, gameId: market.gameId,
      marketId: market.marketId, conditionId: market.conditionId, question: market.question, marketType: market.marketType,
      tokenId: market.tokenId, outcome: market.outcome, secondIndex, startAtMs, endAtMs: startAtMs + 1_000,
      secondsBeforeFinish: archiveSeconds - secondIndex, status: "carried", wholeSecondValid: true, connectionId: "clob",
      bids: [], asks: [], bookObservedAtMs: start - 10, bookSourceAtMs: start - 10, bookAgeMs: 0, feedAgeMs: 1,
      bookHash: "hash", bestBid: null, bestAsk: null, minBestBid: null, maxBestBid: null, minBestAsk: null, maxBestAsk: null,
      bookUpdates: 0, tradeCount: 0, tradeShares: 0, contextSource: "sports-ws", contextObservedAtMs: start - 10,
      contextSourceAtMs: start - 10, contextAgeMs: startAtMs + 1_000 - (start - 10), contextStatus: "present",
      score: "1-0", period: "match", clock: null, stateChangeCount: 0, reasons: [] };
    setBook(row, market.tokenId === "A" ? "0.95" : "0.03", market.tokenId === "A" ? "0.97" : "0.05");
    return row;
  }));
  return { sourceId: "synthetic", sport: "tennis", summary, seconds, changes: [], settlements: markets.map(market => ({
    marketId: market.marketId, conditionId: market.conditionId, tokenId: market.tokenId, payout: market.tokenId === "B" ? 1 : 0,
    source: "gamma-resolved-prices", observedAtMs: finish + 500, sourceUrl: "https://gamma-api.polymarket.com/markets/market" })) };
}

function trade(sequence: number, observedAtMs: number, price = "0.69", size = "3", side = "SELL", tokenId = "A"): TailBookChange {
  return { windowKey: "game:g", tokenId, sequence, frameIndex: 0, observedAtMs, sourceAtMs: observedAtMs - 1,
    kind: "trade", price, size, side };
}
function book(sequence: number, observedAtMs: number, bestBid: string, bestAsk: string, tokenId = "A"): TailBookChange {
  return { windowKey: "game:g", tokenId, sequence, frameIndex: 0, observedAtMs, sourceAtMs: observedAtMs,
    kind: "book", bestBid, bestAsk };
}
function withChanges(data: TailBacktestInput, changes: TailBookChange[]): TailBacktestInput {
  data.changes = changes; data.summary.changes = changes.length;
  for (const token of data.summary.tokens) {
    const rows = data.seconds.filter(row => row.tokenId === token.tokenId).sort((a, b) => a.startAtMs - b.startAtMs);
    let bid = rows[0]!.bestBid, ask = rows[0]!.bestAsk, observed = rows[0]!.bookObservedAtMs!;
    for (const row of rows) {
      const inSecond = changes.filter(change => change.tokenId === row.tokenId && change.observedAtMs >= row.startAtMs && change.observedAtMs < row.endAtMs)
        .sort((a, b) => a.observedAtMs - b.observedAtMs || a.sequence - b.sequence || a.frameIndex - b.frameIndex);
      row.bookUpdates = inSecond.filter(change => change.kind === "book").length;
      row.tradeCount = inSecond.filter(change => change.kind === "trade").length;
      row.tradeShares = inSecond.reduce((sum, change) => sum + (change.kind === "trade" ? Number(change.size) : 0), 0);
      const asks = [ask], bids = [bid];
      for (const change of inSecond) if (change.kind === "book") {
        bid = change.bestBid ?? null; ask = change.bestAsk ?? null; observed = change.observedAtMs;
        asks.push(ask); bids.push(bid);
      }
      setBook(row, bid, ask, observed);
      row.status = row.bookUpdates ? "observed" : "carried";
      row.minBestAsk = Math.min(...asks.filter(value => value !== null).map(Number));
      row.maxBestAsk = Math.max(...asks.filter(value => value !== null).map(Number));
      row.minBestBid = Math.min(...bids.filter(value => value !== null).map(Number));
      row.maxBestBid = Math.max(...bids.filter(value => value !== null).map(Number));
    }
  }
  return data;
}

function distinctGame(data: TailBacktestInput, gameId: string): TailBacktestInput {
  const result = structuredClone(data), window = result.summary.windows[0]!;
  result.sourceId = gameId; result.summary.runId = `run-${gameId}`;
  window.key = `game:${gameId}`; window.gameId = gameId; window.eventIds = [`event-${gameId}`]; window.eventSlugs = [`slug-${gameId}`];
  window.finishEvidence?.forEach(fact => { fact.eventSlug = window.eventSlugs[0]!; });
  for (const market of window.markets) Object.assign(market, { eventId: window.eventIds[0], eventSlug: window.eventSlugs[0], gameId,
    marketId: `market-${gameId}`, conditionId: `condition-${gameId}`, tokenId: `${gameId}-${market.tokenId}` });
  for (const quality of result.summary.tokens) Object.assign(quality, { windowKey: window.key, marketId: `market-${gameId}`, tokenId: `${gameId}-${quality.tokenId}` });
  for (const row of result.seconds) Object.assign(row, { windowKey: window.key, eventSlug: window.eventSlugs[0], gameId,
    marketId: `market-${gameId}`, conditionId: `condition-${gameId}`, tokenId: `${gameId}-${row.tokenId}` });
  for (const change of result.changes) Object.assign(change, { windowKey: window.key, tokenId: `${gameId}-${change.tokenId}` });
  for (const settlement of result.settlements ?? []) Object.assign(settlement, { marketId: `market-${gameId}`, conditionId: `condition-${gameId}`, tokenId: `${gameId}-${settlement.tokenId}` });
  return result;
}

describe("collected orderbook ex-ante entry", () => {
  test("selects the observed favorite even when it loses, and labels the fill as hypothetical", () => {
    const data = withChanges(archive(), [trade(1, entry + 100)]);
    const result = backtestTailArchives([data], options);
    expect(result.basis).toBe("received-order-book-tail");
    expect(result.execution).toBe("hypothetical");
    expect(result.trials).toHaveLength(1);
    expect(result.trials[0]).toMatchObject({ sourceId: "synthetic", sourceRunId: "run", windowKey: "game:g", gameId: "g",
      eventId: "event", eventSlug: "a-b", marketId: "market", conditionId: "condition", tokenId: "A", outcome: "A",
      windowBasis: "match-finish", entryAtMs: entry, expiryAtMs: finish, referenceAtMs: entry,
      referenceBid: "0.95", referenceAsk: "0.97", bidPrice: "0.70", exclusions: [], eligible: true, pnlEligible: true,
      fillModel: "quote-touch-assumed", modeledFilledShares: 5, modeledCost: 3.5, modeledFee: 0, modeledPnl: -3.5,
      payoutPerShare: 0, settlement: { tokenId: "A", source: "gamma-resolved-prices" } });
    expect(result.trials[0]?.entryReferences.map(reference => reference.tokenId)).toEqual(["A", "B"]);
    expect(result.summaries[0]).toMatchObject({ eligibleTrials: 1, modeledFilledTrials: 1, losingFills: 1, winningFills: 0 });
    expect(result.warnings.join(" ")).toMatch(/assum.*queue|queue.*assum/i);
    const changed = structuredClone(data);
    changed.settlements!.forEach(settlement => { settlement.payout = 1 - settlement.payout; });
    const winner = backtestTailArchives([changed], options).trials[0]!;
    expect([winner.tokenId, winner.entryAtMs, winner.modeledFilledShares]).toEqual(["A", entry, 5]);
    expect(winner.modeledPnl).toBe(1.5);
  });

  test("the second starting at entry cannot leak its future or boundary book into the reference", () => {
    const data = withChanges(archive(), [book(1, entry, "0.10", "0.20"), book(2, entry + 1, "0.98", "0.99", "B")]);
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ tokenId: "A", referenceStartAtMs: entry - 1_000,
      referenceAtMs: entry, referenceBid: "0.95", referenceAsk: "0.97", firstTouchAtMs: entry });
  });

  test("exact 300-second entry requires a prior complete second supplied by a 301-second archive", () => {
    const config = { ...options, windowsSeconds: [300] };
    const excluded = backtestTailArchives([archive(300)], config).trials[0]!;
    expect(excluded.exclusions).toContain("missing-entry-reference");
    expect(excluded.modeledFilledShares).toBeNull();
    expect(backtestTailArchives([archive(301)], config).trials[0]).toMatchObject({ exclusions: [], referenceAtMs: finish - 300_000 });
  });

  test("needs every outcome's entry book", () => {
    const data = archive(); data.seconds = data.seconds.filter(row => !(row.tokenId === "B" && row.secondIndex === 0));
    const result = backtestTailArchives([data], options);
    expect(result.trials[0]?.exclusions).toContain("missing-entry-reference");
    expect(result.summaries[0]).toMatchObject({ eligibleTrials: 0, zeroFillTrials: 0 });
  });

  test("ties use exact token IDs in lexical order, independently of outcome and settlement order", () => {
    const data = archive();
    for (const row of data.seconds) setBook(row, "0.95", "0.97");
    data.summary.windows[0]!.markets.reverse(); data.summary.tokens.reverse();
    data.seconds = [...data.seconds].reverse(); data.settlements = [...data.settlements!].reverse();
    expect(backtestTailArchives([data], options).trials[0]?.tokenId).toBe("A");
  });

  test("compares decimal strings beyond Number precision and retains their original spelling", () => {
    const data = archive();
    for (const row of data.seconds) setBook(row, row.tokenId === "A" ? "0.900000000000000000001" : "0.900000000000000000002", "0.9700");
    const result = backtestTailArchives([data], { ...options, prices: ["00.7000"], entryMinBid: "0.9000000000000000000015" });
    expect(result.trials[0]).toMatchObject({ tokenId: "B", bidPrice: "00.7000", referenceBid: "0.900000000000000000002", referenceAsk: "0.9700", exclusions: [] });
  });

  test("the entry bid threshold and resting limit below the available ask are distinct", () => {
    expect(backtestTailArchives([archive()], { ...options, entryMinBid: "0.950000000000000000001" }).trials[0]?.exclusions).toContain("entry-below-threshold");
    expect(backtestTailArchives([archive()], { ...options, prices: ["0.96"] }).trials[0]?.exclusions).toEqual([]);
    for (const price of ["0.970", "0.98"]) expect(backtestTailArchives([archive()], { ...options, prices: [price] }).trials[0]?.exclusions).toContain("limit-not-below-entry-ask");
    const emptyAsk = archive();
    for (const row of emptyAsk.seconds.filter(row => row.tokenId === "A")) setBook(row, "0.95", null);
    expect(backtestTailArchives([emptyAsk], options).trials[0]?.exclusions).toContain("missing-entry-ask");
  });
});

describe("touch evidence and strict SELL volume", () => {
  test("sees an intra-second ask dip and rebound that the second's closing quote hides", () => {
    const data = withChanges(archive(), [book(1, entry + 100, "0.60", "0.65"), book(2, entry + 900, "0.95", "0.97")]);
    const trial = backtestTailArchives([data], options).trials[0]!;
    expect(trial).toMatchObject({ touchBookChangeCount: 1, touchSecondCount: 0, touchTradeCount: 0, sellThroughShares: 0,
      firstTouchAtMs: entry + 100, modeledFilledShares: 5,
      firstTouch: { kind: "book-ask", evidenceSource: "change", price: "0.65", sequence: 1, frameIndex: 0, observedAtMs: entry + 100 } });
    expect(backtestTailArchives([data], { ...options, fillModel: "sell-through-volume" }).trials[0]?.modeledFilledShares).toBe(0);
  });

  test("a falling bid alone and BUY prints cannot create touches or fills", () => {
    const data = withChanges(archive(), [book(1, entry + 100, "0.50", "0.97"), trade(2, entry + 200, "0.50", "20", "BUY")]);
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ touched: false, firstTouch: null, modeledFilledShares: 0, modeledPnl: 0 });
  });

  test("SELL equality supplies touch evidence but no strict-through volume or queue consumption", () => {
    const data = withChanges(archive(), [trade(1, entry + 100, "0.7000", "100"), trade(2, entry + 200, "0.69", "4")]);
    const trial = backtestTailArchives([data], { ...options, fillModel: "sell-through-volume", queueAheadShares: 3 }).trials[0]!;
    expect(trial).toMatchObject({ touchTradeCount: 2, equalSellShares: 100, sellThroughShares: 4, sellThroughTradeCount: 1,
      modeledFilledShares: 1, firstTouchAtMs: entry + 100, firstModeledFillAtMs: entry + 200 });
  });

  test("subtracts fixed queue ahead once, accumulates strict SELL volume and caps at requested size", () => {
    const data = withChanges(archive(), [trade(1, entry + 100, "0.69", "3"), trade(2, entry + 200, "0.68", "4"),
      trade(3, entry + 300, "0.60", "100", "BUY"), trade(4, entry + 400, "0.67", "100")]);
    expect(backtestTailArchives([data], { ...options, fillModel: "sell-through-volume", queueAheadShares: 5 }).trials[0]).toMatchObject({
      modeledFilledShares: 5, sellThroughShares: 107, firstModeledFillAtMs: entry + 200, modeledCost: 3.5 });
    expect(backtestTailArchives([data], { ...options, fillModel: "sell-through-volume", queueAheadShares: 200 }).trials[0]?.modeledFilledShares).toBe(0);
  });

  test("uses exact decimal equality and strict-through comparisons, including fractional queue arithmetic", () => {
    const above = withChanges(archive(), [trade(1, entry + 100, "0.700000000000000000001", "100")]);
    expect(backtestTailArchives([above], options).trials[0]?.modeledFilledShares).toBe(0);
    const below = withChanges(archive(), [trade(1, entry + 100, "0.699999999999999999999", "0.1"),
      trade(2, entry + 200, "0.69", "0.2"), trade(3, entry + 300, "0.68", "0.1")]);
    expect(backtestTailArchives([below], { ...options, fillModel: "sell-through-volume", queueAheadShares: 0.3 }).trials[0]).toMatchObject({
      sellThroughShares: 0.4, modeledFilledShares: 0.1, firstModeledFillAtMs: entry + 300 });
  });

  test("charges the modeled limit cost and configured fee, with partial payouts judged by net PnL", () => {
    const data = withChanges(archive(), [trade(1, entry + 100, "0.10", "2")]);
    data.settlements!.forEach(settlement => { settlement.payout = 0.5; });
    const result = backtestTailArchives([data], { ...options, fillModel: "sell-through-volume", makerFeeBps: 100 });
    expect(result.trials[0]).toMatchObject({ modeledFilledShares: 2, modeledCost: 1.4, modeledFee: 0.014, modeledPayout: 1, modeledPnl: -0.414 });
    expect(result.summaries[0]).toMatchObject({ losingFills: 1, winningFills: 0, splitPayoutFills: 1 });
  });

  test("input ordering cannot alter evidence ordering and input objects are not mutated", () => {
    const data = withChanges(archive(), [trade(2, entry + 200), trade(1, entry + 100)]);
    data.seconds = [...data.seconds].reverse(); const before = structuredClone(data);
    expect(backtestTailArchives([data], options).trials[0]?.firstTouchAtMs).toBe(entry + 100);
    expect(data).toEqual(before);
  });
});

describe("coverage, exclusions and outcome accounting", () => {
  test.each<TailBookStatus>(["partial", "missing", "invalid", "feed_stale", "outside_run", "not_yet_known"])("%s holding data is excluded even if aggregate flags claim completeness", status => {
    const data = archive(); const row = data.seconds.find(row => row.tokenId === "A" && row.secondIndex === 2)!;
    row.status = status; row.wholeSecondValid = false;
    const result = backtestTailArchives([data], options); const trial = result.trials[0]!;
    expect(trial.exclusions).toContain("holding-data-incomplete");
    expect(trial.priceCoverage.complete).toBe(false);
    expect(trial.modeledFilledShares).toBeNull(); expect(trial.modeledPnl).toBeNull();
    expect(result.summaries[0]).toMatchObject({ excludedTrials: 1, zeroFillTrials: 0, pnlEligibleTrials: 0 });
  });

  test("a missing holding row cannot be an observed zero fill", () => {
    const data = archive(); data.seconds = data.seconds.filter(row => !(row.tokenId === "A" && row.secondIndex === 2));
    const trial = backtestTailArchives([data], options).trials[0]!;
    expect(trial.priceCoverage).toMatchObject({ absentSeconds: 1, missingSeconds: 0, complete: false });
    expect(trial.exclusions).toContain("holding-data-incomplete"); expect(trial.modeledCost).toBeNull();
  });

  test("observed closed rows retain their own coverage category and cannot create fills", () => {
    const data = archive();
    for (const row of data.seconds.filter(row => row.tokenId === "A" && row.secondIndex >= 2)) {
      row.status = "closed"; row.wholeSecondValid = false; row.bestBid = row.bestAsk = null; row.bids = row.asks = null;
    }
    Object.assign(data.summary.tokens[0]!, { validSeconds: 2, closedSeconds: 2 });
    const trial = backtestTailArchives([data], options).trials[0]!;
    expect(trial).toMatchObject({ eligible: true, modeledFilledShares: 0, modeledPnl: 0,
      priceCoverage: { validSeconds: 1, closedSeconds: 2, missingSeconds: 0, absentSeconds: 0, complete: true } });
  });

  test("missing context is displayed separately and gates only when requested", () => {
    const data = archive();
    for (const row of data.seconds) { row.contextStatus = "stale"; row.reasons = ["context-stale"]; }
    for (const quality of data.summary.tokens) Object.assign(quality, { contextSeconds: 0, readyForReplay: false, reasons: ["context-stale"] });
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ eligible: true, priceCoverage: { complete: true },
      contextCoverage: { complete: false, staleSeconds: 3 }, modeledPnl: 0 });
    expect(backtestTailArchives([data], { ...options, requireFreshContext: true }).trials[0]?.exclusions).toContain("context-not-fresh");
  });

  test.each(["observedWindowComplete", "snapshotAuditPassed"] as const)("requires existing token quality %s", flag => {
    const data = archive(); data.summary.tokens[0]![flag] = false;
    expect(backtestTailArchives([data], options).trials[0]?.eligible).toBe(false);
  });

  test("source-clock diagnostics and wall-clock affected bins cannot be precise holding evidence", () => {
    for (const reason of ["book-source-clock-invalid", "receipt-wall-clock-backstep"]) {
      const data = archive(); data.seconds[2]!.reasons.push(reason);
      expect(backtestTailArchives([data], options).trials[0]?.exclusions).toContain("clock-affected-data");
    }
  });

  test("no finish, conflicting witnesses, and an endDate cannot invent a finish", () => {
    const missing = archive(); const window = missing.summary.windows[0]!;
    window.startAtMs = window.endAtMs = null; window.finishSources = []; window.finishEvidence = [];
    window.markets.forEach(market => { market.raw.endDate = new Date(finish).toISOString(); });
    missing.seconds = []; missing.summary.seconds = 0;
    expect(backtestTailArchives([missing], options).trials[0]).toMatchObject({ entryAtMs: null, expiryAtMs: null, modeledPnl: null });
    expect(backtestTailArchives([missing], options).trials[0]?.exclusions).toContain("missing-actual-finish");
    const conflict = archive(); conflict.summary.windows[0]!.finishEvidence!.push({ atMs: finish + 1_000,
      observedAtMs: finish + 500, source: "sports.finishedAt", eventSlug: "a-b" });
    conflict.summary.windows[0]!.finishSources.push("sports.finishedAt");
    expect(backtestTailArchives([conflict], options).trials[0]?.exclusions).toContain("conflicting-finish-labels");
  });

  test("per-set market types explicitly retain the match-finish window basis", () => {
    const data = archive();
    data.summary.windows[0]!.markets.forEach(market => { market.marketType = "set_winner"; });
    data.summary.tokens.forEach(token => { token.marketType = "set_winner"; });
    data.seconds.forEach(row => { row.marketType = "set_winner"; });
    const result = backtestTailArchives([data], options);
    expect(result.trials[0]).toMatchObject({ windowBasis: "match-finish", entryAtMs: entry, marketType: "set_winner" });
    expect(result.warnings.join(" ")).toMatch(/per-set|set finish/i);
  });

  test("truncated change evidence or a persistent invalidation excludes an otherwise valid-looking window", () => {
    const truncated = withChanges(archive(), [trade(1, entry + 100)]); truncated.changes = [];
    expect(backtestTailArchives([truncated], options).trials[0]?.exclusions).toContain("change-count-mismatch");
    const invalid = withChanges(archive(), [{ windowKey: "game:g", tokenId: "A", sequence: 1, frameIndex: -1,
      observedAtMs: entry + 100, sourceAtMs: null, kind: "invalidation", data: { reason: "connection_gap", provisional: false } }]);
    expect(backtestTailArchives([invalid], options).trials[0]?.exclusions).toContain("holding-data-incomplete");
  });

  test("filled unresolved trials retain null PnL and do not enter profit denominators", () => {
    const data = withChanges(archive(), [trade(1, entry + 100)]); data.settlements = [];
    const result = backtestTailArchives([data], options);
    expect(result.trials[0]).toMatchObject({ eligible: true, pnlEligible: false, modeledFilledShares: 5, modeledCost: 3.5,
      payoutPerShare: null, settlement: null, modeledPnl: null });
    expect(result.summaries[0]).toMatchObject({ eligibleTrials: 1, excludedTrials: 0, unresolvedTrials: 1, pnlEligibleTrials: 0,
      winningFills: 0, losingFills: 0, modeledPnl: null, pnlPerTrial: null, returnOnFilledCapital: null,
      pnlTrialDenominator: 0, filledCapitalDenominator: 0, unresolvedFilledCost: 3.5 });
  });

  test("complete zero-fill observations need no settlement", () => {
    const data = archive(); delete data.settlements;
    const result = backtestTailArchives([data], options);
    expect(result.trials[0]).toMatchObject({ modeledFilledShares: 0, modeledCost: 0, modeledFee: 0, modeledPnl: 0, pnlEligible: true });
    expect(result.summaries[0]).toMatchObject({ unresolvedTrials: 0, zeroFillTrials: 1, pnlEligibleTrials: 1, pnlPerTrial: 0, returnOnFilledCapital: null });
  });

  test("uses explicit profit denominators and never pools parameter alternatives as portfolio trades", () => {
    const data = withChanges(archive(), [trade(1, entry + 100)]);
    const result = backtestTailArchives([data], { ...options, prices: ["0.70", "0.7000", "0.60"], windowsSeconds: [3, 3], makerFeeBps: 100 });
    expect(result.trials).toHaveLength(2); expect(result.summaries).toHaveLength(2);
    expect(result.options.prices).toEqual(["0.70", "0.60"]);
    expect(result.summaries.find(summary => summary.bidPrice === "0.70")).toMatchObject({ sport: "tennis", marketType: "moneyline", windowSeconds: 3,
      fillModel: "quote-touch-assumed", modeledPnl: -3.535, losses: 3.535, winnings: 0, pnlTrialDenominator: 1,
      filledCapitalDenominator: 3.535, pnlPerTrial: -3.535, returnOnFilledCapital: -1 });
    expect(result.warnings.join(" ")).toMatch(/not independent/i);
    expect(result.warnings.join(" ")).toMatch(/small|tiny/i);
  });
});

describe("strict archive and option validation", () => {
  test("exports the specified defaults without mutating caller arrays", () => {
    const result = backtestTailArchives([]);
    expect(result.options).toEqual({ prices: ["0.50", "0.60", "0.70", "0.80", "0.90", "0.95", "0.97", "0.99"],
      windowsSeconds: [60, 180, 300], entryMinBid: "0.90", shares: 1, queueAheadShares: 0, makerFeeBps: 0,
      fillModel: "quote-touch-assumed", requireFreshContext: false });
    expect(result.trials).toEqual([]); expect(result.summaries).toEqual([]);
  });

  test.each([{ prices: [] }, { prices: [0.7] }, { prices: ["NaN"] }, { prices: ["0"] }, { prices: ["1"] },
    { prices: ["0.7e0"] }, { prices: ["0." + "1".repeat(200)] }, { windowsSeconds: [] }, { windowsSeconds: [0] },
    { windowsSeconds: [1.5] }, { windowsSeconds: [86_401] }, { shares: 0 }, { shares: Infinity }, { queueAheadShares: -1 },
    { makerFeeBps: NaN }, { makerFeeBps: 10_001 }, { entryMinBid: "1.01" }, { entryMinBid: 0.9 },
    { fillModel: "executed" }, { requireFreshContext: "true" }])("rejects invalid options %j", bad => {
    expect(() => backtestTailArchives([archive()], { ...options, ...bad } as TailBacktestOptions)).toThrow("TAIL_BACKTEST_OPTIONS_INVALID");
  });

  test("bounds parameter grids before allocating trials", () => {
    expect(() => backtestTailArchives([], { prices: Array.from({ length: 2_000 }, (_, i) => `0.${String(i + 1).padStart(6, "0")}`) })).toThrow("TAIL_BACKTEST_OPTIONS_INVALID");
    expect(() => backtestTailArchives([], { prices: Array.from({ length: 64 }, (_, i) => `0.${String(i + 1).padStart(3, "0")}`),
      windowsSeconds: Array.from({ length: 64 }, (_, i) => i + 1) })).toThrow("TAIL_BACKTEST_OPTIONS_INVALID");
  });

  test("bounds total trials across inputs as well as the parameter grid", () => {
    const inputs = Array.from({ length: 100 }, (_, i) => distinctGame(archive(), `g-${i}`));
    expect(() => backtestTailArchives(inputs, { prices: Array.from({ length: 32 }, (_, i) => `0.${String(i + 1).padStart(3, "0")}`),
      windowsSeconds: Array.from({ length: 32 }, (_, i) => i + 1) })).toThrow("TAIL_BACKTEST_OPTIONS_INVALID");
  });

  test("bounds repeated provenance as well as the number of trials", () => {
    const data = archive(), fact = data.summary.windows[0]!.finishEvidence![0]!;
    data.summary.windows[0]!.finishEvidence = Array.from({ length: 256 }, (_, i) => ({ ...fact, sequence: i + 1 }));
    expect(() => backtestTailArchives([data], { prices: Array.from({ length: 32 }, (_, i) => `0.${String(i + 1).padStart(3, "0")}`),
      windowsSeconds: Array.from({ length: 32 }, (_, i) => i + 1) })).toThrow(/TAIL_BACKTEST_OPTIONS_INVALID.*evidence/);
  });

  test.each<(data: TailBacktestInput) => void>([
    data => { data.summary.schemaVersion = 2 as never; },
    data => { data.summary.basis = "public-trades" as never; },
    data => { data.summary.runId = 42 as never; },
    data => { data.summary.windows[0]!.key = "game:other"; },
    data => { data.summary.windows[0]!.markets[0]!.tokenId = 123 as never; },
    data => { data.summary.windows[0]!.markets[1]!.conditionId = "other-condition"; },
    data => { data.summary.tokens[0]!.windowKey = "game:other"; },
    data => { data.seconds[0]!.conditionId = "other-condition"; },
    data => { data.seconds[0]!.tokenId = 123 as never; },
    data => { data.seconds[0]!.startAtMs += 1; },
    data => { data.seconds[0]!.secondsBeforeFinish += 1; },
    data => { data.seconds[0]!.bids![0]!.price = "NaN"; },
    data => { data.seconds[0]!.asks![0]!.size = "-1"; },
    data => { data.seconds[0]!.bestBid = "0.96"; },
    data => { data.seconds[0]!.bookObservedAtMs = entry + 1; },
    data => { data.seconds = [...data.seconds, data.seconds[0]!]; },
    data => { data.summary.tokens.push({ ...data.summary.tokens[0]! }); },
    data => { data.summary.windows[0]!.markets.push({ ...data.summary.windows[0]!.markets[0]! }); }
  ])("rejects malformed identities, books, boundaries and duplicates (%#)", mutate => {
    const data = archive(); mutate(data);
    expect(() => backtestTailArchives([data], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });

  test("rejects duplicated source or same-game archives even with different run/source names", () => {
    const a = archive(), b = archive();
    expect(() => backtestTailArchives([a, b], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
    b.sourceId = "other-export"; b.summary.runId = "other-run";
    expect(() => backtestTailArchives([a, b], options)).toThrow(/duplicate.*game|game.*duplicate/i);
  });

  test.each<(change: TailBookChange) => void>([
    change => { change.tokenId = "unknown"; }, change => { change.windowKey = "game:other"; },
    change => { change.price = "-0.1"; }, change => { change.size = "-1"; },
    change => { change.price = 0.7 as never; }, change => { change.side = "UNKNOWN"; },
    change => { change.observedAtMs = finish; }, change => { change.sequence = 1.5; }
  ])("rejects malformed changes before simulation (%#)", mutate => {
    const change = trade(1, entry + 100); mutate(change); const data = archive(); data.changes = [change]; data.summary.changes = 1;
    expect(() => backtestTailArchives([data], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });

  test("duplicate change identities cannot inflate volume", () => {
    const change = trade(1, entry + 100); const data = withChanges(archive(), [change, { ...change }]);
    expect(() => backtestTailArchives([data], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });

  test("settlement matches token identities rather than array order", () => {
    const data = withChanges(archive(), [trade(1, entry + 100)]); data.settlements = [...data.settlements!].reverse();
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ tokenId: "A", payoutPerShare: 0, modeledPnl: -3.5 });
  });

  test.each(["file:///synthetic/evidence/confirmed%20market.json#response-0", "urn:sha256:confirmed-market-response"])(
    "accepts and preserves settlement provenance URI %s", sourceUrl => {
      const data = withChanges(archive(), [trade(1, entry + 100)]);
      data.settlements!.forEach(settlement => { settlement.sourceUrl = sourceUrl; });
      const trial = backtestTailArchives([data], options).trials[0]!;
      expect(trial).toMatchObject({ eligible: true, tokenId: "A", referenceBid: "0.95", modeledFilledShares: 5,
        payoutPerShare: 0, modeledPnl: -3.5, settlement: { source: "gamma-resolved-prices", sourceUrl } });
      expect(trial.settlementVector.every(settlement => settlement.sourceUrl === sourceUrl)).toBe(true);
    }
  );

  test.each(["", "   ", "not-a-uri"])("rejects empty or malformed settlement provenance %j", sourceUrl => {
    const data = archive(); data.settlements!.forEach(settlement => { settlement.sourceUrl = sourceUrl; });
    expect(() => backtestTailArchives([data], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });

  test("proposed market metadata cannot supply a settlement or alter the entry side", () => {
    const data = withChanges(archive(), [trade(1, entry + 100)]); delete data.settlements;
    data.summary.windows[0]!.markets.forEach(market => {
      market.raw = { umaResolutionStatus: "proposed", outcomePrices: ["0", "1"], clobTokenIds: ["A", "B"] };
    });
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ tokenId: "A", eligible: true, modeledFilledShares: 5,
      settlement: null, settlementVector: [], payoutPerShare: null, modeledPnl: null, pnlEligible: false });
  });

  test.each<(data: TailBacktestInput) => void>([
    data => { data.settlements![0]!.conditionId = "other"; },
    data => { data.settlements![0]!.marketId = "other"; },
    data => { data.settlements![0]!.tokenId = "other"; },
    data => { data.settlements![0]!.tokenId = 123 as never; },
    data => { data.settlements = [data.settlements![0]!]; },
    data => { data.settlements = [...data.settlements!, data.settlements![0]!]; },
    data => { data.settlements![0]!.payout = 1; },
    data => { data.settlements![0]!.payout = NaN; },
    data => { data.settlements![0]!.source = "unchecked" as never; },
    data => { data.settlements![0]!.sourceUrl = "not-a-url"; },
    data => { data.settlements![0]!.observedAtMs += 1; }
  ])("rejects incomplete, conflicting or mismapped settlement vectors (%#)", mutate => {
    const data = archive(); mutate(data);
    expect(() => backtestTailArchives([data], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });
});

describe("collector compatibility and boundary regressions", () => {
  test("accepts an older summary's explicit actual-finish source when optional witnesses are absent", () => {
    const data = archive(); delete data.summary.windows[0]!.finishEvidence;
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ eligible: true, finishAtMs: finish, finishSources: ["gamma.finishedTimestamp"] });
    data.summary.windows[0]!.finishSources = ["gamma.endDate"];
    expect(backtestTailArchives([data], options).trials[0]?.exclusions).toContain("missing-actual-finish");
  });

  test.each([null, "uncaptured-companion"])("preserves a native compact finish witness with optional slug %j", eventSlug => {
    const data = archive(), window = data.summary.windows[0]!;
    window.finishSources = ["sports.finishedAt"];
    window.finishEvidence = [{ atMs: finish, observedAtMs: finish + 100, source: "sports.finishedAt", eventSlug }];
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ eligible: true, finishEvidence: window.finishEvidence });
  });

  test("keeps a later-run finish fact's original provenance without treating it as the book run", () => {
    const data = archive(); Object.assign(data.summary.windows[0]!.finishEvidence![0]!, { eventId: "event", gameId: "g",
      sourceRunId: "later-run", sourceRunDirectory: "/original/later-run", sequence: 22, frameIndex: 3, observedAtMs: finish + 50_000 });
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ sourceRunId: "run", eligible: true,
      finishEvidence: [expect.objectContaining({ sourceRunId: "later-run", sequence: 22, observedAtMs: finish + 50_000 })] });
  });

  test("rejects a finish that names another captured window even while claiming the current game", () => {
    const a = distinctGame(archive(), "one"), b = distinctGame(archive(), "two");
    Object.assign(a.summary.windows[0]!.finishEvidence![0]!, { eventSlug: "slug-two", gameId: "one" });
    expect(() => backtestTailArchives([a, b], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });

  test("cannot pair a known finish slug with an invented event ID", () => {
    const data = archive(); Object.assign(data.summary.windows[0]!.finishEvidence![0]!, { eventId: "invented-event", gameId: "g" });
    expect(() => backtestTailArchives([data], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });

  test("closed entry rows remain visibly closed, not merely absent references", () => {
    const data = archive();
    for (const row of data.seconds) Object.assign(row, { status: "closed", wholeSecondValid: false, bids: null, asks: null, bestBid: null, bestAsk: null });
    for (const quality of data.summary.tokens) Object.assign(quality, { validSeconds: 0, closedSeconds: 4, snapshotMatches: 0, readyForReplay: false });
    const trial = backtestTailArchives([data], options).trials[0]!;
    expect(trial.entryReferences.every(reference => reference.entryStatus === "closed")).toBe(true);
    expect(trial.exclusions).toContain("entry-book-closed");
    expect(trial.exclusions).toContain("no-active-book-seconds");
    expect(trial.exclusions).not.toContain("snapshot-audit-not-passed");
    expect(trial.modeledPnl).toBeNull();
  });

  test("whole-window quality claims must agree with rows outside the selected holding interval", () => {
    const data = archive(); data.seconds[0]!.status = "missing"; data.seconds[0]!.wholeSecondValid = false;
    const trial = backtestTailArchives([data], { ...options, windowsSeconds: [1] }).trials[0]!;
    expect(trial.priceCoverage.complete).toBe(true);
    expect(trial.exclusions).toContain("token-window-incomplete");
    expect(trial.modeledPnl).toBeNull();
  });

  test("clock-affected entry rows retain the clock exclusion even when no side can be selected", () => {
    const data = archive(); data.seconds[0]!.reasons.push("receipt-wall-clock-backstep");
    const trial = backtestTailArchives([data], options).trials[0]!;
    expect(trial.exclusions).toContain("clock-affected-data");
    expect(trial.entryReferences.find(reference => reference.tokenId === "A")?.clockAffected).toBe(true);
  });

  test("a carried reference cannot claim a book first observed inside that same second without a change", () => {
    const data = archive();
    for (const row of data.seconds.filter(row => row.tokenId === "A")) setBook(row, "0.95", "0.97", entry - 500);
    expect(backtestTailArchives([data], options).trials[0]?.eligible).toBe(false);
  });

  test("inconsistent intra-second extrema indicate missing evidence, not a new touch assumption", () => {
    const data = archive(); data.seconds[2]!.minBestAsk = 0.50;
    const trial = backtestTailArchives([data], options).trials[0]!;
    expect(trial.exclusions).toContain("inconsistent-book-evidence");
    expect(trial.modeledFilledShares).toBeNull();
  });

  test("unknown context is separate, but a present future observation is malformed", () => {
    const data = archive(); const row = data.seconds[0]!;
    row.contextObservedAtMs = entry + 1; row.contextAgeMs = row.endAtMs - row.contextObservedAtMs;
    expect(() => backtestTailArchives([data], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });

  test("a provisional invalidation reconciled in the same valid second does not erase valid book evidence", () => {
    const data = withChanges(archive(), [{ windowKey: "game:g", tokenId: "A", sequence: 1, frameIndex: -1,
      observedAtMs: entry + 100, sourceAtMs: null, kind: "invalidation", data: { provisional: true, reason: "crossed_book" } },
    book(2, entry + 200, "0.60", "0.65"), book(3, entry + 300, "0.95", "0.97")]);
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ eligible: true, modeledFilledShares: 5 });
  });

  test("a gap detected after expiry still invalidates its earlier holding uncertainty", () => {
    const data = withChanges(archive(), [{ windowKey: "game:g", tokenId: "A", sequence: 1, frameIndex: -1,
      observedAtMs: finish + 200, sourceAtMs: null, kind: "invalidation", data: { reason: "sequence_gap", uncertainFromMs: entry + 100 } }]);
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ eligible: false, modeledPnl: null, priceCoverage: { invalidationSeconds: 3 } });
  });

  test("receipt backsteps in the change stream cannot be hidden by clear aggregate clock flags", () => {
    const data = withChanges(archive(), [trade(1, entry + 2_000), trade(2, entry + 1_000)]);
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ eligible: false, priceCoverage: { clockAffectedSeconds: 2 } });
  });

  test("confirmed CLOB winner flags work in any token order and cannot be mixed with another vector observation", () => {
    const data = withChanges(archive(), [trade(1, entry + 100)]);
    data.settlements!.forEach(settlement => { settlement.source = "clob-winner-flags"; settlement.sourceUrl = "https://clob.polymarket.com/markets/condition"; });
    data.settlements = [...data.settlements!].reverse();
    expect(backtestTailArchives([data], options).trials[0]).toMatchObject({ modeledPnl: -3.5, settlement: { source: "clob-winner-flags", tokenId: "A" } });
    data.settlements[0]!.source = "gamma-resolved-prices";
    expect(() => backtestTailArchives([data], options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });

  test("mixed settled, unresolved, zero-fill and excluded trials use only observed PnL denominators", () => {
    const filled = withChanges(archive(), [trade(1, entry + 100)]);
    const winner = distinctGame(filled, "winner"); winner.settlements!.forEach(settlement => { settlement.payout = 1 - settlement.payout; });
    const unresolved = distinctGame(filled, "unresolved"); delete unresolved.settlements;
    const missing = distinctGame(archive(), "missing"); missing.seconds = missing.seconds.filter(row => row.secondIndex !== 0);
    const result = backtestTailArchives([winner, distinctGame(filled, "loser"), unresolved, distinctGame(archive(), "zero"), missing], options);
    expect(result.summaries[0]).toMatchObject({ trials: 5, games: 5, sources: 5, eligibleTrials: 4, excludedTrials: 1,
      unresolvedTrials: 1, pnlEligibleTrials: 3, modeledFilledTrials: 3, settledFilledTrials: 2, zeroFillTrials: 1,
      winningFills: 1, losingFills: 1, modeledCost: 10.5, unresolvedFilledCost: 3.5, modeledPnl: -2, pnlTrialDenominator: 3, filledCapitalDenominator: 7 });
    expect(result.summaries[0]?.pnlPerTrial).toBeCloseTo(-2 / 3);
    expect(result.summaries[0]?.returnOnFilledCapital).toBeCloseTo(-2 / 7);
  });

  test("unknown options cannot silently drop a misspelled scenario setting", () => {
    expect(() => backtestTailArchives([], { ...options, windowSecond: 3 } as TailBacktestOptions)).toThrow("TAIL_BACKTEST_OPTIONS_INVALID");
  });
  test("sparse price arrays are invalid", () => {
    expect(() => backtestTailArchives([], { prices: new Array<string>(1) })).toThrow("TAIL_BACKTEST_OPTIONS_INVALID");
  });
  test("sparse window arrays are invalid", () => {
    expect(() => backtestTailArchives([], { windowsSeconds: new Array<number>(1) })).toThrow("TAIL_BACKTEST_OPTIONS_INVALID");
  });
  test("sparse input arrays are invalid", () => {
    expect(() => backtestTailArchives(new Array<TailBacktestInput>(1), options)).toThrow("TAIL_BACKTEST_INPUT_INVALID");
  });
});
