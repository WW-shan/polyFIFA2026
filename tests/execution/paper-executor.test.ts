import { describe, expect, test } from "vitest";
import { PaperExecutor } from "../../src/execution/paper-executor.js";
import type { BuyTradeDecision, TradeDecision } from "../../src/domain/types.js";

const buyDecision: BuyTradeDecision = {
  action: "BUY",
  eventSlug: "fifwc-esp-ksa-2026-06-21",
  marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-3pt5",
  question: "Spread: Spain (-3.5)",
  tokenId: "token-spain-3p5",
  conditionId: "cond-spain-3p5",
  outcome: "Spain",
  line: -3.5,
  bestAsk: 0.97,
  availableSize: 200,
  shares: 100,
  notional: 97,
  estimatedFee: 0.0873,
  estimatedNetReturn: 0.03003,
  tickSize: "0.001",
  negRisk: false
};

describe("PaperExecutor", () => {
  test("fills a BUY decision deterministically", async () => {
    const result = await new PaperExecutor().execute(buyDecision);

    expect(result).toMatchObject({
      mode: "paper",
      status: "filled",
      tokenId: "token-spain-3p5",
      price: 0.97,
      shares: 100,
      notional: 97,
      fee: 0.0873,
      estimatedPayout: 100
    });
    expect(result.orderId).toContain("paper-cond-spain-3p5-token-spain-3p5");
    expect(result.estimatedProfit).toBeCloseTo(2.9127, 4);
  });

  test("rejects NO_TRADE decisions", async () => {
    const noTrade: TradeDecision = { action: "NO_TRADE", reason: "PRICE_TOO_HIGH", eventSlug: buyDecision.eventSlug };

    await expect(new PaperExecutor().execute(noTrade)).rejects.toMatchObject({ code: "PAPER_NO_TRADE_DECISION" });
  });
});
