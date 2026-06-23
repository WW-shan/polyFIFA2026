import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCandidateOrderbooks, runCli } from "../src/cli.js";
import type { MatchState, OrderbookSnapshot, StrategyMarket } from "../src/domain/types.js";

const liveMatch: MatchState = {
  eventSlug: "fifwc-strong-weak-2026-06-23",
  homeTeam: "Strong",
  awayTeam: "Weak",
  homeGoals: 1,
  awayGoals: 0,
  minute: 88,
  period: "2H",
  isLive: true,
  stoppageMinutes: 5,
  expectedEndMinute: 95,
  remainingMinutes: 2
};

const liveMarkets: StrategyMarket[] = [
  {
    eventSlug: liveMatch.eventSlug,
    marketSlug: "weak-moneyline",
    question: "Will Weak win on 2026-06-23?",
    conditionId: "cond-weak",
    outcomes: ["Yes", "No"],
    clobTokenIds: ["weak-yes", "weak-no"]
  },
  {
    eventSlug: liveMatch.eventSlug,
    marketSlug: "total-2p5",
    question: "Strong vs. Weak: O/U 2.5",
    conditionId: "cond-total",
    outcomes: ["Over", "Under"],
    clobTokenIds: ["total-over", "total-under"],
    line: 2.5
  }
];

describe("CLI", () => {
  test("paper mode prints a filled JSON trade result", async () => {
    const result = await runCli([
      "--mode", "paper",
      "--match-file", "tests/fixtures/matches/spain-4-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97"
    ]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY",
      marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-2pt5",
      outcome: "Spain",
      line: -2.5,
      strategy: "spread_tight_loss_ge2",
      lossRequiresGoals: 2,
      bestAsk: 0.97
    });
  });

  test("live mode without credentials returns LIVE_CREDENTIALS_MISSING", async () => {
    const result = await runCli([
      "--mode", "live",
      "--match-file", "tests/fixtures/matches/spain-4-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "5",
      "--order-type", "FOK"
    ], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("LIVE_CREDENTIALS_MISSING");
  });

  test("paper mode can fetch match state from an event slug", async () => {
    const result = await runCli([
      "--mode", "paper",
      "--event-slug", "fifwc-esp-ksa-2026-06-21",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97"
    ], {}, {
      fetchMatchState: async () => ({
        eventSlug: "fifwc-esp-ksa-2026-06-21",
        homeTeam: "Spain",
        awayTeam: "Saudi Arabia",
        homeGoals: 4,
        awayGoals: 0,
        minute: 88,
        period: "2H",
        isLive: true,
        stoppageMinutes: 5,
        expectedEndMinute: 95,
        remainingMinutes: 2
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY",
      eventSlug: "fifwc-esp-ksa-2026-06-21"
    });
  });

  test("status mode reports balance and ledger without requiring a match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-status-"));
    const ledgerFile = join(dir, "ledger.json");
    await writeFile(ledgerFile, JSON.stringify([
      {
        timestamp: "2026-06-23T10:00:00.000Z",
        mode: "live",
        status: "filled",
        eventSlug: "event-1",
        marketSlug: "market-1",
        tokenId: "token-1",
        conditionId: "condition-1",
        outcome: "Yes",
        orderId: "order-1",
        price: 0.97,
        shares: 1.1,
        notional: 1.067
      }
    ]));

    const result = await runCli([
      "--mode", "status",
      "--ledger-file", ledgerFile
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      readPusdBalance: async () => 1.234567
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "status",
      status: "ok",
      depositWalletAddress: "0x0000000000000000000000000000000000000001",
      pusdBalance: 1.234567,
      ledger: {
        file: ledgerFile,
        entries: 1,
        active: 1
      }
    });
  });

  test("skips a duplicate trade already recorded in the ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-ledger-"));
    const ledgerFile = join(dir, "ledger.json");
    await writeFile(ledgerFile, JSON.stringify([
      {
        timestamp: "2026-06-23T10:00:00.000Z",
        mode: "paper",
        status: "filled",
        eventSlug: "fifwc-esp-ksa-2026-06-21",
        marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-2pt5",
        tokenId: "token-spain-2p5",
        conditionId: "0xcondition-spain-2p5",
        outcome: "Spain",
        orderId: "order-1",
        price: 0.97,
        shares: 100,
        notional: 97
      }
    ]));

    const result = await runCli([
      "--mode", "paper",
      "--match-file", "tests/fixtures/matches/spain-4-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--ledger-file", ledgerFile
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "no_trade",
      reason: "DUPLICATE_TRADE"
    });
  });

  test("paper mode does not write to POLY_LEDGER_FILE unless --ledger-file is explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-env-ledger-"));
    const ledgerFile = join(dir, "live-ledger.json");

    const result = await runCli([
      "--mode", "paper",
      "--match-file", "tests/fixtures/matches/spain-4-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97"
    ], {
      POLY_LEDGER_FILE: ledgerFile
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(ledgerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("live mode skips trading when pUSD balance after buffer is below the CLOB minimum", async () => {
    const result = await runCli([
      "--mode", "live",
      "--match-file", "tests/fixtures/matches/spain-4-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--balance-buffer", "0.05"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      readPusdBalance: async () => 1.02
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "live",
      status: "no_trade",
      reason: "INSUFFICIENT_BALANCE"
    });
  });

  test("watch mode uses remaining time and trades when the refetched match enters the final window", async () => {
    let calls = 0;
    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--event-slug", liveMatch.eventSlug,
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--interval-ms", "0",
      "--max-iterations", "2",
      "--stake", "97"
    ], {}, {
      fetchMatchState: async () => {
        calls += 1;
        return {
          ...liveMatch,
          eventSlug: "fifwc-esp-ksa-2026-06-21",
          homeTeam: "Spain",
          awayTeam: "Saudi Arabia",
          homeGoals: 4,
          awayGoals: 0,
          minute: calls === 1 ? 91 : 93,
          expectedEndMinute: 95,
          remainingMinutes: calls === 1 ? 4 : 2
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY"
    });
  });

  test("worldcup watch discovers live event slugs before identifying a trade", async () => {
    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--interval-ms", "0",
      "--max-iterations", "1",
      "--stake", "97"
    ], {}, {
      fetchWorldCupEventSlugs: async () => ["fifwc-esp-ksa-2026-06-21"],
      fetchMatchState: async () => ({
        eventSlug: "fifwc-esp-ksa-2026-06-21",
        homeTeam: "Spain",
        awayTeam: "Saudi Arabia",
        homeGoals: 4,
        awayGoals: 0,
        minute: 93,
        period: "2H",
        isLive: true,
        stoppageMinutes: 5,
        expectedEndMinute: 95,
        remainingMinutes: 2
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY",
      eventSlug: "fifwc-esp-ksa-2026-06-21"
    });
  });

  test("fetchCandidateOrderbooks keeps usable books when one candidate fetch fails", async () => {
    const books = await fetchCandidateOrderbooks(liveMatch, liveMarkets, 3, async (tokenId): Promise<OrderbookSnapshot> => {
      if (tokenId === "weak-no") {
        throw new Error("No orderbook exists for the requested token id");
      }
      return {
        tokenId,
        bids: [],
        asks: [{ price: 0.97, size: 100 }]
      };
    });

    expect(books).toEqual([
      {
        tokenId: "total-under",
        bids: [],
        asks: [{ price: 0.97, size: 100 }]
      }
    ]);
  });
});
