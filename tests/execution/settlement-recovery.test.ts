import { describe, expect, test, vi } from "vitest";
import {
  AutoSettlementMonitor,
  reconcileAlreadyRedeemedLedgerEntries,
  settleRedeemablePositions,
  type SettlementConfig
} from "../../src/execution/settlement.js";

const conditionId = `0x${"a".repeat(64)}`;
const config: SettlementConfig = {
  enabled: true, walletAddress: "0x00000000000000000000000000000000000000bb",
  relayerUrl: "https://unused.invalid", rpcUrl: "https://unused.invalid",
  chainId: 137, intervalMs: 60_000, deadlineSeconds: 600, sizeThreshold: 0
};

function dependencies(response: unknown) {
  return {
    fetchRedeemablePositions: async () => [{ conditionId, size: 5, negativeRisk: false }],
    isApprovedForAll: async () => true,
    submitDepositWalletBatch: async () => response,
    markRedeemedConditionIds: vi.fn(async (_ids: readonly string[]) => {})
  };
}

describe("settlement recovery", () => {
  test.each(["STATE_NEW", "STATE_EXECUTED", "STATE_MINED", "UNKNOWN", undefined])(
    "O2 keeps redemption pending until final confirmation: %s", async (state) => {
      const deps = dependencies({ transactionID: "tx-pending", transactionHash: "0xunconfirmed", state });

      expect(await settleRedeemablePositions(config, deps)).toMatchObject({ status: "submitted", transactionID: "tx-pending" });
      expect(deps.markRedeemedConditionIds).not.toHaveBeenCalled();
    }
  );

  test("O2 marks conditions redeemed only after an explicitly confirmed response", async () => {
    const deps = dependencies({ transactionID: "tx-confirmed", state: "STATE_CONFIRMED" });

    expect(await settleRedeemablePositions(config, deps)).toMatchObject({ status: "confirmed", transactionID: "tx-confirmed" });
    expect(deps.markRedeemedConditionIds).toHaveBeenCalledWith([conditionId]);
  });

  test.each([
    { transactionID: "tx-failed", state: "STATE_FAILED" },
    { transactionID: "tx-invalid", state: "STATE_INVALID" },
    { state: "STATE_CONFIRMED", success: false, error: "execution reverted" }
  ])("O2 surfaces explicit relayer failure without clearing the ledger: %j", async (response) => {
    const deps = dependencies(response);

    await expect(settleRedeemablePositions(config, deps)).rejects.toThrow("POLY_REDEEM_FAILED");
    expect(deps.markRedeemedConditionIds).not.toHaveBeenCalled();
  });

  test("O2 reports a failed submission through the background monitor error hook", async () => {
    const deps = dependencies({ transactionID: "tx-failed", state: "STATE_FAILED" });
    const onError = vi.fn();
    const monitor = new AutoSettlementMonitor(config, { ...deps, onError });
    monitor.kick();
    await monitor.waitForIdle();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("POLY_REDEEM_FAILED") }));
    expect(monitor.lastResult).toBeUndefined();
    expect(deps.markRedeemedConditionIds).not.toHaveBeenCalled();
  });

  test("T1/O2 a zero token balance does not reconcile an uncertain posted order as redeemed", async () => {
    const markRedeemedConditionIds = vi.fn(async () => {});
    const readConditionalTokenBalance = vi.fn(async () => 0n);
    const result = await reconcileAlreadyRedeemedLedgerEntries(config, {
      readActiveLedgerEntries: async () => [{
        eventSlug: "event", marketSlug: "market", tokenId: "token", conditionId, outcome: "Over",
        status: "posted", shares: 0
      }],
      fetchMarketSettlementStatus: async () => ({ outcomes: ["Over", "Under"], outcomePrices: [1, 0], resolved: true }),
      readConditionalTokenBalance,
      markRedeemedConditionIds
    });

    expect(result.redeemedConditions).toEqual([]);
    expect(markRedeemedConditionIds).not.toHaveBeenCalled();
    expect(readConditionalTokenBalance).not.toHaveBeenCalled();
  });

  test("O1 reconciling a losing token cannot mark a still-held winner under the same condition lost", async () => {
    const markRedeemedConditionIds = vi.fn(async () => {});
    const markLostConditionIds = vi.fn(async () => {});
    const result = await reconcileAlreadyRedeemedLedgerEntries(config, {
      readActiveLedgerEntries: async () => [
        { eventSlug: "event", marketSlug: "market", tokenId: "winner", conditionId, outcome: "Over" },
        { eventSlug: "event", marketSlug: "market", tokenId: "loser", conditionId, outcome: "Under" }
      ],
      fetchMarketSettlementStatus: async () => ({ outcomes: ["Over", "Under"], outcomePrices: [1, 0], resolved: true }),
      readConditionalTokenBalance: async () => 10n,
      markRedeemedConditionIds,
      markLostConditionIds
    });

    expect(result).toMatchObject({ redeemedConditions: [], lostConditions: [] });
    expect(markRedeemedConditionIds).not.toHaveBeenCalled();
    expect(markLostConditionIds).not.toHaveBeenCalled();
  });
});
