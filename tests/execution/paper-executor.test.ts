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

  test("fills every leg of a ranked BUY plan and aggregates the paper result", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.96,
      shares: 8.02,
      notional: 7.7494,
      estimatedFee: 0.00783846,
      estimatedNetReturn: 0.005,
      legs: [
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "total-2p5",
          question: "Strong vs. Weak: O/U 2.5",
          tokenId: "total-under",
          conditionId: "cond-total-2p5",
          outcome: "Under",
          strategy: "total_under_loss_ge2",
          lossRequiresGoals: 2,
          price: 0.96,
          availableSize: 3,
          shares: 3,
          notional: 2.88,
          estimatedFee: 0.003456,
          estimatedNetReturn: 0.04
        },
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "weak-moneyline",
          question: "Will Weak win?",
          tokenId: "weak-no",
          conditionId: "cond-weak",
          outcome: "No",
          strategy: "loser_no",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5.02,
          shares: 5.02,
          notional: 4.8694,
          estimatedFee: 0.004381,
          estimatedNetReturn: 0.03
        }
      ]
    } as BuyTradeDecision;

    const result = await new PaperExecutor().execute(decision);

    expect(result).toMatchObject({
      mode: "paper",
      status: "filled",
      shares: expect.closeTo(8.02, 8),
      notional: expect.closeTo(7.7494, 8),
      legs: [
        { tokenId: "total-under", price: 0.96, shares: 3, notional: 2.88 },
        { tokenId: "weak-no", price: 0.97, shares: 5.02, notional: expect.closeTo(4.8694, 8) }
      ]
    });
  });

  test("rejects NO_TRADE decisions", async () => {
    const noTrade: TradeDecision = { action: "NO_TRADE", reason: "PRICE_TOO_HIGH", eventSlug: buyDecision.eventSlug };

    await expect(new PaperExecutor().execute(noTrade)).rejects.toMatchObject({ code: "PAPER_NO_TRADE_DECISION" });
  });
});
