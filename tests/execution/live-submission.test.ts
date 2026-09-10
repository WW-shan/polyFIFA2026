import { beforeEach, describe, expect, test, vi } from "vitest";
import { ClobClient } from "@polymarket/clob-client-v2";
import axios, { AxiosError } from "axios";
import { buyDecisionFromLegs } from "../../src/domain/decision.js";
import type { BuyTradeLeg } from "../../src/domain/types.js";
import {
  LiveExecutor, normalizeConfirmedLiveOrderResult, normalizeLiveOrderResult,
  type LiveOrderRequest
} from "../../src/execution/live-executor.js";
import * as poly1271 from "../../src/execution/poly1271-signature.js";

const config = {
  host: "https://unused.invalid", chainId: 137, signatureType: 1,
  privateKey: `0x${"a".repeat(64)}`, apiKey: "offline-key",
  apiSecret: "b2ZmbGluZS1zZWNyZXQ=", passphrase: "offline-passphrase"
};
const leg: BuyTradeLeg = {
  eventSlug: "event", marketSlug: "market", question: "O/U 0.5", tokenId: "1", conditionId: "condition",
  outcome: "Over", strategy: "total_over_locked", locked: true,
  price: 0.97, availableSize: 100, shares: 100, notional: 97,
  estimatedFee: 0.0873, estimatedNetReturn: 0.03
};
const order: LiveOrderRequest = {
  tokenId: "1", price: 0.97, size: 100, notional: 97,
  orderType: "FAK", tickSize: "0.001", negRisk: false, estimatedFee: 0.0873
};
const signed = {
  salt: "123", maker: `0x${"1".repeat(40)}`, signer: `0x${"1".repeat(40)}`, tokenId: "1",
  makerAmount: "97000000", takerAmount: "100000000", side: "BUY", signatureType: 1,
  timestamp: "1770000000000", metadata: `0x${"0".repeat(64)}`, builder: `0x${"0".repeat(64)}`, signature: "0x1234"
};
const versionedPrototype = ClobClient.prototype as unknown as { resolveVersion(forceUpdate?: boolean): Promise<number> };

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access in offline SDK test"));
});

function sdkStubs() {
  const version = vi.spyOn(versionedPrototype, "resolveVersion").mockResolvedValue(2);
  const create = vi.spyOn(ClobClient.prototype, "createMarketOrder").mockImplementation(async () => ({ ...signed }) as never);
  const post = vi.spyOn(ClobClient.prototype, "postOrder").mockResolvedValue({ success: true, orderID: "order-1", status: "matched" });
  vi.spyOn(ClobClient.prototype, "getOrder").mockResolvedValue(undefined as never);
  vi.spyOn(ClobClient.prototype, "getTrades").mockResolvedValue([]);
  vi.spyOn(ClobClient.prototype, "getOpenOrders").mockResolvedValue([]);
  return { version, create, post };
}

describe("submission acknowledgement and guards", () => {
  test.each([
    { error: "socket hang up" },
    { error: "ECONNRESET" },
    { error: "timeout of 1000ms exceeded", success: false },
    { error: "Network Error" },
    { error: "request aborted before acknowledgement" },
    { error: "unknown upstream failure", status: 502 },
    { error: "request timeout", status: 408 }
  ])("T1 SDK-shaped uncertain acknowledgement stays posted: %j", (postResponse) => {
    expect(normalizeLiveOrderResult(order, postResponse)).toMatchObject({ status: "posted", shares: 0, notional: 0 });
    expect(normalizeConfirmedLiveOrderResult(order, { postResponse })).toMatchObject({ status: "posted", shares: 0, notional: 0 });
  });

  test.each([
    { error: "not enough balance", status: 400 },
    { success: false, errorMsg: "order couldn't be fully filled" },
    { success: false, errorMsg: "invalid signature" }
  ])("T1 explicit business rejection remains definitive: %j", (response) => {
    expect(() => normalizeLiveOrderResult(order, response)).toThrow(expect.objectContaining({ code: "LIVE_ORDER_REJECTED" }));
  });

  test("T1 uses the real SDK HTTP error conversion for a response-less Axios reset", async () => {
    const { post } = await import(new URL("./http-helpers/index.js", import.meta.resolve("@polymarket/clob-client-v2")).href);
    const adapter = axios.defaults.adapter;
    axios.defaults.adapter = async (request) => { throw new AxiosError("socket hang up", "ECONNRESET", request); };
    try {
      const response: unknown = await post("https://unused.invalid/order", { data: { token: "1" } });
      expect(response).toEqual({ error: "socket hang up" });
      const executor = new LiveExecutor(config, async () => ({
        async placeLimitBuy(request) { return normalizeConfirmedLiveOrderResult(request, { postResponse: response }); }
      }));
      expect(await executor.execute(buyDecisionFromLegs([leg]))).toMatchObject({
        status: "posted", shares: 0, notional: 0, reservedNotional: 97
      });
    } finally {
      if (adapter === undefined) delete axios.defaults.adapter;
      else axios.defaults.adapter = adapter;
    }
  });

  test.each([false, true])("T5 custom clients do not submit after a callback veto (async=%s)", async (asyncVeto) => {
    const placeLimitBuy = vi.fn(async (request: LiveOrderRequest) => normalizeLiveOrderResult(request, { success: true, orderID: "order-1" }));
    const beforeSubmit = asyncVeto
      ? async () => { await Promise.resolve(); throw new Error("No Goal"); }
      : () => { throw new Error("No Goal"); };

    const result = await new LiveExecutor(config, async () => ({ placeLimitBuy })).execute(buyDecisionFromLegs([leg]), { beforeSubmit });

    expect(placeLimitBuy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "rejected", shares: 0, notional: 0, raw: { error: { reason: "BEFORE_SUBMIT_VETO" } } });
    expect(result.reservedNotional ?? 0).toBe(0);
  });

  test.each([1, 3])("T5 default SDK rechecks after construction/signing for signature type %s", async (signatureType) => {
    const { create, post } = sdkStubs();
    let negative = false;
    create.mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      negative = true;
      return { ...signed, signatureType } as never;
    });

    const result = await new LiveExecutor({ ...config, signatureType }).execute(buyDecisionFromLegs([leg]), {
      beforeSubmit() { if (negative) throw new Error("No Goal received while preparing the order"); }
    });

    expect(create).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "rejected", notional: 0, shares: 0 });
  });

  test("T5 the final POLY_1271 guard runs after asynchronous signing and balance preparation", async () => {
    const { post } = sdkStubs();
    const events: string[] = [];
    vi.spyOn(ClobClient.prototype, "updateBalanceAllowance").mockImplementation(async () => { events.push("balance"); });
    const sign = poly1271.signPoly1271Order;
    vi.spyOn(poly1271, "signPoly1271Order").mockImplementation(async (input) => {
      const signature = await sign(input);
      events.push("signed");
      return signature;
    });
    const result = await new LiveExecutor({ ...config, signatureType: 3, syncBalanceAllowance: true }).execute(buyDecisionFromLegs([leg]), {
      beforeSubmit() {
        events.push("guard");
        if (events.includes("signed")) throw new Error("No Goal arrived during signing");
      }
    });

    expect(events.slice(-3)).toEqual(["balance", "signed", "guard"]);
    expect(post).not.toHaveBeenCalled();
    expect(result.status).toBe("rejected");
  });

  test("T5 rechecks a veto before retrying an explicit SDK order-version mismatch", async () => {
    const { version, post } = sdkStubs();
    let currentVersion = 1;
    version.mockImplementation(async () => currentVersion);
    post.mockImplementation(async () => {
      currentVersion = 2;
      return { error: "order_version_mismatch", status: 400 };
    });

    const result = await new LiveExecutor(config).execute(buyDecisionFromLegs([leg]), {
      beforeSubmit() { if (currentVersion === 2) throw new Error("No Goal before the version retry"); }
    });

    expect(post).toHaveBeenCalledOnce();
    expect(result.status).toBe("rejected");
  });

  test("T5 preserves the SDK's single version rebuild when the guard still permits submission", async () => {
    const { version, create, post } = sdkStubs();
    let currentVersion = 1;
    version.mockImplementation(async () => currentVersion);
    post.mockImplementationOnce(async () => {
      currentVersion = 2;
      return { error: "order_version_mismatch", status: 400 };
    });
    const beforeSubmit = vi.fn();

    const result = await new LiveExecutor(config).execute(buyDecisionFromLegs([leg]), { beforeSubmit });

    expect(create).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(2);
    expect(beforeSubmit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("posted");
  });

  test("T1 does not rebuild an uncertain order just because another request updated the cached version", async () => {
    const { version, post } = sdkStubs();
    let currentVersion = 1;
    version.mockImplementation(async () => currentVersion);
    post.mockImplementation(async () => {
      currentVersion = 2;
      return { error: "socket hang up" };
    });

    const result = await new LiveExecutor(config).execute(buyDecisionFromLegs([leg]));

    expect(post).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "posted", reservedNotional: 97, shares: 0, notional: 0 });
  });

  test("T1 default SDK makes one HTTP attempt on a response-less reset and reserves its unknown exposure", async () => {
    const { post } = sdkStubs();
    post.mockRestore();
    const adapter = axios.defaults.adapter;
    let attempts = 0;
    axios.defaults.adapter = async (request) => {
      attempts += 1;
      throw new AxiosError("socket hang up", "ECONNRESET", request);
    };
    try {
      const result = await new LiveExecutor(config).execute(buyDecisionFromLegs([leg]));
      expect(attempts).toBe(1);
      expect(result).toMatchObject({ status: "posted", reservedNotional: 97, shares: 0, notional: 0 });
    } finally {
      if (adapter === undefined) delete axios.defaults.adapter;
      else axios.defaults.adapter = adapter;
    }
  });

  test.each([1, 3].flatMap(signatureType => ["", "/clob-api"].map(prefix => ({ signatureType, prefix }))))(
    "T5 vetoes after asynchronous L2 authentication before HTTP dispatch (type=$signatureType prefix=$prefix)", async ({ signatureType, prefix }) => {
    const { post } = sdkStubs();
    post.mockRestore();
    let negative = false;
    const sign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, "sign").mockImplementation(async (algorithm, key, data) => {
      const signature = await sign(algorithm, key, data);
      negative = true;
      return signature;
    });
    const previousAdapter = axios.defaults.adapter;
    const attempts: string[] = [];
    axios.defaults.adapter = async request => {
      attempts.push(request.url ?? "");
      return { data: { success: true, orderID: "order-1" }, status: 200, statusText: "OK", headers: {}, config: request };
    };
    try {
      const result = await new LiveExecutor({ ...config, host: config.host + prefix, signatureType }).execute(buyDecisionFromLegs([leg]), {
        beforeSubmit() { if (negative) throw new Error("No Goal during L2 authentication"); }
      });
      expect(negative).toBe(true);
      expect(attempts).toEqual([]);
      expect(result.status).toBe("rejected");
      expect(result.reservedNotional ?? 0).toBe(0);
    } finally {
      if (previousAdapter === undefined) delete axios.defaults.adapter;
      else axios.defaults.adapter = previousAdapter;
    }
  });
});
