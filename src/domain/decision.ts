import { netReturnRate, sportsTakerFeePerShare } from "./fees.js";
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
  thresholds: DecisionThresholds
): TradeDecision {
  if (match.minute < thresholds.watchStartMinute) {
    return noTrade("MATCH_NOT_LATE_ENOUGH", match.eventSlug);
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

  const bestAsk = asks[0]?.price;
  if (bestAsk === undefined) {
    return noTrade("ORDERBOOK_UNAVAILABLE", match.eventSlug, "Orderbook has no best ask");
  }

  if (bestAsk > thresholds.maxEntryPrice) {
    return noTrade("PRICE_TOO_HIGH", match.eventSlug, `Best ask ${bestAsk} exceeds max ${thresholds.maxEntryPrice}`);
  }

  const estimatedNetReturn = netReturnRate(bestAsk);
  if (estimatedNetReturn < thresholds.minimumNetReturn) {
    return noTrade("RETURN_TOO_LOW", match.eventSlug, `Net return ${estimatedNetReturn} below minimum ${thresholds.minimumNetReturn}`);
  }

  const availableSize = asks
    .filter((ask) => ask.price === bestAsk)
    .reduce((total, ask) => total + ask.size, 0);
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
    lossRequiresGoals: selected.lossRequiresGoals
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

function noTrade(reason: NoTradeDecision["reason"], eventSlug: string, details?: string): NoTradeDecision {
  const decision: NoTradeDecision = { action: "NO_TRADE", reason, eventSlug };
  if (details) decision.details = details;
  return decision;
}
