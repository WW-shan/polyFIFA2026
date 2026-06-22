import { describe, expect, test } from "vitest";
import { normalizeOrderbook } from "../../src/polymarket/clob.js";

describe("normalizeOrderbook", () => {
  test("normalizes string prices/sizes and sorts asks ascending", () => {
    const book = normalizeOrderbook({
      market: "cond-spain-3p5",
      asset_id: "token-spain-3p5",
      timestamp: "1771514400",
      bids: [{ price: "0.96", size: "10" }],
      asks: [{ price: "0.981", size: "50" }, { price: "0.970", size: "25" }],
      tick_size: "0.001",
      neg_risk: false,
      hash: "fixture-hash"
    });

    expect(book).toMatchObject({
      tokenId: "token-spain-3p5",
      market: "cond-spain-3p5",
      tickSize: "0.001",
      negRisk: false,
      hash: "fixture-hash",
      timestamp: "1771514400"
    });
    expect(book.asks).toEqual([{ price: 0.97, size: 25 }, { price: 0.981, size: 50 }]);
    expect(book.bids).toEqual([{ price: 0.96, size: 10 }]);
  });
});
