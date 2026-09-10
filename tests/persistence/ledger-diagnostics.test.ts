import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, test } from "vitest";
import { buyDecisionFromLegs } from "../../src/domain/decision.js";
import type { BuyTradeLeg } from "../../src/domain/types.js";
import { LiveExecutor } from "../../src/execution/live-executor.js";
import { LiveLedger, type LedgerTradeEntry } from "../../src/persistence/ledger.js";

const config = {
  host: "https://unused.invalid", chainId: 137, signatureType: 1,
  privateKey: "offline", apiKey: "offline", apiSecret: "offline", passphrase: "offline"
};
const legs: BuyTradeLeg[] = ["a", "b"].map((id) => ({
  eventSlug: "event", marketSlug: `market-${id}`, question: "O/U 0.5", tokenId: `token-${id}`,
  conditionId: `condition-${id}`, outcome: "Over", strategy: "total_over_locked",
  price: 0.97, availableSize: 100, shares: 100, notional: 97, estimatedFee: 0.0873, estimatedNetReturn: 0.03
}));
const entry: LedgerTradeEntry = {
  timestamp: "2026-09-11T00:00:00.000Z", mode: "live", status: "posted", eventSlug: "event", marketSlug: "market",
  tokenId: "token", conditionId: "condition", outcome: "Over", orderId: "order", price: 0.97, shares: 0, notional: 0
};

function circularRequest() {
  const request: Record<string, unknown> = { method: "POST", path: "/order" };
  request.socket = { _httpMessage: request };
  return request;
}

describe("persistable execution diagnostics", () => {
  test("T1 a circular transport error cannot discard a sibling's confirmed 97 pUSD fill", async () => {
    const error = Object.assign(new Error("socket hang up"), { code: "ECONNRESET", request: circularRequest() });
    const executor = new LiveExecutor(config, async () => ({
      async placeLimitBuy(order) {
        if (order.tokenId === "token-b") throw error;
        return {
          mode: "live", status: "filled", orderId: "order-a", tokenId: order.tokenId, price: order.price,
          shares: order.size, notional: order.notional, fee: order.estimatedFee,
          estimatedPayout: order.size, estimatedProfit: order.size - order.notional - order.estimatedFee
        };
      }
    }));
    const decision = buyDecisionFromLegs(legs);
    const result = await executor.execute(decision);
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-diagnostics-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);

    await ledger.recordResult(decision, result);

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(await ledger.hasActiveTrade("event", "token-a")).toBe(true);
    expect(await ledger.hasActiveTrade("event", "token-b")).toBe(true);
    const active = await ledger.readActiveEntries();
    expect(active).toEqual([
      expect.objectContaining({ tokenId: "token-a", status: "filled", notional: 97 }),
      expect.objectContaining({ tokenId: "token-b", status: "posted", notional: 0, reservedNotional: 97 })
    ]);
    expect(active.reduce((total, position) => total + (position.reservedNotional ?? 0), 0)).toBe(97);
    expect(result).toMatchObject({ notional: 97, reservedNotional: 97 });
    expect(JSON.parse(await readFile(file, "utf8"))[0].legs[1].raw.error).toMatchObject({
      name: "Error", message: "socket hang up", code: "ECONNRESET",
      request: { method: "POST", path: "/order", socket: { _httpMessage: "[Circular]" } }
    });
  });

  test("T1 ledger bounds Axios-like diagnostics without evaluating toJSON or dropping useful metadata", async () => {
    const request = circularRequest();
    const error = new AxiosError("socket hang up", "ECONNRESET", { headers: new AxiosHeaders() }, request);
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-diagnostics-"));
    const file = join(dir, "ledger.json");
    const ledger = new LiveLedger(file);
    let invokedToJSON = false;
    const raw = {
      error,
      nonce: 12345678901234567890n,
      body: "x".repeat(500_000),
      bytes: Buffer.alloc(500_000, 42),
      history: Array.from({ length: 10_000 }, (_, index) => ({ index, body: "y".repeat(1000) })),
      nested: { toJSON() { invokedToJSON = true; throw new Error("Do not execute diagnostic code"); } }
    };

    await ledger.recordTrade({ ...entry, raw });

    const contents = await readFile(file, "utf8");
    expect(contents.length).toBeLessThan(32_000);
    expect(invokedToJSON).toBe(false);
    expect(JSON.parse(contents)[0].raw).toMatchObject({
      nonce: "12345678901234567890",
      error: { name: "AxiosError", message: "socket hang up", code: "ECONNRESET", request: { method: "POST" } }
    });
    expect(await ledger.hasActiveTrade("event", "token")).toBe(true);
  });

  test("reserved notional survives ledger round trips independently of confirmed fills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-reserved-"));
    const ledger = new LiveLedger(join(dir, "ledger.json"));
    await ledger.recordResult(buyDecisionFromLegs([legs[0]!]), {
      mode: "live", status: "posted", orderId: "unknown", tokenId: "token-a", price: 0.97,
      shares: 0, notional: 0, fee: 0, estimatedPayout: 0, estimatedProfit: 0, reservedNotional: 97
    });

    expect(await ledger.readActiveEntries()).toEqual([
      expect.objectContaining({ shares: 0, notional: 0, reservedNotional: 97 })
    ]);
  });

  test("diagnostics redact Axios configuration and raw request authentication headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-ledger-redaction-"));
    const file = join(dir, "ledger.json");
    const error = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
      config: { auth: { password: "fixture-password" }, secret: "fixture-secret", headers: { POLY_API_KEY: "fixture-api-key" } },
      request: { method: "POST", path: "/order", _header: "Authorization: fixture-authorization\r\n" }
    });
    await new LiveLedger(file).recordTrade({ ...entry, raw: { error } });
    const contents = await readFile(file, "utf8");

    for (const secret of ["fixture-password", "fixture-secret", "fixture-api-key", "fixture-authorization"]) {
      expect(contents).not.toContain(secret);
    }
    expect(JSON.parse(contents)[0].raw.error).toMatchObject({ name: "Error", message: "socket hang up", code: "ECONNRESET" });
  });
});
