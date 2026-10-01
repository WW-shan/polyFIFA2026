import { netReturnRate, sportsTakerFeePerShare } from "./fees.js";
import { MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS } from "./risk-thresholds.js";
import { classifyTailWindow } from "./time-window.js";
import type {
  BuyTradeLeg,
  BuyTradeDecision,
  DecisionThresholds,
  MatchState,
  NoTradeDecision,
  OrderbookSnapshot,
  PriceLevel,
  RestingBidOptions,
  SelectedStrategyMarket,
  TradeDecision
} from "./types.js";

export type TradeLevel = Omit<BuyTradeLeg, "shares" | "notional" | "estimatedFee">;

// Low prices on "locked" legs usually indicate stale or mismatched score data.
const LOCKED_ENTRY_PRICE_FLOOR = 0.85;

export function buildTradeDecision(
  match: MatchState,
  selected: SelectedStrategyMarket,
  orderbook: OrderbookSnapshot,
  thresholds: DecisionThresholds
): TradeDecision {
  const validation = validateTradeInputs(match, selected, orderbook, thresholds);
  if (validation.action === "NO_TRADE") return validation.decision;

  const levels = buildTradeLevels(match, selected, orderbook, thresholds);
  const legs = allocateTradeLegs(levels, thresholds);
  if (legs.length === 0) return noExecutableLevelDecision(match, selected, orderbook, thresholds);

  return buyDecisionFromLegs(legs);
}

export function buildTradeLevels(
  match: MatchState,
  selected: SelectedStrategyMarket,
  orderbook: OrderbookSnapshot,
  thresholds: DecisionThresholds
): TradeLevel[] {
  const validation = validateTradeInputs(match, selected, orderbook, thresholds);
  if (validation.action === "NO_TRADE") return [];
  const tailWindow = classifyTailWindow(match, {
    entryWindowMinutes: thresholds.entryWindowMinutes
  });
  const asks = sortedPositiveAsks(orderbook.asks);
  return [...new Set(asks.map((ask) => ask.price))]
    .sort((a, b) => a - b)
    .flatMap((price) => {
      if (!isEligibleEntryPrice(price, selected, thresholds)) return [];
      const estimatedNetReturn = netReturnRate(price);
      if (estimatedNetReturn < thresholds.minimumNetReturn) return [];
      const availableSize = asks
        .filter((ask) => ask.price === price)
        .reduce((total, ask) => total + ask.size, 0);
      if (availableSize <= 0) return [];
      const level: TradeLevel = {
        eventSlug: match.eventSlug,
        marketSlug: selected.marketSlug,
        question: selected.question,
        tokenId: selected.tokenId,
        conditionId: selected.conditionId,
        outcome: selected.outcome,
        price,
        availableSize,
        estimatedNetReturn,
        strategy: selected.strategy,
        lossRequiresGoals: selected.lossRequiresGoals,
        tailWindowSource: tailWindow.source,
        tailWindowDetails: tailWindow.details
      };
      if (selected.line !== undefined) level.line = selected.line;
      if (selected.locked !== undefined) level.locked = selected.locked;
      if (selected.tickSize) level.tickSize = selected.tickSize;
      if (selected.negRisk !== undefined) level.negRisk = selected.negRisk;
      return [level];
    });
}

export function allocateTradeLegs(levels: readonly TradeLevel[], thresholds: DecisionThresholds): BuyTradeLeg[] {
  let remainingNotional = thresholds.maxNotional;
  const ranked = [...levels].sort((a, b) => {
    const returnDelta = b.estimatedNetReturn - a.estimatedNetReturn;
    if (returnDelta !== 0) return returnDelta;
    return (b.lossRequiresGoals ?? 0) - (a.lossRequiresGoals ?? 0);
  });
  const legs: BuyTradeLeg[] = [];

  for (const level of ranked) {
    if (remainingNotional < thresholds.minimumNotional) break;
    const availableNotional = level.availableSize * level.price;
    if (availableNotional < thresholds.minimumNotional) continue;
    const notional = Math.min(remainingNotional, availableNotional);
    if (notional < thresholds.minimumNotional) break;
    const shares = notional / level.price;
    const estimatedFee = shares * sportsTakerFeePerShare(level.price);
    legs.push({
      ...level,
      shares,
      notional,
      estimatedFee
    });
    remainingNotional -= notional;
  }

  return legs;
}

const SHARE_SIZE_DECIMALS = 2;

function roundDownShares(value: number): number {
  return Math.floor(value * 10 ** SHARE_SIZE_DECIMALS) / 10 ** SHARE_SIZE_DECIMALS;
}

/**
 * Builds a maker bid that rests on the book at `options.price` instead of taking
 * liquidity. The venue charges takers only, so the estimate uses a zero fee; the
 * leg is marked `resting` so executors submit a GTC/GTD limit order rather than a
 * market order, and paper runs report it as posted rather than filled.
 */
export function buildRestingBidDecision(
  match: MatchState,
  candidates: readonly SelectedStrategyMarket[],
  orderbooks: readonly OrderbookSnapshot[],
  thresholds: DecisionThresholds,
  options: RestingBidOptions
): TradeDecision {
  const tailWindow = classifyTailWindow(match, { entryWindowMinutes: thresholds.entryWindowMinutes });
  if (!tailWindow.eligible) {
    return noTrade("MATCH_NOT_LATE_ENOUGH", match.eventSlug, tailWindow.details);
  }
  if (!Number.isFinite(options.price) || options.price <= 0 || options.price >= 1) {
    return noTrade("PRICE_TOO_HIGH", match.eventSlug, `Resting bid price ${options.price} must be between 0 and 1`);
  }

  let crossedBook = false;
  let lockedBelowFloor: number | undefined;
  for (const candidate of candidates) {
    const orderbook = orderbooks.find((book) => book.tokenId === candidate.tokenId);
    if (!orderbook) continue;
    const bestAsk = sortedPositiveAsks(orderbook.asks)[0]?.price;
    // A locked outcome the market still prices below the floor signals a stale
    // or reversed score; the taker path refuses it and so must a resting bid.
    if (candidate.locked === true && (bestAsk === undefined || bestAsk < LOCKED_ENTRY_PRICE_FLOOR)) {
      lockedBelowFloor = bestAsk ?? 0;
      continue;
    }
    // A bid at or above the best ask would take instead of rest; the taker path
    // owns that case, so this builder refuses to construct a crossing order.
    if (bestAsk !== undefined && options.price >= bestAsk) {
      crossedBook = true;
      continue;
    }
    const shares = roundDownShares(thresholds.maxNotional / options.price);
    const minimumOrderSize = orderbook.minimumOrderSize ?? options.minimumOrderSize;
    if (minimumOrderSize !== undefined && shares < minimumOrderSize) {
      return noTrade(
        "DEPTH_TOO_SMALL",
        match.eventSlug,
        `Resting bid of ${shares} shares is below the venue minimum order size ${minimumOrderSize}`
      );
    }
    const notional = shares * options.price;
    if (notional < thresholds.minimumNotional) {
      return noTrade("DEPTH_TOO_SMALL", match.eventSlug, `Resting bid notional ${notional} is below minimum ${thresholds.minimumNotional}`);
    }
    const leg: BuyTradeLeg = {
      eventSlug: match.eventSlug,
      marketSlug: candidate.marketSlug,
      question: candidate.question,
      tokenId: candidate.tokenId,
      conditionId: candidate.conditionId,
      outcome: candidate.outcome,
      price: options.price,
      availableSize: shares,
      shares,
      notional,
      estimatedFee: 0,
      estimatedNetReturn: netReturnRate(options.price, 0),
      resting: true
    };
    if (candidate.line !== undefined) leg.line = candidate.line;
    leg.strategy = candidate.strategy;
    leg.lossRequiresGoals = candidate.lossRequiresGoals;
    if (candidate.locked !== undefined) leg.locked = candidate.locked;
    if (candidate.tickSize) leg.tickSize = candidate.tickSize;
    if (candidate.negRisk !== undefined) leg.negRisk = candidate.negRisk;
    return buyDecisionFromLegs([leg]);
  }

  if (crossedBook) {
    return noTrade("PRICE_TOO_HIGH", match.eventSlug, `Resting bid ${options.price} crosses the best ask; the taker path handles that case`);
  }
  if (lockedBelowFloor !== undefined) {
    return noTrade("DEPTH_TOO_SMALL", match.eventSlug, `Locked orderbook best ask ${lockedBelowFloor} is below locked floor ${LOCKED_ENTRY_PRICE_FLOOR}`);
  }
  return noTrade("NO_ELIGIBLE_STRATEGY", match.eventSlug, "No candidate market had a usable order book for a resting bid");
}

export function buyDecisionFromLegs(legs: readonly BuyTradeLeg[]): BuyTradeDecision {
  if (legs.length === 0) {
    throw new Error("Cannot build BUY decision without legs");
  }
  const first = legs[0]!;
  const shares = legs.reduce((total, leg) => total + leg.shares, 0);
  const notional = legs.reduce((total, leg) => total + leg.notional, 0);
  const estimatedFee = legs.reduce((total, leg) => total + leg.estimatedFee, 0);
  const estimatedProfit = shares - notional - estimatedFee;
  const decision: BuyTradeDecision = {
    action: "BUY",
    eventSlug: first.eventSlug,
    marketSlug: first.marketSlug,
    question: first.question,
    tokenId: first.tokenId,
    conditionId: first.conditionId,
    outcome: first.outcome,
    bestAsk: first.price,
    availableSize: legs.reduce((total, leg) => total + leg.availableSize, 0),
    shares,
    notional,
    estimatedFee,
    estimatedNetReturn: estimatedProfit / notional,
    legs: [...legs]
  };

  if (first.line !== undefined) decision.line = first.line;
  if (first.strategy !== undefined) decision.strategy = first.strategy;
  if (first.lossRequiresGoals !== undefined) decision.lossRequiresGoals = first.lossRequiresGoals;
  if (first.locked !== undefined) decision.locked = first.locked;
  if (first.tickSize) decision.tickSize = first.tickSize;
  if (first.negRisk !== undefined) decision.negRisk = first.negRisk;
  if (first.resting !== undefined) decision.resting = first.resting;
  if (first.tailWindowSource !== undefined) decision.tailWindowSource = first.tailWindowSource;
  if (first.tailWindowDetails !== undefined) decision.tailWindowDetails = first.tailWindowDetails;
  return decision;
}

function isEligibleEntryPrice(
  price: number,
  selected: SelectedStrategyMarket,
  thresholds: Pick<DecisionThresholds, "maxEntryPrice">
): boolean {
  if (price > thresholds.maxEntryPrice) return false;
  if (selected.locked === true && price < LOCKED_ENTRY_PRICE_FLOOR) return false;
  return true;
}

function validateTradeInputs(
  match: MatchState,
  selected: SelectedStrategyMarket,
  orderbook: OrderbookSnapshot,
  thresholds: DecisionThresholds
): { action: "OK" } | { action: "NO_TRADE"; decision: NoTradeDecision } {
  const tailWindow = classifyTailWindow(match, {
    entryWindowMinutes: thresholds.entryWindowMinutes
  });
  if (selected.locked === true && !isLiveMatch(match)) {
    return { action: "NO_TRADE", decision: noTrade("MATCH_NOT_LATE_ENOUGH", match.eventSlug, `period=${match.period} isLive=${match.isLive} ended=${match.ended === true}`) };
  }

  if (selected.locked !== true && !tailWindow.eligible) {
    return { action: "NO_TRADE", decision: noTrade("MATCH_NOT_LATE_ENOUGH", match.eventSlug, tailWindow.details) };
  }

  if (selected.locked !== true && selected.lossRequiresGoals < MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS) {
    return { action: "NO_TRADE", decision: noTrade("NO_ELIGIBLE_STRATEGY", match.eventSlug, `Candidate only requires ${selected.lossRequiresGoals} adverse goal(s) to lose; minimum is ${MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS}`) };
  }

  if (!lockedConditionMatchesScore(match, selected)) {
    return {
      action: "NO_TRADE",
      decision: noTrade(
        "NO_ELIGIBLE_STRATEGY",
        match.eventSlug,
        `Locked candidate ${selected.strategy} is not confirmed by current score ${match.homeGoals}-${match.awayGoals}`
      )
    };
  }

  if (orderbook.tokenId !== selected.tokenId) {
    return { action: "NO_TRADE", decision: noTrade("ORDERBOOK_UNAVAILABLE", match.eventSlug, "Orderbook token does not match selected spread token") };
  }

  if (orderbook.asks.length === 0) {
    return { action: "NO_TRADE", decision: noTrade("ORDERBOOK_UNAVAILABLE", match.eventSlug, "Orderbook has no asks") };
  }

  const asks = sortedPositiveAsks(orderbook.asks);
  if (asks.length === 0) {
    return { action: "NO_TRADE", decision: noTrade("DEPTH_TOO_SMALL", match.eventSlug, "Orderbook asks have no positive size") };
  }

  const firstAsk = asks[0]?.price;
  if (firstAsk === undefined) {
    return { action: "NO_TRADE", decision: noTrade("ORDERBOOK_UNAVAILABLE", match.eventSlug, "Orderbook has no best ask") };
  }

  if (selected.locked === true && firstAsk < LOCKED_ENTRY_PRICE_FLOOR) {
    return { action: "NO_TRADE", decision: noTrade("DEPTH_TOO_SMALL", match.eventSlug, `Locked orderbook best ask ${firstAsk} is below locked floor ${LOCKED_ENTRY_PRICE_FLOOR}`) };
  }

  if (firstAsk > thresholds.maxEntryPrice) {
    return { action: "NO_TRADE", decision: noTrade("PRICE_TOO_HIGH", match.eventSlug, `Best ask ${firstAsk} exceeds max ${thresholds.maxEntryPrice}`) };
  }

  return { action: "OK" };
}

export function lockedConditionMatchesScore(match: MatchState, selected: SelectedStrategyMarket): boolean {
  if (selected.locked !== true) return true;
  if (selected.strategy === "total_over_locked") {
    return normalizedOutcome(selected.outcome) === "over"
      && selected.line !== undefined
      && match.homeGoals + match.awayGoals >= overLocksAt(selected.line);
  }
  if (selected.strategy === "team_total_over_locked") {
    if (normalizedOutcome(selected.outcome) !== "over" || selected.line === undefined || !selected.team) return false;
    const score = findTeamScore(match, selected.team);
    return score !== undefined && score >= overLocksAt(selected.line);
  }
  if (selected.strategy === "btts_yes_locked") {
    return normalizedOutcome(selected.outcome) === "yes" && match.homeGoals > 0 && match.awayGoals > 0;
  }
  return false;
}

function isLiveMatch(match: MatchState): boolean {
  return match.isLive
    && match.ended !== true
    // Markets settle on 90 minutes plus stoppage; an extra-time goal cannot lock one.
    && (match.period === "1H" || match.period === "HT" || match.period === "2H");
}

function overLocksAt(line: number): number {
  return Math.floor(line) + 1;
}

function findTeamScore(match: MatchState, team: string): number | undefined {
  const target = normalizeTeam(team);
  const home = normalizeTeam(match.homeTeam);
  const away = normalizeTeam(match.awayTeam);
  if (target === home || target.includes(home) || home.includes(target)) return match.homeGoals;
  if (target === away || target.includes(away) || away.includes(target)) return match.awayGoals;
  return undefined;
}

function normalizedOutcome(value: string): string {
  return normalizeTeam(value);
}

function normalizeTeam(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((part) => part.length > 0 && part !== "and")
    .join(" ");
}

function sortedPositiveAsks(asks: readonly PriceLevel[]): PriceLevel[] {
  return asks
    .filter((ask) => Number.isFinite(ask.price) && Number.isFinite(ask.size) && ask.price > 0 && ask.price < 1 && ask.size > 0)
    .sort((a, b) => a.price - b.price);
}

function noTrade(reason: NoTradeDecision["reason"], eventSlug: string, details?: string): NoTradeDecision {
  const decision: NoTradeDecision = { action: "NO_TRADE", reason, eventSlug };
  if (details) decision.details = details;
  return decision;
}

function noExecutableLevelDecision(
  match: MatchState,
  selected: SelectedStrategyMarket,
  orderbook: OrderbookSnapshot,
  thresholds: DecisionThresholds
): NoTradeDecision {
  const asks = sortedPositiveAsks(orderbook.asks);
  const eligibleReturns = asks
    .filter((ask) => isEligibleEntryPrice(ask.price, selected, thresholds))
    .map((ask) => netReturnRate(ask.price));
  const bestReturn = eligibleReturns[0];
  if (bestReturn !== undefined && bestReturn < thresholds.minimumNetReturn) {
    return noTrade("RETURN_TOO_LOW", match.eventSlug, `Net return ${bestReturn} below minimum ${thresholds.minimumNetReturn}`);
  }
  const bestNotional = Math.max(0, ...asks
    .filter((ask) => isEligibleEntryPrice(ask.price, selected, thresholds) && netReturnRate(ask.price) >= thresholds.minimumNetReturn)
    .map((ask) => ask.price * ask.size));
  return noTrade("DEPTH_TOO_SMALL", match.eventSlug, `Available notional ${bestNotional} below minimum ${thresholds.minimumNotional}`);
}
