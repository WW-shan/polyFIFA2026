/**
 * Live orchestration for the tennis tail resting-bid strategy.
 *
 * The backtest (data/research/backtest-audit-20261003.md) pinned the shape of
 * the trade:
 *
 *  - market: tennis moneyline only;
 *  - signal: Gen1 - the favourite has won `setsToWin - 1` sets and the live set
 *    is at 5-x (x<=4), 6-5 or 6-6, i.e. the set is decided by the next games;
 *  - orders: post-only passive bids, placed the moment Gen1 appears, held to
 *    settlement (do not pull on a break back);
 *  - ladder: 0.80 / 0.85 / 0.88 / 0.90 / 0.92.
 *
 * This module owns the *decision* half of that: eligibility, favoured-token
 * resolution, ladder construction and the exposure caps. It performs no I/O so
 * the same rules can be unit-tested and reused by the dry-run and live paths.
 */
import type { MarketTickSize, OrderbookSnapshot, PriceLevel } from "../domain/types.js";
import type { TennisEntrySignal, TennisPointFrame } from "../collector/tennis-points.js";
import { tennisFrameSideForTitleOutcome, tennisNamesMatch } from "../collector/tennis-points.js";
import { priceConformsToTickSize } from "./live-executor.js";

/** Default ladder from the 2026-10-03 backtest. Ascending price order. */
export const TENNIS_TAIL_LADDER_PRICES: readonly number[] = [0.80, 0.85, 0.88, 0.90, 0.92];

/** A moneyline market the orchestrator may arm a ladder on. */
export interface TennisTailMarket {
  eventSlug: string;
  /** Gamma event title, `Player A vs. Player B`; used to orient 365Scores home/away. */
  eventTitle: string;
  marketSlug: string;
  conditionId: string;
  outcomes: readonly string[];
  tokenIds: readonly string[];
  /** Polymarket `sportsMarketType`; only `moneyline` is traded. */
  marketType?: string;
  tickSize?: MarketTickSize;
  negRisk?: boolean;
}

export interface TennisTailLadderConfig {
  /** Bid prices, ascending. Defaults to {@link TENNIS_TAIL_LADDER_PRICES}. */
  prices?: readonly number[];
  /** Shares resting at every price level. */
  sharesPerLevel: number;
  /** Hard ceiling on resting notional for a single event. */
  maxNotionalPerEvent: number;
  /** Hard ceiling on resting notional for the whole day. */
  maxNotionalPerDay: number;
}

export const DEFAULT_TENNIS_TAIL_LADDER: TennisTailLadderConfig = {
  prices: TENNIS_TAIL_LADDER_PRICES,
  // Polymarket's tennis moneyline book enforces min_order_size = 5 shares, so a
  // 1-share research ladder cannot be posted live. The planner raises every
  // level to the venue minimum and the exposure caps still bound the result.
  sharesPerLevel: 5,
  // One full 5-level ladder costs 5 * (0.80+0.85+0.88+0.90+0.92) = 21.75.
  maxNotionalPerEvent: 21.75,
  // Historical max simultaneous reservation was 13.05 at 1 share (~65 at 5
  // shares); allow ten concurrent full ladders and let the operator tighten it.
  maxNotionalPerDay: 217.5
};

export interface TennisTailLevelPlan {
  price: number;
  shares: number;
  notional: number;
}

export interface TennisTailLadderPlan {
  eventSlug: string;
  eventTitle: string;
  marketSlug: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  favoredSide: "home" | "away";
  levels: TennisTailLevelPlan[];
  reservedNotional: number;
  bestBid?: number;
  bestAsk?: number;
  tickSize: MarketTickSize;
  negRisk: boolean;
  /** Venue `min_order_size` the level shares were raised to, when present. */
  minimumOrderSize?: number;
}

export type TennisTailSkipReason =
  | "NOT_GEN1"
  | "MARKET_NOT_MONEYLINE"
  | "NO_MATCHING_TOKEN"
  | "ORDERBOOK_UNRESTABLE"
  | "BUDGET_EXHAUSTED";

export type TennisTailPlanResult =
  | { action: "ARM"; plan: TennisTailLadderPlan }
  | { action: "SKIP"; reason: TennisTailSkipReason; details: string };

export interface TennisTailPlanInput {
  market: TennisTailMarket;
  frame: Pick<TennisPointFrame, "homeName" | "awayName">;
  signal: Pick<TennisEntrySignal, "favored" | "oneSetFromMatch" | "lateSet">;
  orderbook: OrderbookSnapshot;
  config: TennisTailLadderConfig;
  /** Resting notional already committed to this event (unfilled bids + fills). */
  committedEventNotional?: number;
  /** Resting notional already committed across all events today. */
  committedDayNotional?: number;
}

/** Gen1: one set from the match and the live set is about to be decided. */
export function isTennisTailEntry(
  signal: Pick<TennisEntrySignal, "oneSetFromMatch" | "lateSet">
): boolean {
  return signal.oneSetFromMatch && signal.lateSet;
}

/**
 * Resolve the Polymarket outcome token for the 365Scores-favoured player.
 *
 * 365Scores and Polymarket do not guarantee the same home/away order, so the
 * title orientation is the authority. The outcome name is re-checked against
 * the title side to avoid arming the wrong player on a malformed title.
 */
export function resolveTennisTailToken(
  market: TennisTailMarket,
  frame: Pick<TennisPointFrame, "homeName" | "awayName">,
  favored: "home" | "away"
): { tokenId: string; outcome: string; outcomeIndex: number } | null {
  const [left, right] = splitTitle(market.eventTitle);
  if (!left || !right) return null;
  const favoredTitleName = favored === "home" ? frame.homeName : frame.awayName;
  // The frame side the favoured player corresponds to must agree with the
  // title/outcome mapping; if it does not, refuse rather than guess.
  const candidates = [0, 1].filter((index) => {
    const side = tennisFrameSideForTitleOutcome(frame, market.eventTitle, index);
    if (side !== favored) return false;
    const outcome = market.outcomes[index];
    if (typeof outcome !== "string") return false;
    const titleSide = index === 0 ? left : right;
    return tennisNamesMatch(outcome, titleSide) || tennisNamesMatch(outcome, favoredTitleName);
  });
  if (candidates.length !== 1) return null;
  const index = candidates[0]!;
  const tokenId = market.tokenIds[index];
  const outcome = market.outcomes[index];
  if (typeof tokenId !== "string" || tokenId.length === 0 || typeof outcome !== "string") return null;
  return { tokenId, outcome, outcomeIndex: index };
}

function splitTitle(title: string): [string | null, string | null] {
  const [left, right] = title.split(/\s+vs\.?\s+/i);
  return [left?.trim() || null, right?.trim() || null];
}

function bestBid(book: OrderbookSnapshot): number | undefined {
  return bestLevel(book.bids, "max");
}

function bestAsk(book: OrderbookSnapshot): number | undefined {
  return bestLevel(book.asks, "min");
}

function bestLevel(levels: readonly PriceLevel[], direction: "min" | "max"): number | undefined {
  const usable = levels.filter((level) =>
    Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.price < 1 && level.size > 0);
  if (usable.length === 0) return undefined;
  return usable.reduce(
    (best, level) => direction === "min" ? Math.min(best, level.price) : Math.max(best, level.price),
    usable[0]!.price
  );
}

/**
 * Build the passive ladder for one Gen1 market snapshot.
 *
 * Every level must satisfy the backtest's maker rule at placement:
 * `bestBid >= price` (do not improve the book) and `bestAsk > price` (do not
 * cross and take). A level that would cross is dropped, never repriced.
 */
export function planTennisTailLadder(input: TennisTailPlanInput): TennisTailPlanResult {
  const { market, frame, signal, orderbook, config } = input;
  if (market.marketType !== undefined && market.marketType !== "moneyline") {
    return { action: "SKIP", reason: "MARKET_NOT_MONEYLINE", details: `market type is ${market.marketType}` };
  }
  if (!isTennisTailEntry(signal)) {
    return { action: "SKIP", reason: "NOT_GEN1", details: "signal is not one-set-from-match in a late set" };
  }
  const resolved = resolveTennisTailToken(market, frame, signal.favored);
  if (!resolved) {
    return {
      action: "SKIP",
      reason: "NO_MATCHING_TOKEN",
      details: `no ${market.eventSlug} outcome maps to 365Scores ${signal.favored} side`
    };
  }

  const tickSize: MarketTickSize = orderbook.tickSize ?? market.tickSize ?? "0.01";
  const negRisk = orderbook.negRisk ?? market.negRisk ?? false;
  const minimumOrderSize = Number.isFinite(orderbook.minimumOrderSize) && orderbook.minimumOrderSize! > 0
    ? orderbook.minimumOrderSize!
    : 0;
  const requestedShares = config.sharesPerLevel;
  if (!Number.isFinite(requestedShares) || requestedShares <= 0) {
    return { action: "SKIP", reason: "ORDERBOOK_UNRESTABLE", details: `shares per level must be positive, got ${config.sharesPerLevel}` };
  }
  // The venue rejects a resting bid below `min_order_size`; post the smallest
  // order it accepts instead of silently never arming the ladder.
  const sharesPerLevel = Math.max(requestedShares, minimumOrderSize);
  const bid = bestBid(orderbook);
  const ask = bestAsk(orderbook);
  const prices = [...(config.prices ?? TENNIS_TAIL_LADDER_PRICES)].sort((a, b) => a - b);
  const eventBudget = Math.max(0, config.maxNotionalPerEvent - (input.committedEventNotional ?? 0));
  const dayBudget = Math.max(0, config.maxNotionalPerDay - (input.committedDayNotional ?? 0));
  let remaining = Math.min(eventBudget, dayBudget);
  const levels: TennisTailLevelPlan[] = [];
  let droppedForBudget = false;

  for (const price of prices) {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
    if (!priceConformsToTickSize(price, tickSize)) continue;
    if (ask === undefined || price >= ask) continue;
    if (bid === undefined || bid < price) continue;
    const shares = sharesPerLevel;
    const notional = price * shares;
    if (notional > remaining + 1e-9) {
      droppedForBudget = true;
      continue;
    }
    remaining -= notional;
    levels.push({ price, shares, notional });
  }

  if (levels.length === 0) {
    if (droppedForBudget) {
      return {
        action: "SKIP",
        reason: "BUDGET_EXHAUSTED",
        details: `no ladder level fits remaining event/day budget (event ${eventBudget.toFixed(2)}, day ${dayBudget.toFixed(2)})`
      };
    }
    return {
      action: "SKIP",
      reason: "ORDERBOOK_UNRESTABLE",
      details: bid === undefined || ask === undefined
        ? "orderbook is missing a usable bid or ask"
        : `no ladder price rests between bestBid ${bid} and bestAsk ${ask}`
    };
  }

  const reservedNotional = levels.reduce((total, level) => total + level.notional, 0);
  const plan: TennisTailLadderPlan = {
    eventSlug: market.eventSlug,
    eventTitle: market.eventTitle,
    marketSlug: market.marketSlug,
    conditionId: market.conditionId,
    tokenId: resolved.tokenId,
    outcome: resolved.outcome,
    outcomeIndex: resolved.outcomeIndex,
    favoredSide: signal.favored,
    levels,
    reservedNotional,
    tickSize,
    negRisk
  };
  if (minimumOrderSize > 0) plan.minimumOrderSize = minimumOrderSize;
  if (bid !== undefined) plan.bestBid = bid;
  if (ask !== undefined) plan.bestAsk = ask;
  return { action: "ARM", plan };
}
