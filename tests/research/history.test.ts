import { describe, expect, test } from "vitest";
import { isResearchMatch, normalizeResearchEvent, normalizeResearchTrade, resolvePayouts } from "../../src/research/history.js";

const tokenA = "8944870794724982616739737855931128457392338556453357131507170402314088626403";
const tokenB = "88669986253050959394429898768455959663720039095515426056968574192793109008117";

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "event", slug: "atp-a-b-2026-09-11", title: "A vs B", gameId: 123,
    startTime: "2026-09-11T10:00:00Z", endDate: "2026-09-18T10:00:00Z",
    finishedTimestamp: "2026-09-11T11:26:03.63953Z", closed: true,
    markets: [{ id: "market", slug: "atp-a-b-2026-09-11", conditionId: "0xcondition", question: "A vs B",
      sportsMarketType: "moneyline", outcomes: '["A","B"]', clobTokenIds: JSON.stringify([tokenA, tokenB]),
      closed: true, umaResolutionStatus: "resolved", outcomePrices: '["1","0"]', description: "Retirement and walkover rules" }],
    ...overrides
  };
}

describe("research event normalization", () => {
  test("retains both outcomes, exact token IDs, raw rules and actual finish provenance", () => {
    const raw = event();
    const normalized = normalizeResearchEvent(raw, "tennis");
    expect(normalized).toMatchObject({
      eventId: "event", gameId: "123", sport: "tennis", startMs: Date.parse("2026-09-11T10:00:00Z"),
      startSource: "gamma.startTime", finishMs: Date.parse("2026-09-11T11:26:03.63953Z"), finishSource: "gamma.finishedTimestamp"
    });
    expect(normalized?.raw).toBe(raw);
    expect(normalized?.markets[0]).toMatchObject({
      marketType: "moneyline", horizon: "match", resolutionSource: "gamma-resolved-prices", trades: [], coverage: null,
      outcomes: [{ tokenId: tokenA, name: "A", payout: 1 }, { tokenId: tokenB, name: "B", payout: 0 }]
    });
    expect(normalized?.markets[0]?.raw.description).toBe("Retirement and walkover rules");
  });

  test("never treats metadata expiry or market closure as match finish", () => {
    const normalized = normalizeResearchEvent(event({ finishedTimestamp: undefined, closedTime: "2026-09-11T11:56:00Z" }), "tennis");
    expect(normalized?.finishMs).toBeNull();
    expect(normalized?.finishSource).toBeNull();
  });

  test("uses gameStartTime, not creation startDate, when event startTime is missing", () => {
    const raw = event({ startTime: undefined, startDate: "2026-09-10T12:00Z" });
    const noStart = normalizeResearchEvent(raw, "tennis");
    expect(noStart?.startMs).toBeNull();
    raw.markets[0] = { ...raw.markets[0]!, gameStartTime: "2026-09-11 10:05:00+00" } as typeof raw.markets[0];
    expect(normalizeResearchEvent(raw, "tennis")).toMatchObject({ startMs: Date.parse("2026-09-11T10:05:00Z"), startSource: "gamma.market.gameStartTime" });
  });

  test("separates subperiod market horizons and does not drop unknown market types", () => {
    const raw = event();
    raw.markets = ["tennis_first_set_winner", "tennis_set_winner", "tennis_set_games_totals", "tennis_match_totals", "tennis_set_totals", "future_type"].map((type, index) => ({
      ...raw.markets[0]!, id: String(index), sportsMarketType: type
    }));
    expect(normalizeResearchEvent(raw, "tennis")?.markets.map(m => m.horizon)).toEqual(["set", "set", "set", "match", "match", "unknown"]);
  });

  test("does not accept malformed identities and does not mistake non-match tennis news for a game", () => {
    expect(normalizeResearchEvent({ slug: "missing-id" }, "tennis")).toBeNull();
    expect(isResearchMatch(normalizeResearchEvent(event(), "tennis")!)).toBe(true);
    const news = normalizeResearchEvent(event({ gameId: undefined, startTime: undefined }), "tennis")!;
    expect(isResearchMatch(news)).toBe(false);
    const itf = normalizeResearchEvent(event({ gameId: undefined, finishedTimestamp: undefined }), "tennis")!;
    expect(isResearchMatch(itf)).toBe(true);
  });
});

describe("payout evidence", () => {
  test("requires resolved status, not merely closed or a price of one", () => {
    expect(resolvePayouts({ closed: false, umaResolutionStatus: "resolved", outcomePrices: '["1","0"]' }, 2)).toBeNull();
    expect(resolvePayouts({ closed: true, umaResolutionStatus: "proposed", outcomePrices: '["1","0"]' }, 2)).toBeNull();
    expect(resolvePayouts({ closed: true, outcomePrices: '["1","0"]' }, 2)).toBeNull();
  });
  test("preserves 50-50 resolution, including its loss against a bid above .5", () => {
    expect(resolvePayouts({ closed: true, umaResolutionStatus: "resolved", outcomePrices: '["0.5","0.5"]' }, 2)).toEqual([.5, .5]);
  });
  test.each([[1], [1, 1], [1.01, -.01], ["", 1], [null, 1], [false, 1], "broken"].map(prices => [prices]))("rejects invalid payout vector %j", (prices) => {
    expect(resolvePayouts({ closed: true, umaResolutionStatus: "resolved", outcomePrices: prices }, 2)).toBeNull();
  });
});

describe("public trade normalization", () => {
  const raw = { transactionHash: "0xtx", proxyWallet: "0xpublicwallet", conditionId: "0xcondition", asset: tokenA,
    timestamp: 1789125900, side: "SELL", price: .69, size: 3 };
  test("retains direction, source time and quantity without treating a BUY as a SELL", () => {
    expect(normalizeResearchTrade(raw, "0xcondition", [tokenA, tokenB])).toMatchObject({
      transactionHash: "0xtx", tokenId: tokenA, timestampMs: 1789125900000, side: "SELL", price: .69, size: 3
    });
    expect(normalizeResearchTrade({ ...raw, side: "BUY" }, "0xcondition", [tokenA, tokenB])?.side).toBe("BUY");
  });
  test("row identity deduplicates exact repeats but distinguishes separate quantities/directions", () => {
    const trade = normalizeResearchTrade(raw, "0xcondition", [tokenA, tokenB]);
    expect(trade?.id).toBeTruthy();
    expect(normalizeResearchTrade({ ...raw }, "0xcondition", [tokenA, tokenB])?.id).toBe(trade?.id);
    expect(normalizeResearchTrade({ ...raw, size: 5 }, "0xcondition", [tokenA, tokenB])?.id).not.toBe(trade?.id);
  });
  test.each([{ asset: 123 }, { asset: "unmapped" }, { conditionId: "wrong" }, { timestamp: "" }, { timestamp: -1 },
    { price: null }, { price: 1.01 }, { size: 0 }, { size: "NaN" }, { side: "UNKNOWN" }, { transactionHash: "" }])("rejects malformed/mismatched observation %j", (overrides) => {
    expect(normalizeResearchTrade({ ...raw, ...overrides }, "0xcondition", [tokenA, tokenB])).toBeNull();
  });
});
