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

  test("keeps the venue minimum order size reported by /book", () => {
    const book = normalizeOrderbook({
      asset_id: "token-fee-market",
      bids: [],
      asks: [{ price: "0.97", size: "25" }],
      min_order_size: "5",
      tick_size: "0.01"
    });

    expect(book.minimumOrderSize).toBe(5);
    expect(book.tickSize).toBe("0.01");
  });

  test("accepts the 0.005 and 0.0025 increments the venue uses on world cup markets", () => {
    const half = normalizeOrderbook({ asset_id: "t1", bids: [], asks: [], tick_size: "0.005" });
    const quarter = normalizeOrderbook({ asset_id: "t2", bids: [], asks: [], tick_size: "0.0025" });

    expect(half.tickSize).toBe("0.005");
    expect(quarter.tickSize).toBe("0.0025");
  });
});
