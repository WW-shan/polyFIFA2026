import { describe, expect, test, vi } from "vitest";
import { capStakeToAvailableBalance, DEFAULT_POLYGON_RPC_URL, readPusdBalance } from "../../src/execution/balance.js";

describe("live pUSD balance helpers", () => {
  test("uses a public Polygon RPC that does not require a private API key by default", () => {
    expect(DEFAULT_POLYGON_RPC_URL).toBe("https://polygon-bor-rpc.publicnode.com");
  });

  test("caps stake to balance after keeping a small buffer", () => {
    expect(capStakeToAvailableBalance(97, 1.825, { minimumNotional: 1, buffer: 0.05 })).toEqual({
      action: "USE_STAKE",
      stake: 1.775
    });
  });

  test("uses the full buffered balance when requested stake is omitted", () => {
    expect(capStakeToAvailableBalance(undefined, 2.34, { minimumNotional: 1, buffer: 0.05 })).toEqual({
      action: "USE_STAKE",
      stake: 2.29
    });
  });

  test("does not trade when buffered balance is below minimum notional", () => {
    expect(capStakeToAvailableBalance(97, 1.02, { minimumNotional: 1, buffer: 0.05 })).toMatchObject({
      action: "NO_TRADE",
      reason: "INSUFFICIENT_BALANCE"
    });
  });

  test("reads a six-decimal pUSD balance from an injected client", async () => {
    const readContract = vi.fn(async () => 1_234_567n);

    await expect(readPusdBalance("0x0000000000000000000000000000000000000001", undefined, { readContract })).resolves.toBe(1.234567);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "balanceOf",
      args: ["0x0000000000000000000000000000000000000001"]
    }));
  });
});
