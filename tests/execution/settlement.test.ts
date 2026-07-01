import { describe, expect, test, vi } from "vitest";
import {
  AutoSettlementMonitor,
  POLYMARKET_CTF_COLLATERAL_ADAPTER,
  POLYMARKET_NEG_RISK_CTF_COLLATERAL_ADAPTER,
  POLYMARKET_CONDITIONAL_TOKENS_ADDRESS,
  ZERO_BYTES32,
  buildRedeemSettlementCalls,
  normalizeRedeemablePositions,
  settleRedeemablePositions,
  type SettlementResult
} from "../../src/execution/settlement.js";

const ownerAddress = "0x00000000000000000000000000000000000000aa";
const walletAddress = "0x00000000000000000000000000000000000000bb";
const conditionA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const conditionB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("auto settlement", () => {
  test("normalizes only redeemable current positions and keeps negative risk metadata", () => {
    const positions = normalizeRedeemablePositions([
      { conditionId: conditionA, size: "5.25", redeemable: true, negativeRisk: false, slug: "regular", eventSlug: "event-a" },
      { conditionId: conditionA, size: 5.25, redeemable: true, negativeRisk: false, slug: "regular-dupe" },
      { conditionId: conditionB, size: 2, redeemable: true, negativeRisk: true, slug: "neg-risk" },
      { conditionId: conditionA, size: 10, redeemable: true, currentValue: 0, curPrice: 0, slug: "worthless-loser" },
      { conditionId: conditionB, size: 0, redeemable: true, negativeRisk: true },
      { conditionId: conditionA, size: 10, redeemable: false, negativeRisk: false },
      { conditionId: "not-a-condition", size: 10, redeemable: true }
    ]);

    expect(positions).toEqual([
      { conditionId: conditionA, size: 5.25, negativeRisk: false, marketSlug: "regular", eventSlug: "event-a" },
      { conditionId: conditionA, size: 5.25, negativeRisk: false, marketSlug: "regular-dupe" },
      { conditionId: conditionB, size: 2, negativeRisk: true, marketSlug: "neg-risk" }
    ]);
  });

  test("builds one approval plus one redeem call per condition and routes neg-risk through its pUSD adapter", async () => {
    const calls = await buildRedeemSettlementCalls([
      { conditionId: conditionA, size: 5, negativeRisk: false },
      { conditionId: conditionA, size: 3, negativeRisk: false },
      { conditionId: conditionB, size: 2, negativeRisk: true }
    ], {
      walletAddress,
      isApprovedForAll: async (_owner, operator) => operator === POLYMARKET_CTF_COLLATERAL_ADAPTER
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ target: POLYMARKET_CTF_COLLATERAL_ADAPTER, value: "0" });
    expect(calls[0]?.data).toContain(conditionA.slice(2));
    expect(calls[0]?.data).toContain(ZERO_BYTES32.slice(2));
    expect(calls[1]).toMatchObject({ target: POLYMARKET_CONDITIONAL_TOKENS_ADDRESS, value: "0" });
    expect(calls[1]?.data).toContain(POLYMARKET_NEG_RISK_CTF_COLLATERAL_ADAPTER.slice(2).toLowerCase());
    expect(calls[2]).toMatchObject({ target: POLYMARKET_NEG_RISK_CTF_COLLATERAL_ADAPTER, value: "0" });
    expect(calls[2]?.data).toContain(conditionB.slice(2));
  });

  test("submits a redeem batch when claimable positions exist", async () => {
    const submitDepositWalletBatch = vi.fn(async () => ({ transactionID: "tx-1", state: "STATE_NEW" }));
    const markRedeemedConditionIds = vi.fn(async () => {});
    const result = await settleRedeemablePositions({
      enabled: true,
      walletAddress,
      ownerAddress,
      privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relayerUrl: "https://relayer-v2.polymarket.com",
      chainId: 137,
      rpcUrl: "http://rpc.example",
      intervalMs: 60_000,
      deadlineSeconds: 600,
      sizeThreshold: 0,
      relayerApiKey: "rk",
      relayerApiKeyAddress: ownerAddress
    }, {
      fetchRedeemablePositions: async () => [{ conditionId: conditionA, size: 5, negativeRisk: false }],
      isApprovedForAll: async () => true,
      submitDepositWalletBatch,
      markRedeemedConditionIds
    });

    expect(result).toMatchObject({ status: "submitted", positions: 1, conditions: 1, calls: 1 });
    expect(markRedeemedConditionIds).toHaveBeenCalledWith([conditionA]);
    expect(submitDepositWalletBatch).toHaveBeenCalledWith(expect.objectContaining({
      walletAddress,
      ownerAddress,
      calls: expect.arrayContaining([expect.objectContaining({ target: POLYMARKET_CTF_COLLATERAL_ADAPTER })]),
      relayerApiKey: "rk",
      relayerApiKeyAddress: ownerAddress
    }));
  });

  test("sends official relayer auth headers when submitting a redeem batch", async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>
      });
      if (String(url).includes("/nonce")) {
        return new Response(JSON.stringify({ nonce: "1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).includes("/submit")) {
        return new Response(JSON.stringify({ transactionID: "tx-auth", state: "STATE_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const result = await settleRedeemablePositions({
        enabled: true,
        walletAddress,
        ownerAddress,
        privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        relayerUrl: "https://relayer-v2.polymarket.com",
        chainId: 137,
        rpcUrl: "http://rpc.example",
        intervalMs: 60_000,
        deadlineSeconds: 600,
        sizeThreshold: 0,
        relayerApiKey: "rk",
        relayerApiKeyAddress: ownerAddress
      }, {
        fetchRedeemablePositions: async () => [{ conditionId: conditionA, size: 5, negativeRisk: false }],
        isApprovedForAll: async () => true
      });

      expect(result).toMatchObject({ status: "submitted", transactionID: "tx-auth" });
      const nonceRequest = requests.find((request) => request.url.includes("/nonce"));
      const submitRequest = requests.find((request) => request.url.includes("/submit"));
      expect(nonceRequest?.headers).toMatchObject({
        RELAYER_API_KEY: "rk",
        RELAYER_API_KEY_ADDRESS: ownerAddress
      });
      expect(submitRequest?.headers).toMatchObject({
        RELAYER_API_KEY: "rk",
        RELAYER_API_KEY_ADDRESS: ownerAddress
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("marks active ledger entries redeemed when a resolved winning token is already gone", async () => {
    const markRedeemedConditionIds = vi.fn(async () => {});
    const result = await settleRedeemablePositions({
      enabled: true,
      walletAddress,
      ownerAddress,
      privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relayerUrl: "https://relayer-v2.polymarket.com",
      chainId: 137,
      rpcUrl: "http://rpc.example",
      intervalMs: 60_000,
      deadlineSeconds: 600,
      sizeThreshold: 0
    }, {
      fetchRedeemablePositions: async () => [],
      readActiveLedgerEntries: async () => [{
        eventSlug: "event-a",
        marketSlug: "event-a-total-0pt5",
        tokenId: "token-over",
        conditionId: conditionA,
        outcome: "Over"
      }],
      fetchMarketSettlementStatus: async () => ({
        outcomes: ["Over", "Under"],
        outcomePrices: [1, 0],
        resolved: true
      }),
      readConditionalTokenBalance: async () => 0n,
      markRedeemedConditionIds
    });

    expect(result).toMatchObject({ status: "no_positions", positions: 0, conditions: 0, calls: 0 });
    expect(markRedeemedConditionIds).toHaveBeenCalledWith([conditionA]);
  });

  test("does not block the watch loop and suppresses overlapping settlement runs", async () => {
    let resolveRun!: (value: unknown) => void;
    const settle = vi.fn(() => new Promise<SettlementResult>((resolve) => {
      resolveRun = resolve as (value: unknown) => void;
    }));
    const monitor = new AutoSettlementMonitor({
      enabled: true,
      walletAddress,
      ownerAddress,
      privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relayerUrl: "https://relayer-v2.polymarket.com",
      chainId: 137,
      rpcUrl: "http://rpc.example",
      intervalMs: 1,
      deadlineSeconds: 600,
      sizeThreshold: 0
    }, { settle });

    monitor.kick(1_000);
    monitor.kick(2_000);
    expect(settle).toHaveBeenCalledTimes(1);

    resolveRun({ status: "no_positions", positions: 0, conditions: 0, calls: 0 });
    await monitor.waitForIdle();
    monitor.kick(3_000);
    expect(settle).toHaveBeenCalledTimes(2);
  });
});
