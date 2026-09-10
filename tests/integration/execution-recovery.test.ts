import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { LiveExecutor } from "../../src/execution/live-executor.js";
import { LiveLedger } from "../../src/persistence/ledger.js";

describe("CLI execution recovery", () => {
  test("T1 persists successful and uncertain basket legs so a retry cannot submit either again", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access in offline execution test"));
    const dir = await mkdtemp(join(tmpdir(), "poly-execution-recovery-"));
    const ledgerPath = join(dir, "ledger.json");
    const submittedTokens: string[] = [];
    const executor = new LiveExecutor({
      host: "https://unused.invalid", chainId: 137, signatureType: 1,
      privateKey: "offline-key", apiKey: "offline-key", apiSecret: "offline-secret", passphrase: "offline-passphrase"
    }, async () => ({
      async placeLimitBuy(order) {
        submittedTokens.push(order.tokenId);
        if (order.tokenId === "token-spain-2p5") throw new Error("connection lost after submission");
        return {
          mode: "live", status: "filled", orderId: `order-${order.tokenId}`,
          tokenId: order.tokenId, price: order.price, shares: order.size,
          notional: order.notional, fee: order.estimatedFee, estimatedPayout: order.size,
          estimatedProfit: order.size - order.notional - order.estimatedFee
        };
      }
    }));
    const argv = [
      "--mode", "live", "--match-file", "tests/fixtures/matches/spain-5-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--stake", "9.7", "--use-live-balance", "false", "--ledger-file", ledgerPath
    ];
    const env = { NODE_ENV: "test", POLY_AUTO_REDEEM: "false", POLY_DEPTH_AUDIT_ENABLED: "false" };
    const deps = {
      fetchVerifiedClock: async () => null,
      fetchOrderbook: async (tokenId: string) => ({
        tokenId, bids: [], asks: tokenId === "token-spain-3p5" ? [] : [{ price: 0.97, size: 5 }]
      }),
      executeLive: executor.execute.bind(executor)
    };

    const first = await runCli(argv, env, deps);
    const ledger = new LiveLedger(ledgerPath);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(await ledger.hasActiveTrade("fifwc-esp-ksa-2026-06-21", "token-spain-1p5")).toBe(true);
    expect(await ledger.hasActiveTrade("fifwc-esp-ksa-2026-06-21", "token-spain-2p5")).toBe(true);
    expect(await ledger.readActiveEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ tokenId: "token-spain-1p5", status: "filled", notional: 4.85 }),
      expect.objectContaining({ tokenId: "token-spain-2p5", status: "posted", shares: 0, notional: 0 })
    ]));

    const retry = await runCli(argv, env, deps);
    expect(retry.exitCode, retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({ reason: "DUPLICATE_TRADE" });
    expect(submittedTokens.sort()).toEqual(["token-spain-1p5", "token-spain-2p5"]);
  });
});
