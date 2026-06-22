import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { runPaperFlow } from "../../src/runner.js";
import type { MatchState, OrderbookSnapshot, SpreadMarket } from "../../src/domain/types.js";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("fixture paper flow", () => {
  test("identifies Spain -2.5 and fills a paper trade at 0.97", async () => {
    const match = await readJson<MatchState>("tests/fixtures/matches/spain-4-0.json");
    const markets = await readJson<SpreadMarket[]>("tests/fixtures/markets/spain-spreads.json");
    const orderbook = await readJson<OrderbookSnapshot>("tests/fixtures/orderbooks/spain-2p5-ask-097.json");

    const result = await runPaperFlow({ match, markets, orderbook, stake: 97 });

    expect(result.decision).toMatchObject({
      action: "BUY",
      outcome: "Spain",
      line: -2.5,
      strategy: "spread_tight_loss_ge2",
      lossRequiresGoals: 2,
      bestAsk: 0.97,
      estimatedNetReturn: expect.closeTo(0.03003, 5)
    });
    expect(result.trade).toMatchObject({
      mode: "paper",
      status: "filled",
      tokenId: "token-spain-2p5",
      price: 0.97,
      shares: 100
    });
  });
});
