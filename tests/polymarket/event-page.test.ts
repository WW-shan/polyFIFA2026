import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { decodeInitialStatePayload, extractNextInitialState, findSpreadMarkets, parseSpreadLine } from "../../src/polymarket/event-page.js";

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
});
