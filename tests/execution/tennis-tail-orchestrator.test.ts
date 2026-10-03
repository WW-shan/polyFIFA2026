import { describe, expect, test } from "vitest";
import {
  TENNIS_TAIL_LADDER_PRICES,
  isTennisTailEntry,
  planTennisTailLadder,
  resolveTennisTailToken,
  type TennisTailLadderConfig,
  type TennisTailMarket,
  type TennisTailPlanInput
} from "../../src/execution/tennis-tail-orchestrator.js";
import type { OrderbookSnapshot } from "../../src/domain/types.js";

const market: TennisTailMarket = {
  eventSlug: "atp-swiatek-gauff-2026-10-03",
  eventTitle: "Iga Swiatek vs. Coco Gauff",
  marketSlug: "atp-swiatek-gauff-2026-10-03-moneyline",
  conditionId: "cond-ml",
  outcomes: ["Iga Swiatek", "Coco Gauff"],
  tokenIds: ["token-swiatek", "token-gauff"],
  marketType: "moneyline",
  tickSize: "0.01",
  negRisk: false
};

const frame = { homeName: "Iga Swiatek", awayName: "Coco Gauff" };
const gen1 = { favored: "home" as const, oneSetFromMatch: true, lateSet: true };

/** One-share research ladder: isolates the pricing rules from venue minimums. */
const RESEARCH: TennisTailLadderConfig = {
  prices: TENNIS_TAIL_LADDER_PRICES,
  sharesPerLevel: 1,
  maxNotionalPerEvent: 4.35,
  maxNotionalPerDay: 130.5
};

function book(overrides: Partial<OrderbookSnapshot> = {}): OrderbookSnapshot {
  return {
    tokenId: "token-swiatek",
    bids: [{ price: 0.93, size: 500 }],
    asks: [{ price: 0.95, size: 500 }],
    tickSize: "0.01",
    negRisk: false,
    ...overrides
  };
}

function plan(overrides: Partial<TennisTailPlanInput> = {}, config: Partial<TennisTailLadderConfig> = {}) {
  return planTennisTailLadder({
    market,
    frame,
    signal: gen1,
    orderbook: book(),
    config: { ...RESEARCH, ...config },
    ...overrides
  });
}

describe("tennis tail eligibility", () => {
  test("Gen1 requires one set from the match and a decided late set", () => {
    expect(isTennisTailEntry({ oneSetFromMatch: true, lateSet: true })).toBe(true);
    expect(isTennisTailEntry({ oneSetFromMatch: true, lateSet: false })).toBe(false);
    expect(isTennisTailEntry({ oneSetFromMatch: false, lateSet: true })).toBe(false);
  });
});

describe("resolveTennisTailToken", () => {
  test("uses title orientation, not outcome order", () => {
    expect(resolveTennisTailToken(market, frame, "home")).toMatchObject({ tokenId: "token-swiatek", outcomeIndex: 0 });
    const swapped: TennisTailMarket = {
      ...market,
      eventTitle: "Coco Gauff vs. Iga Swiatek",
      outcomes: ["Coco Gauff", "Iga Swiatek"],
      tokenIds: ["token-gauff", "token-swiatek"]
    };
    expect(resolveTennisTailToken(swapped, frame, "home")).toMatchObject({ tokenId: "token-swiatek", outcomeIndex: 1 });
  });

  test("refuses an unparseable or mismatched title", () => {
    expect(resolveTennisTailToken({ ...market, eventTitle: "Swiatek wins" }, frame, "home")).toBeNull();
    expect(resolveTennisTailToken({ ...market, outcomes: ["Someone", "Else"] }, frame, "home")).toBeNull();
  });
});

describe("planTennisTailLadder", () => {
  test("arms the full default ladder when the book is restable", () => {
    const result = plan();
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels.map((level) => level.price)).toEqual([...TENNIS_TAIL_LADDER_PRICES]);
    expect(result.plan.reservedNotional).toBeCloseTo(4.35, 10);
    expect(result.plan.tokenId).toBe("token-swiatek");
    expect(result.plan.outcome).toBe("Iga Swiatek");
    expect(result.plan.bestBid).toBe(0.93);
    expect(result.plan.bestAsk).toBe(0.95);
  });

  test("skips a non-Gen1 signal", () => {
    const result = plan({ signal: { favored: "home", oneSetFromMatch: true, lateSet: false } });
    expect(result).toMatchObject({ action: "SKIP", reason: "NOT_GEN1" });
  });

  test("skips non-moneyline markets", () => {
    const result = plan({ market: { ...market, marketType: "tennis_game_handicap" } });
    expect(result).toMatchObject({ action: "SKIP", reason: "MARKET_NOT_MONEYLINE" });
  });

  test("drops levels that would cross the ask instead of repricing", () => {
    const result = plan({ orderbook: book({ asks: [{ price: 0.90, size: 500 }] }) });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels.map((level) => level.price)).toEqual([0.80, 0.85, 0.88]);
  });

  test("drops levels that would improve the best bid", () => {
    const result = plan({ orderbook: book({ bids: [{ price: 0.86, size: 500 }] }) });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels.map((level) => level.price)).toEqual([0.80, 0.85]);
  });

  test("enforces the per-event notional cap", () => {
    const result = plan({}, { maxNotionalPerEvent: 2 });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels.map((level) => level.price)).toEqual([0.80, 0.85]);
    expect(result.plan.reservedNotional).toBeCloseTo(1.65, 10);
  });

  test("skips when the day budget is already spent", () => {
    const result = plan({ committedDayNotional: RESEARCH.maxNotionalPerDay });
    expect(result).toMatchObject({ action: "SKIP", reason: "BUDGET_EXHAUSTED" });
  });

  test("subtracts notional already committed to the event", () => {
    const result = plan({ committedEventNotional: 3.5 }, { maxNotionalPerEvent: 4.35 });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    // Only 0.85 of the event cap is left, so only the 0.80 level fits.
    expect(result.plan.levels.map((level) => level.price)).toEqual([0.80]);
  });

  test("respects a coarse tick size", () => {
    const result = plan({
      orderbook: book({ tickSize: "0.1" }),
      market: { ...market, tickSize: "0.1" }
    });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels.map((level) => level.price)).toEqual([0.80, 0.90]);
  });

  test("skips when the book has no usable bid", () => {
    const result = plan({ orderbook: book({ bids: [] }) });
    expect(result).toMatchObject({ action: "SKIP", reason: "ORDERBOOK_UNRESTABLE" });
  });

  test("raises levels to the venue minimum order size", () => {
    const result = plan({ orderbook: book({ minimumOrderSize: 5 }) }, { maxNotionalPerEvent: 21.75 });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels.every((level) => level.shares === 5)).toBe(true);
    expect(result.plan.reservedNotional).toBeCloseTo(21.75, 10);
    expect(result.plan.minimumOrderSize).toBe(5);
  });

  test("truncates the ladder when the venue minimum no longer fits the budget", () => {
    // 5 shares at 0.80 cost 4.00 of the 4.35 research budget; 0.85 does not fit.
    const result = plan({ orderbook: book({ minimumOrderSize: 5 }) });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels.map((level) => level.price)).toEqual([0.80]);
    expect(result.plan.levels[0]!.shares).toBe(5);
  });

  test("skips a level that is already resting", () => {
    const result = plan({ alreadyPlacedPrices: [0.80, 0.85] });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels.map((level) => level.price)).toEqual([0.88, 0.90, 0.92]);
  });

  test("reports no new levels when every qualifying price already rests", () => {
    const result = plan({ alreadyPlacedPrices: [0.80, 0.85, 0.88, 0.90, 0.92] });
    expect(result).toMatchObject({ action: "SKIP", reason: "NO_NEW_LEVELS" });
  });

  test("requires the favoured token to hold the market's best bid", () => {
    const behind = plan({ otherBestBid: 0.94 });
    expect(behind).toMatchObject({ action: "SKIP", reason: "NOT_MARKET_LEADER" });
    const ahead = plan({ otherBestBid: 0.93 });
    expect(ahead.action).toBe("ARM");
    const tied = plan({ otherBestBid: 0.93 });
    expect(tied.action).toBe("ARM");
  });

  test("scales shares per level", () => {
    const result = plan({}, { sharesPerLevel: 10, maxNotionalPerEvent: 43.5, maxNotionalPerDay: 1305 });
    expect(result.action).toBe("ARM");
    if (result.action !== "ARM") return;
    expect(result.plan.levels).toHaveLength(5);
    expect(result.plan.levels[0]).toMatchObject({ price: 0.80, shares: 10, notional: 8 });
    expect(result.plan.reservedNotional).toBeCloseTo(43.5, 10);
  });
});
