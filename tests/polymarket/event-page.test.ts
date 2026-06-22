import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { decodeInitialStatePayload, extractNextInitialState, findSpreadMarkets, findStrategyMarkets, parseSpreadLine } from "../../src/polymarket/event-page.js";

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
});
