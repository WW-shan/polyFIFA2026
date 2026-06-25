import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  decodeInitialStatePayload,
  extractNextInitialState,
  fetchEventStrategyMarkets,
  findMatchState,
  findSpreadMarkets,
  findStrategyMarkets,
  parseSpreadLine
} from "../../src/polymarket/event-page.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("event page initial state parsing", () => {
  test("extracts base64 zlib initialState and normalizes spread markets", () => {
    const state = {
      event: {
        slug: "fifwc-esp-ksa-2026-06-21",
        nested: {
          markets: [
            {
              sportsMarketType: "spreads",
              eventSlug: "fifwc-esp-ksa-2026-06-21",
              slug: "fifwc-esp-ksa-2026-06-21-spread-home-3pt5",
              question: "Spread: Spain (-3.5)",
              conditionId: "cond-spain-3p5",
              clobTokenIds: "[\"token-spain-3p5\",\"token-saudi-plus-3p5\"]",
          outcomes: "[\"Spain\",\"Saudi Arabia\"]",
              orderPriceMinTickSize: 0.01,
              tickSize: "0.001",
              negRisk: false
            }
          ]
        }
      }
    };
    const initialState = deflateSync(JSON.stringify(state)).toString("base64");
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialState } } })}</script></html>`;

    const payload = extractNextInitialState(html);
    expect(payload).toBe(initialState);
    const decoded = decodeInitialStatePayload(payload);
    const markets = findSpreadMarkets(decoded, "fifwc-esp-ksa-2026-06-21");

    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({
      eventSlug: "fifwc-esp-ksa-2026-06-21",
      marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-3pt5",
      question: "Spread: Spain (-3.5)",
      conditionId: "cond-spain-3p5",
      clobTokenIds: ["token-spain-3p5", "token-saudi-plus-3p5"],
      outcomes: ["Spain", "Saudi Arabia"],
      line: -3.5,
      tickSize: "0.001",
      negRisk: false
    });
  });

  test("normalizes numeric Polymarket order price tick size when tickSize is absent", () => {
    const markets = findStrategyMarkets({
      markets: [
        {
          eventSlug: "fifwc-fra-irq-2026-06-22",
          slug: "fifwc-fra-irq-2026-06-22-fra",
          question: "Will France win on 2026-06-22?",
          conditionId: "cond-france",
          clobTokenIds: "[\"yes\",\"no\"]",
          outcomes: "[\"Yes\",\"No\"]",
          sportsMarketType: "moneyline",
          orderPriceMinTickSize: 0.01
        }
      ]
    }, "fifwc-fra-irq-2026-06-22");

    expect(markets[0]?.tickSize).toBe("0.01");
  });

  test("falls back to Gamma event markets when the sports page has no strategy markets", async () => {
    const emptyState = deflateSync(JSON.stringify({ markets: [] })).toString("base64");
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialState: emptyState } } })}</script></html>`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(html, { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({
      slug: "fifwc-fra-irq-2026-06-22",
      markets: [
        {
          slug: "fifwc-fra-irq-2026-06-22-fra",
          question: "Will France win on 2026-06-22?",
          conditionId: "cond-france",
          clobTokenIds: "[\"yes\",\"no\"]",
          outcomes: "[\"Yes\",\"No\"]",
          sportsMarketType: "moneyline",
          orderPriceMinTickSize: 0.01,
          negRisk: true
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const markets = await fetchEventStrategyMarkets("fifwc-fra-irq-2026-06-22");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markets).toEqual([
      expect.objectContaining({
        eventSlug: "fifwc-fra-irq-2026-06-22",
        marketSlug: "fifwc-fra-irq-2026-06-22-fra",
        marketType: "moneyline",
        clobTokenIds: ["yes", "no"],
        tickSize: "0.01",
        negRisk: true
      })
    ]);
  });

  test("parses spread line from question text", () => {
    expect(parseSpreadLine("Spread: Japan (-3.5)")).toBe(-3.5);
    expect(parseSpreadLine("Spread: Saudi Arabia (+3.5)")).toBe(3.5);
  });

  test("normalizes latest strategy markets beyond spreads", () => {
    const state = {
      markets: [
        {
          eventSlug: "fifwc-strong-weak-2026-06-23",
          slug: "weak-moneyline",
          question: "Will Weak win on 2026-06-23?",
          conditionId: "cond-weak",
          clobTokenIds: "[\"weak-yes\",\"weak-no\"]",
          outcomes: "[\"Yes\",\"No\"]"
        },
        {
          eventSlug: "fifwc-strong-weak-2026-06-23",
          slug: "total-2pt5",
          question: "Strong vs. Weak: O/U 2.5",
          conditionId: "cond-total",
          clobTokenIds: "[\"over\",\"under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        },
        {
          eventSlug: "fifwc-strong-weak-2026-06-23",
          slug: "weak-team-total-1pt5",
          question: "Strong vs. Weak: Weak O/U 1.5",
          conditionId: "cond-team-total",
          clobTokenIds: "[\"team-over\",\"team-under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        },
        {
          eventSlug: "fifwc-strong-weak-2026-06-23",
          slug: "btts",
          question: "Strong vs. Weak: Both Teams to Score",
          conditionId: "cond-btts",
          clobTokenIds: "[\"btts-yes\",\"btts-no\"]",
          outcomes: "[\"Yes\",\"No\"]"
        }
      ]
    };

    const markets = findStrategyMarkets(state, "fifwc-strong-weak-2026-06-23");

    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "weak-moneyline", marketType: "moneyline" }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "total-2pt5", marketType: "total", line: 2.5 }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "weak-team-total-1pt5", marketType: "team_total", team: "Weak", line: 1.5 }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "btts", marketType: "btts" }));
  });

  test("classifies draw questions as draw even when the raw sports type is moneyline", () => {
    const markets = findStrategyMarkets({
      markets: [
        {
          eventSlug: "fifwc-eng-gha-2026-06-23",
          slug: "fifwc-eng-gha-2026-06-23-draw",
          question: "Will England vs. Ghana end in a draw?",
          conditionId: "cond-draw",
          clobTokenIds: "[\"draw-yes\",\"draw-no\"]",
          outcomes: "[\"Yes\",\"No\"]",
          sportsMarketType: "moneyline"
        }
      ]
    }, "fifwc-eng-gha-2026-06-23");

    expect(markets).toEqual([
      expect.objectContaining({
        marketSlug: "fifwc-eng-gha-2026-06-23-draw",
        marketType: "draw"
      })
    ]);
  });

  test("does not treat corners/cards prop markets as goal-total strategy markets", () => {
    const markets = findStrategyMarkets({
      markets: [
        {
          eventSlug: "fifwc-eng-gha-2026-06-23",
          slug: "fifwc-eng-gha-2026-06-23-corners-total-6pt5",
          question: "England vs. Ghana: O/U 6.5 Total Corners",
          conditionId: "cond-corners",
          clobTokenIds: "[\"over\",\"under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        },
        {
          eventSlug: "fifwc-eng-gha-2026-06-23",
          slug: "fifwc-eng-gha-2026-06-23-cards-total-3pt5",
          question: "England vs. Ghana: O/U 3.5 Total Cards",
          conditionId: "cond-cards",
          clobTokenIds: "[\"cards-over\",\"cards-under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        }
      ]
    }, "fifwc-eng-gha-2026-06-23");

    expect(markets).toEqual([]);
  });

  test("does not treat first-half period markets as full-match strategy markets", () => {
    const markets = findStrategyMarkets({
      markets: [
        {
          eventSlug: "fifwc-eng-gha-2026-06-23",
          slug: "fifwc-eng-gha-2026-06-23-first-half-team-total-home-1pt5",
          question: "England vs. Ghana: England 1st Half O/U 1.5",
          conditionId: "cond-first-half",
          clobTokenIds: "[\"over\",\"under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        }
      ]
    }, "fifwc-eng-gha-2026-06-23");

    expect(markets).toEqual([]);
  });

  test("extracts live match state but does not derive tail remaining time from page fields", () => {
    const state = {
      games: {
        "fifwc-fra-irq-2026-06-22": {
          event: "fifwc-fra-irq-2026-06-22",
          live: true,
          ended: false,
          score: "3-1",
          period: "2H",
          elapsed: "90+3'",
          stoppageTime: "5'"
        }
      },
      events: {
        "fifwc-fra-irq-2026-06-22": {
          slug: "fifwc-fra-irq-2026-06-22",
          title: "France vs. Iraq"
        }
      }
    };

    expect(findMatchState(state, "fifwc-fra-irq-2026-06-22")).toEqual({
      eventSlug: "fifwc-fra-irq-2026-06-22",
      homeTeam: "France",
      awayTeam: "Iraq",
      homeGoals: 3,
      awayGoals: 1,
      minute: 93,
      period: "2H",
      isLive: true
    });
  });

  test("parses stoppage-time elapsed values into absolute minutes", () => {
    const state = {
      games: {
        "fifwc-fra-irq-2026-06-22": {
          event: "fifwc-fra-irq-2026-06-22",
          live: true,
          score: "1-0",
          period: "2H",
          elapsed: "90+4'"
        }
      },
      events: {
        "fifwc-fra-irq-2026-06-22": {
          title: "France vs. Iraq"
        }
      }
    };

    expect(findMatchState(state, "fifwc-fra-irq-2026-06-22")?.minute).toBe(94);
  });

  test("parses absolute expected-end values like 90+5 instead of treating them as five minutes", () => {
    const state = {
      games: {
        "fifwc-fra-irq-2026-06-22": {
          event: "fifwc-fra-irq-2026-06-22",
          live: true,
          score: "3-1",
          period: "2H",
          elapsed: "90+3'",
          expectedEndMinute: "90+5'"
        }
      },
      events: {
        "fifwc-fra-irq-2026-06-22": {
          title: "France vs. Iraq"
        }
      }
    };

    const match = findMatchState(state, "fifwc-fra-irq-2026-06-22");
    expect(match).toMatchObject({ minute: 93 });
    expect(match).not.toHaveProperty("expectedEndMinute");
    expect(match).not.toHaveProperty("remainingMinutes");
  });
});
