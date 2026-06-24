import { netReturnRate, sportsTakerFeePerShare } from "./fees.js";
import { classifyTailWindow, type TailWindowMode } from "./time-window.js";
import type {
  BuyTradeDecision,
  DecisionThresholds,
  MatchState,
  NoTradeDecision,
  OrderbookSnapshot,
  PriceLevel,
  SelectedStrategyMarket,
  TradeDecision
} from "./types.js";

export function buildTradeDecision(
  match: MatchState,
  selected: SelectedStrategyMarket,
  orderbook: OrderbookSnapshot,
  thresholds: DecisionThresholds,
  tailWindowMode?: TailWindowMode
): TradeDecision {
  const tailWindow = classifyTailWindow(match, {
    entryWindowMinutes: thresholds.entryWindowMinutes,
    ...(tailWindowMode ? { mode: tailWindowMode } : {})
  });
  if (!tailWindow.eligible) {
    return noTrade("MATCH_NOT_LATE_ENOUGH", match.eventSlug, tailWindow.details);
  }

  if (selected.lossRequiresGoals < 2) {
    return noTrade("NO_ELIGIBLE_STRATEGY", match.eventSlug, `Candidate only requires ${selected.lossRequiresGoals} adverse goal(s) to lose`);
  }

  if (orderbook.tokenId !== selected.tokenId) {
    return noTrade("ORDERBOOK_UNAVAILABLE", match.eventSlug, "Orderbook token does not match selected spread token");
  }

  if (orderbook.asks.length === 0) {
    return noTrade("ORDERBOOK_UNAVAILABLE", match.eventSlug, "Orderbook has no asks");
  }

  const asks = sortedPositiveAsks(orderbook.asks);
  if (asks.length === 0) {
    return noTrade("DEPTH_TOO_SMALL", match.eventSlug, "Orderbook asks have no positive size");
  }

  const firstAsk = asks[0]?.price;
  if (firstAsk === undefined) {
    return noTrade("ORDERBOOK_UNAVAILABLE", match.eventSlug, "Orderbook has no best ask");
  }

  if (firstAsk > thresholds.maxEntryPrice) {
    return noTrade("PRICE_TOO_HIGH", match.eventSlug, `Best ask ${firstAsk} exceeds max ${thresholds.maxEntryPrice}`);
  }

  const executableLevel = findExecutableAskLevel(asks, thresholds);
  if (!executableLevel) {
    const eligibleReturns = asks.filter((ask) => ask.price <= thresholds.maxEntryPrice).map((ask) => netReturnRate(ask.price));
    const bestReturn = eligibleReturns[0];
    if (bestReturn !== undefined && bestReturn < thresholds.minimumNetReturn) {
      return noTrade("RETURN_TOO_LOW", match.eventSlug, `Net return ${bestReturn} below minimum ${thresholds.minimumNetReturn}`);
    }
    return noTrade("DEPTH_TOO_SMALL", match.eventSlug, "No eligible ask level has enough same-price notional");
  }

  const { price: bestAsk, availableSize, estimatedNetReturn } = executableLevel;
  const shares = Math.min(thresholds.maxNotional / bestAsk, availableSize);
  const notional = shares * bestAsk;

  if (shares <= 0 || notional < thresholds.minimumNotional) {
    return noTrade("DEPTH_TOO_SMALL", match.eventSlug, `Available notional ${notional} below minimum ${thresholds.minimumNotional}`);
  }

  const estimatedFee = shares * sportsTakerFeePerShare(bestAsk);
  const decision: BuyTradeDecision = {
    action: "BUY",
    eventSlug: match.eventSlug,
    marketSlug: selected.marketSlug,
    question: selected.question,
    tokenId: selected.tokenId,
    conditionId: selected.conditionId,
    outcome: selected.outcome,
    bestAsk,
    availableSize,
    shares,
    notional,
    estimatedFee,
    estimatedNetReturn,
    strategy: selected.strategy,
    lossRequiresGoals: selected.lossRequiresGoals,
    tailWindowSource: tailWindow.source,
    tailWindowDetails: tailWindow.details
  };

  if (selected.line !== undefined) decision.line = selected.line;
  if (selected.locked !== undefined) decision.locked = selected.locked;
  if (selected.tickSize) decision.tickSize = selected.tickSize;
  if (selected.negRisk !== undefined) decision.negRisk = selected.negRisk;

  return decision;
}

function sortedPositiveAsks(asks: readonly PriceLevel[]): PriceLevel[] {
  return asks
    .filter((ask) => Number.isFinite(ask.price) && Number.isFinite(ask.size) && ask.price > 0 && ask.price < 1 && ask.size > 0)
    .sort((a, b) => a.price - b.price);
}

function findExecutableAskLevel(
  asks: readonly PriceLevel[],
  thresholds: DecisionThresholds
): { price: number; availableSize: number; estimatedNetReturn: number } | null {
  const prices = [...new Set(asks.map((ask) => ask.price))].sort((a, b) => a - b);
  for (const price of prices) {
    if (price > thresholds.maxEntryPrice) continue;
    const estimatedNetReturn = netReturnRate(price);
    if (estimatedNetReturn < thresholds.minimumNetReturn) continue;
    const availableSize = asks
      .filter((ask) => ask.price === price)
      .reduce((total, ask) => total + ask.size, 0);
    const notional = Math.min(thresholds.maxNotional / price, availableSize) * price;
    if (notional >= thresholds.minimumNotional) {
      return { price, availableSize, estimatedNetReturn };
    }
  }
  return null;
}

function noTrade(reason: NoTradeDecision["reason"], eventSlug: string, details?: string): NoTradeDecision {
  const decision: NoTradeDecision = { action: "NO_TRADE", reason, eventSlug };
  if (details) decision.details = details;
  return decision;
}
