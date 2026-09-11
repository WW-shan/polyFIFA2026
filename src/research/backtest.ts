import type { ResearchDataset, ResearchEvent, ResearchMarket, ResearchOutcome, ResearchTrade } from "./types.js";
import type { BacktestOptions, BacktestResult, EffectiveBacktestOptions, OrderTrial, ParameterSummary } from "./backtest-types.js";
export type { BacktestOptions, BacktestResult } from "./backtest-types.js";

const PRICE_EPSILON = 1e-6; // Data API execution ratios can be .69999996 at a .70 tick.
function optionsError(message: string): never { throw new Error(`RESEARCH_OPTIONS_INVALID: ${message}`); }
function datasetError(message: string): never { throw new Error(`RESEARCH_DATASET_INVALID: ${message}`); }

export function effectiveBacktestOptions(options: BacktestOptions = {}): EffectiveBacktestOptions {
  const result: EffectiveBacktestOptions = {
    prices: [.5, .6, .7, .8, .9, .95, .97, .99], windowsSeconds: [60, 180, 300, 480], shares: 10,
    entryMinPrice: .9, maxEntryAgeSeconds: 120, entryMode: "finish-relative", fillModel: "sell-through",
    queueAheadShares: 0, makerFeeBps: 0, marketTypes: [], ...options
  };
  if (!Array.isArray(result.prices) || !result.prices.length || result.prices.some(p => !Number.isFinite(p) || p <= 0 || p >= 1)) optionsError("prices must be in (0,1)");
  if (!Array.isArray(result.windowsSeconds) || !result.windowsSeconds.length || result.windowsSeconds.some(w => !Number.isSafeInteger(w) || w <= 0 || w > 86_400)) optionsError("windowsSeconds must be positive integer seconds <=86400");
  for (const name of ["shares", "maxEntryAgeSeconds"] as const) if (!Number.isFinite(result[name]) || result[name] <= 0) optionsError(`${name} must be positive`);
  for (const name of ["queueAheadShares", "makerFeeBps"] as const) if (!Number.isFinite(result[name]) || result[name] < 0) optionsError(`${name} must be nonnegative`);
  if (!Number.isFinite(result.entryMinPrice) || result.entryMinPrice <= 0 || result.entryMinPrice >= 1) optionsError("entryMinPrice must be in (0,1)");
  if (result.makerFeeBps > 10_000) optionsError("makerFeeBps must be <=10000");
  if (!["finish-relative", "price-trigger"].includes(result.entryMode)) optionsError("unknown entryMode");
  if (!["sell-through", "sell-at-or-below"].includes(result.fillModel)) optionsError("unknown fillModel");
  if (!Array.isArray(result.marketTypes) || result.marketTypes.some(t => typeof t !== "string" || !t)) optionsError("invalid marketTypes");
  result.prices = [...new Set(result.prices)].sort((a, b) => a - b);
  result.windowsSeconds = [...new Set(result.windowsSeconds)].sort((a, b) => a - b);
  return result;
}

function validTime(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validateDataset(dataset: ResearchDataset): void {
  if (!dataset || dataset.schemaVersion !== 1 || dataset.kind !== "public-trade-history" || !Array.isArray(dataset.events)) datasetError("unsupported schema");
  const eventIds = new Set<string>();
  const conditions = new Set<string>();
  for (const event of dataset.events) {
    if (!event || typeof event.eventId !== "string" || !event.eventId || eventIds.has(event.eventId) || !Array.isArray(event.markets)) datasetError("invalid or duplicate event");
    eventIds.add(event.eventId);
    if ((event.startMs !== null && !validTime(event.startMs)) || (event.finishMs !== null && !validTime(event.finishMs))) datasetError("invalid event timestamp");
    for (const market of event.markets) {
      if (!market || typeof market.conditionId !== "string" || !market.conditionId || conditions.has(market.conditionId) || !Array.isArray(market.outcomes) || market.outcomes.length < 2 || !Array.isArray(market.trades)) datasetError("invalid or duplicate market");
      conditions.add(market.conditionId);
      const tokens = new Set<string>();
      for (const outcome of market.outcomes) {
        if (!outcome || typeof outcome.tokenId !== "string" || !outcome.tokenId || tokens.has(outcome.tokenId) ||
          (outcome.payout !== null && (!Number.isFinite(outcome.payout) || outcome.payout < 0 || outcome.payout > 1))) datasetError("invalid outcome mapping");
        tokens.add(outcome.tokenId);
      }
      const payouts = market.outcomes.map(outcome => outcome.payout);
      if (market.resolutionSource === "unresolved") {
        if (payouts.some(payout => payout !== null)) datasetError("unresolved market has a payout");
      } else if (market.resolutionSource !== "gamma-resolved-prices" || payouts.some(payout => payout === null) ||
        Math.abs(payouts.reduce<number>((sum, payout) => sum + (payout ?? 0), 0) - 1) > 1e-8) datasetError("invalid payout vector or provenance");
      if (market.coverage && (!validTime(market.coverage.fromMs) || !validTime(market.coverage.toMs) || market.coverage.fromMs > market.coverage.toMs)) datasetError("invalid coverage interval");
      if (market.coverage && !["complete", "incomplete", "error"].includes(market.coverage.status)) datasetError("invalid coverage status");
      const identities = new Map<string, string>();
      for (const trade of market.trades) {
        if (!trade || typeof trade.id !== "string" || !trade.id || !tokens.has(trade.tokenId) || trade.conditionId !== market.conditionId || !validTime(trade.timestampMs) ||
          !Number.isFinite(trade.price) || trade.price < 0 || trade.price > 1 || !Number.isFinite(trade.size) || trade.size <= 0 || !["BUY", "SELL"].includes(trade.side)) datasetError("invalid trade observation");
        const value = JSON.stringify([trade.timestampMs, trade.tokenId, trade.price, trade.size, trade.side]);
        if (identities.has(trade.id) && identities.get(trade.id) !== value) datasetError("conflicting trade identity");
        identities.set(trade.id, value);
      }
    }
  }
}

interface Reference { outcome: ResearchOutcome; price: number; atMs: number; basis: NonNullable<OrderTrial["referenceBasis"]> }
function referenceFromGroup(group: readonly ResearchTrade[], market: ResearchMarket): Reference | null {
  if (!group.length) return null;
  const candidates: Reference[] = [];
  for (const outcome of market.outcomes) {
    const prices = group.flatMap(trade => trade.tokenId === outcome.tokenId ? [trade.price] : market.outcomes.length === 2 ? [1 - trade.price] : []);
    if (prices.length) candidates.push({ outcome, price: Math.min(...prices), atMs: group[0]!.timestampMs,
      basis: market.outcomes.length === 2 ? "last-second-trades-binary-complement" : "last-second-direct-trades" });
  }
  // Conservative across the latest second. Never use final payout to break ties.
  return candidates.sort((a, b) => b.price - a.price || a.outcome.tokenId.localeCompare(b.outcome.tokenId))[0] ?? null;
}

function referenceBefore(trades: readonly ResearchTrade[], market: ResearchMarket, entryAtMs: number): Reference | null {
  const boundary = Math.floor(entryAtMs / 1000) * 1000;
  const prior = trades.filter(trade => trade.timestampMs < boundary);
  const last = prior.at(-1);
  return last ? referenceFromGroup(prior.filter(trade => trade.timestampMs === last.timestampMs), market) : null;
}

function firstTrigger(trades: readonly ResearchTrade[], market: ResearchMarket, event: ResearchEvent, threshold: number): Reference | null {
  if (event.startMs === null) return null;
  for (let index = 0; index < trades.length;) {
    const atMs = trades[index]!.timestampMs;
    let end = index + 1;
    while (end < trades.length && trades[end]!.timestampMs === atMs) end++;
    if (atMs >= event.startMs) {
      const reference = referenceFromGroup(trades.slice(index, end), market);
      if (reference && reference.price + PRICE_EPSILON >= threshold) return reference;
    }
    index = end;
  }
  return null;
}

function newTrial(event: ResearchEvent, market: ResearchMarket, bid: number, window: number, options: EffectiveBacktestOptions): OrderTrial {
  return {
    eventId: event.eventId, eventSlug: event.eventSlug, eventTitle: event.title, sport: event.sport, marketId: market.marketId,
    conditionId: market.conditionId, marketType: market.marketType, question: market.question,
    tokenId: null, outcome: null, entryMode: options.entryMode, fillModel: options.fillModel, bidPrice: bid, windowSeconds: window,
    orderShares: options.shares, queueAheadShares: options.queueAheadShares, entryAtMs: null, expiryAtMs: null, finishAtMs: event.finishMs,
    referenceAtMs: null, referencePrice: null, referenceBasis: null, referenceAgeSeconds: null, exclusions: [],
    touchTradeCount: 0, touchShares: 0, sellThroughShares: 0, equalSellShares: 0, minimumTradePrice: null,
    firstTouchAtMs: null, firstSimulatedFillAtMs: null, simulatedFilledShares: 0, simulatedCost: 0, simulatedFee: 0,
    payoutPerShare: null, simulatedPnl: null
  };
}

function simulateVolume(trial: OrderTrial, trades: readonly ResearchTrade[], options: EffectiveBacktestOptions): void {
  const start = Math.ceil(trial.entryAtMs! / 1000) * 1000;
  const end = Math.floor(trial.expiryAtMs! / 1000) * 1000;
  const relevant = trades.filter(t => t.tokenId === trial.tokenId && t.timestampMs >= start && t.timestampMs < end);
  let queue = options.queueAheadShares;
  for (let index = 0; index < relevant.length;) {
    const atMs = relevant[index]!.timestampMs;
    let next = index;
    let through = 0, equal = 0;
    while (next < relevant.length && relevant[next]!.timestampMs === atMs) {
      const trade = relevant[next++]!;
      trial.minimumTradePrice = Math.min(trial.minimumTradePrice ?? Infinity, trade.price);
      if (trade.price <= trial.bidPrice + PRICE_EPSILON) {
        trial.touchTradeCount++; trial.touchShares += trade.size; trial.firstTouchAtMs ??= atMs;
        if (trade.side === "SELL") {
          if (trade.price < trial.bidPrice - PRICE_EPSILON) through += trade.size;
          else equal += trade.size;
        }
      }
    }
    trial.sellThroughShares += through; trial.equalSellShares += equal;
    // For unknown within-second order, allocate strict-through volume to the
    // queue first. Equality may clear the queue, but not create a through fill.
    const eligible = options.fillModel === "sell-at-or-below" ? through + equal : through;
    const fill = Math.min(Math.max(0, options.shares - trial.simulatedFilledShares), Math.max(0, eligible - queue));
    queue = Math.max(0, queue - through - equal);
    trial.simulatedFilledShares += fill;
    if (fill > 0) trial.firstSimulatedFillAtMs ??= atMs;
    index = next;
  }
  trial.simulatedCost = trial.simulatedFilledShares * trial.bidPrice;
  trial.simulatedFee = trial.simulatedCost * options.makerFeeBps / 10_000;
}

function trialFor(event: ResearchEvent, market: ResearchMarket, trades: readonly ResearchTrade[], bid: number, window: number, options: EffectiveBacktestOptions): OrderTrial {
  const trial = newTrial(event, market, bid, window, options);
  let reference: Reference | null;
  if (options.entryMode === "finish-relative") {
    if (event.finishMs === null) { trial.exclusions.push("missing-actual-finish"); return trial; }
    if (market.horizon !== "match") { trial.exclusions.push("market-horizon-not-match"); return trial; }
    trial.entryAtMs = event.finishMs - window * 1000;
    trial.expiryAtMs = event.finishMs;
    if (trial.entryAtMs < 0 || (event.startMs !== null && trial.entryAtMs < event.startMs)) { trial.exclusions.push("window-before-game-start"); return trial; }
    reference = referenceBefore(trades, market, trial.entryAtMs);
  } else {
    if (event.startMs === null) { trial.exclusions.push("missing-game-start"); return trial; }
    reference = firstTrigger(trades, market, event, options.entryMinPrice);
    if (reference) {
      trial.entryAtMs = reference.atMs + 1000;
      // A fixed expiry, not advance knowledge of the eventual finish.
      trial.expiryAtMs = trial.entryAtMs + window * 1000;
    }
  }
  if (!reference) { trial.exclusions.push("missing-entry-reference"); return trial; }
  trial.tokenId = reference.outcome.tokenId; trial.outcome = reference.outcome.name;
  trial.referencePrice = reference.price; trial.referenceAtMs = reference.atMs; trial.referenceBasis = reference.basis;
  trial.referenceAgeSeconds = (trial.entryAtMs! - reference.atMs) / 1000;
  trial.payoutPerShare = reference.outcome.payout;
  if (trial.referenceAgeSeconds > options.maxEntryAgeSeconds) trial.exclusions.push("stale-entry-reference");
  if (reference.price + PRICE_EPSILON < options.entryMinPrice) trial.exclusions.push("entry-below-threshold");
  if (bid >= reference.price - PRICE_EPSILON) trial.exclusions.push("bid-not-below-reference");
  if (trial.exclusions.length) return trial; // No order was placed under these entry rules.
  const coverage = market.coverage;
  if (!coverage || coverage.status !== "complete") trial.exclusions.push("incomplete-trade-history");
  if (!coverage || coverage.fromMs > reference.atMs || coverage.toMs < trial.expiryAtMs!) trial.exclusions.push("resting-window-not-covered");
  if (options.entryMode === "price-trigger" && (!coverage || coverage.fromMs > event.startMs!)) trial.exclusions.push("trigger-history-not-covered");
  simulateVolume(trial, trades, options);
  if (reference.outcome.payout === null || market.resolutionSource === "unresolved") trial.exclusions.push("unresolved-payout");
  if (!trial.exclusions.length) trial.simulatedPnl = trial.simulatedFilledShares * reference.outcome.payout! - trial.simulatedCost - trial.simulatedFee;
  return trial;
}

function summarize(trials: readonly OrderTrial[]): ParameterSummary[] {
  const groups = new Map<string, { summary: ParameterSummary; eventIds: Set<string> }>();
  for (const trial of trials) {
    const key = JSON.stringify([trial.sport, trial.marketType, trial.entryMode, trial.fillModel, trial.bidPrice, trial.windowSeconds, trial.orderShares, trial.queueAheadShares]);
    let group = groups.get(key);
    if (!group) {
      group = { eventIds: new Set(), summary: {
        sport: trial.sport, marketType: trial.marketType, entryMode: trial.entryMode, fillModel: trial.fillModel,
        bidPrice: trial.bidPrice, windowSeconds: trial.windowSeconds, orderShares: trial.orderShares, queueAheadShares: trial.queueAheadShares,
        trials: 0, events: 0, eligibleTrials: 0, excludedTrials: 0, touchedTrials: 0, filledTrials: 0, unfilledTrials: 0,
        winningFills: 0, losingFills: 0, splitPayoutFills: 0, simulatedFilledShares: 0, simulatedCost: 0, simulatedFees: 0, simulatedPnl: 0,
        returnOnFilledCapital: null, pnlPerEligibleTrial: null, exclusions: {}
      } };
      groups.set(key, group);
    }
    const summary = group.summary;
    summary.trials++; group.eventIds.add(trial.eventId);
    if (trial.exclusions.length) {
      summary.excludedTrials++;
      for (const reason of trial.exclusions) summary.exclusions[reason] = (summary.exclusions[reason] ?? 0) + 1;
      continue;
    }
    summary.eligibleTrials++;
    if (trial.touchTradeCount > 0) summary.touchedTrials++;
    if (trial.simulatedFilledShares > 0) {
      summary.filledTrials++;
      if (trial.payoutPerShare === 1) summary.winningFills++;
      else if (trial.payoutPerShare === 0) summary.losingFills++;
      else summary.splitPayoutFills++;
    } else summary.unfilledTrials++;
    summary.simulatedFilledShares += trial.simulatedFilledShares;
    summary.simulatedCost += trial.simulatedCost;
    summary.simulatedFees += trial.simulatedFee;
    summary.simulatedPnl += trial.simulatedPnl ?? 0;
  }
  return [...groups.values()].map(({ summary, eventIds }) => ({ ...summary, events: eventIds.size,
    returnOnFilledCapital: summary.simulatedCost > 0 ? summary.simulatedPnl / summary.simulatedCost : null,
    pnlPerEligibleTrial: summary.eligibleTrials > 0 ? summary.simulatedPnl / summary.eligibleTrials : null
  }));
}

export function backtestDataset(dataset: ResearchDataset, input: BacktestOptions = {}): BacktestResult {
  const options = effectiveBacktestOptions(input);
  validateDataset(dataset);
  const trials: OrderTrial[] = [];
  for (const event of dataset.events) {
    for (const market of event.markets) {
      if (options.marketTypes.length && !options.marketTypes.includes(market.marketType)) continue;
      const trades = [...new Map(market.trades.map(t => [t.id, t])).values()].sort((a, b) => a.timestampMs - b.timestampMs);
      for (const window of options.windowsSeconds) for (const bid of options.prices) trials.push(trialFor(event, market, trades, bid, window, options));
    }
  }
  return { schemaVersion: 1, basis: "historical-public-trade-screen", options, trials, summaries: summarize(trials), warnings: [
    "Finish-relative windows are retrospective labels; tennis has no known-in-advance final-minute clock.",
    "Entry uses conservative last-second trade/complement prices, not a contemporaneous executable book. No future winner is used to select the outcome.",
    "Modeled fills use direct SELL prints and a fixed queue-ahead scenario. Public data does not establish our actual fill; complementary-token matching and queue changes are not reconstructed.",
    "Each price/window is a separate scenario. Do not sum overlapping windows, alternative prices or correlated markets as a portfolio return.",
    "This is an in-sample public-trade screen. Missing entry, incomplete history, subperiod clocks and unresolved payouts remain explicit exclusions."
  ] };
}
