import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createAutoSettlementMonitor, settlementConfigFromEnv } from "../../src/execution/auto-settlement.js";
import { liveConfigFromEnv } from "../../src/execution/live-executor.js";
import { LiveLedger } from "../../src/persistence/ledger.js";

const credentials = {
  POLY_PRIVATE_KEY: "0xabc",
  POLY_API_KEY: "key",
  POLY_API_SECRET: "secret",
  POLY_PASSPHRASE: "passphrase",
  POLY_FUNDER_ADDRESS: "0xfunder",
  POLY_SIGNATURE_TYPE: "1"
};

async function temporaryLedger() {
  const dir = await mkdtemp(join(tmpdir(), "tennis-auto-settle-"));
  return new LiveLedger(join(dir, "ledger.json"));
}

describe("settlementConfigFromEnv", () => {
  test("is disabled without a wallet or private key", () => {
    expect(settlementConfigFromEnv({}, liveConfigFromEnv({}))).toBeUndefined();
    expect(settlementConfigFromEnv(
      { POLY_PRIVATE_KEY: "0xabc" },
      liveConfigFromEnv({ POLY_PRIVATE_KEY: "0xabc" })
    )).toBeUndefined();
  });

  test("honours POLY_AUTO_REDEEM=false", () => {
    const env = { ...credentials, POLY_AUTO_REDEEM: "false" };
    expect(settlementConfigFromEnv(env, liveConfigFromEnv(env))).toBeUndefined();
  });

  test("maps tuning knobs and the proxy", () => {
    const env = {
      ...credentials,
      POLY_AUTO_REDEEM_INTERVAL_MS: "15000",
      POLY_AUTO_REDEEM_DEADLINE_SECONDS: "900",
      POLY_AUTO_REDEEM_SIZE_THRESHOLD: "0.01",
      HTTPS_PROXY: "http://127.0.0.1:10808"
    };
    expect(settlementConfigFromEnv(env, liveConfigFromEnv(env))).toMatchObject({
      enabled: true,
      walletAddress: "0xfunder",
      intervalMs: 15000,
      deadlineSeconds: 900,
      sizeThreshold: 0.01,
      proxyUrl: "http://127.0.0.1:10808"
    });
  });
});

describe("createAutoSettlementMonitor", () => {
  test("returns undefined when unconfigured", async () => {
    const ledger = await temporaryLedger();
    expect(createAutoSettlementMonitor({ env: {}, ledger })).toBeUndefined();
  });

  test("kicks a settlement pass that marks the ledger", async () => {
    const ledger = await temporaryLedger();
    await ledger.recordTrade({
      timestamp: new Date().toISOString(),
      mode: "live",
      status: "filled",
      eventSlug: "atp-swiatek-gauff-2026-10-03",
      marketSlug: "atp-swiatek-gauff-2026-10-03-moneyline",
      tokenId: "token-swiatek",
      conditionId: "cond-ml",
      outcome: "Iga Swiatek",
      orderId: "filled-1",
      price: 0.90,
      shares: 5,
      notional: 4.5
    });

    const monitor = createAutoSettlementMonitor({
      env: credentials,
      ledger,
      deps: {
        settle: async (_config, deps) => {
          await deps.markRedeemedConditionIds?.(["cond-ml"]);
          return { status: "confirmed", positions: 1, conditions: 1, calls: 1 };
        }
      }
    });
    expect(monitor).toBeDefined();

    monitor!.kick();
    await monitor!.waitForIdle();

    expect(monitor!.lastResult).toMatchObject({ status: "confirmed" });
    const entries = await ledger.readEntries();
    expect(entries.every((entry) => entry.status === "redeemed")).toBe(true);
  });
});
