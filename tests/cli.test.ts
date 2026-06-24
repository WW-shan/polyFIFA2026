import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCandidateOrderbooks, runCli } from "../src/cli.js";
import type { MatchState, OrderbookSnapshot, StrategyMarket } from "../src/domain/types.js";

const sportsLiveMock = vi.hoisted(() => {
  type Listener = (event?: unknown) => void;
  type ProviderOptions = {
    events: readonly { eventSlug: string }[];
    auditFile?: string;
    proxyUrl?: string;
    onError?: (error: unknown) => void;
  };
  type UpdateHandler = (update: MatchState) => Promise<void> | void;

  class FakeSocket {
    readonly listeners = new Map<string, Listener[]>();
    closed = false;
    closeCalls = 0;

    addEventListener(type: string, listener: Listener): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type: string, event?: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    close(): void {
      this.closed = true;
      this.closeCalls += 1;
    }
  }

  class FakeSportsLiveProvider {
    handler?: UpdateHandler;
    socket?: FakeSocket;

    constructor(readonly options: ProviderOptions) {
      instances.push(this);
    }

    connect(handler: UpdateHandler): FakeSocket {
      this.handler = handler;
      this.socket = new FakeSocket();
      return this.socket;
    }

    async emitUpdate(update: MatchState): Promise<void> {
      await this.handler?.(update);
    }
  }

  const instances: FakeSportsLiveProvider[] = [];

  return {
    FakeSportsLiveProvider,
    instances,
    reset: () => {
      instances.length = 0;
    }
  };
});

const eventPageMock = vi.hoisted(() => ({
  fetchEventMatchState: vi.fn(async () => {
    throw new Error("match page polling should not be used");
  }),
  fetchEventStrategyMarkets: vi.fn(async () => {
    throw new Error("market polling should not be used");
  })
}));

vi.mock("../src/polymarket/sports-live.js", () => ({
  SportsLiveProvider: sportsLiveMock.FakeSportsLiveProvider
}));

vi.mock("../src/polymarket/event-page.js", () => ({
  fetchEventMatchState: eventPageMock.fetchEventMatchState,
  fetchEventStrategyMarkets: eventPageMock.fetchEventStrategyMarkets
}));

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

afterEach(() => {
  sportsLiveMock.reset();
  eventPageMock.fetchEventMatchState.mockClear();
  eventPageMock.fetchEventStrategyMarkets.mockClear();
});

function latestSportsProvider(): InstanceType<typeof sportsLiveMock.FakeSportsLiveProvider> {
  const provider = sportsLiveMock.instances.at(-1);
  expect(provider).toBeDefined();
  return provider!;
}

async function waitForDefaultSportsProvider(): Promise<InstanceType<typeof sportsLiveMock.FakeSportsLiveProvider>> {
  await vi.waitFor(() => {
    expect(sportsLiveMock.instances.length).toBeGreaterThan(0);
  });
  return latestSportsProvider();
}

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
      reason: "DUPLICATE_TRADE",
      details: "Ledger already has an active trade for this event"
    });
  });

  test("skips a duplicate event trade even when the existing token differs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-ledger-event-"));
    const ledgerFile = join(dir, "ledger.json");
    await writeFile(ledgerFile, JSON.stringify([
      {
        timestamp: "2026-06-23T10:00:00.000Z",
        mode: "paper",
        status: "filled",
        eventSlug: "fifwc-esp-ksa-2026-06-21",
        marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-1pt5",
        tokenId: "token-spain-1p5",
        conditionId: "cond-spain-1p5",
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
      reason: "DUPLICATE_TRADE",
      details: "Ledger already has an active trade for this event"
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

  test("live mode defaults to all available pUSD when --stake is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-all-in-"));
    const ledgerFile = join(dir, "ledger.json");
    const result = await runCli([
      "--mode", "live",
      "--match-file", "tests/fixtures/matches/spain-4-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--balance-buffer", "0.05"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001",
      POLY_LEDGER_FILE: ledgerFile
    }, {
      readPusdBalance: async () => 2.34,
      executeLive: async (decision) => ({
        mode: "live",
        status: "filled",
        orderId: "live-order-1",
        tokenId: decision.tokenId,
        price: decision.bestAsk,
        shares: decision.shares,
        notional: decision.notional,
        fee: decision.estimatedFee,
        estimatedPayout: decision.shares,
        estimatedProfit: decision.shares - decision.notional - decision.estimatedFee
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "live",
      status: "filled",
      notional: 2.29,
      trade: {
        notional: 2.29
      }
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
    async function* updates(): AsyncIterable<MatchState> {
      yield {
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
      };
    }

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
      watchSportsUpdates: async () => updates()
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY",
      eventSlug: "fifwc-esp-ksa-2026-06-21"
    });
  });

  test("worldcup watch can use sports live updates instead of polling pages", async () => {
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug: "fifwc-esp-ksa-2026-06-21",
        homeTeam: "Spain",
        awayTeam: "Saudi Arabia",
        homeGoals: 4,
        awayGoals: 0,
        minute: 90,
        period: "2H",
        isLive: true,
        elapsedSeconds: 90 * 60
      };
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventSlugs: async () => ["fifwc-esp-ksa-2026-06-21"],
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }],
      fetchMatchState: async () => {
        throw new Error("polling pages should not be used");
      },
      watchSportsUpdates: async () => updates()
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY",
      decision: {
        tailWindowSource: "conservative_90_plus"
      }
    });
  });

  test("worldcup live watch skips balance and market fetches before the tail window", async () => {
    const readPusdBalance = vi.fn(async () => {
      throw new Error("balance should not be read before the tail window");
    });
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug: "fifwc-early-tail-2026-06-21",
        homeTeam: "Early",
        awayTeam: "Tail",
        homeGoals: 2,
        awayGoals: 0,
        minute: 75,
        period: "2H",
        isLive: true,
        remainingMinutes: 18
      };
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-early-tail-2026-06-21", homeTeam: "Early", awayTeam: "Tail" }],
      watchSportsUpdates: async () => updates(),
      readPusdBalance
    });

    expect(result.exitCode).toBe(0);
    expect(readPusdBalance).not.toHaveBeenCalled();
    expect(eventPageMock.fetchEventStrategyMarkets).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "live",
      status: "watch_complete",
      iterations: 1,
      last: {
        mode: "live",
        status: "no_trade",
        reason: "MATCH_NOT_LATE_ENOUGH",
        eventSlug: "fifwc-early-tail-2026-06-21",
        details: expect.stringContaining("remainingMinutes=18")
      }
    });
  });

  test("worldcup watch completes without opening default sports provider when no events are discovered", async () => {
    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => []
    });

    const result = await Promise.race([
      resultPromise,
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50))
    ]);

    if (result === "timed_out") throw new Error("worldcup watch did not return when no events were discovered");
    expect(sportsLiveMock.instances).toHaveLength(0);
    expect(result).toMatchObject({
      exitCode: 0,
      stderr: ""
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 0,
      last: {
        status: "no_events",
        reason: "NO_WORLD_CUP_EVENTS"
      }
    });
  });

  test("worldcup watch reports default sports socket errors", async () => {
    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }]
    });

    const provider = await waitForDefaultSportsProvider();
    provider.socket?.emit("error", { error: new Error("sports socket unavailable") });

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sports socket unavailable");
    expect(provider.socket?.closed).toBe(true);
  });

  test("worldcup watch reports default sports clean remote socket close before completion", async () => {
    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }]
    });

    const provider = await waitForDefaultSportsProvider();
    provider.socket?.emit("close", { wasClean: true, code: 1000, reason: "normal close" });

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Sports live WebSocket closed unexpectedly");
    expect(provider.socket?.closed).toBe(true);
  });

  test("worldcup watch reports sports provider message handling errors", async () => {
    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }]
    });

    const provider = await waitForDefaultSportsProvider();
    if (!provider.options.onError) {
      provider.socket?.emit("close", { wasClean: true, code: 1000, reason: "normal close" });
      await resultPromise;
    }

    expect(provider.options.onError).toEqual(expect.any(Function));
    provider.options.onError?.(new Error("audit write failed"));

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("audit write failed");
    expect(provider.socket?.closed).toBe(true);
  });

  test("worldcup watch cleans up the default sports socket after a trade", async () => {
    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }]
    });

    const provider = await waitForDefaultSportsProvider();
    await provider.emitUpdate({
      eventSlug: "fifwc-esp-ksa-2026-06-21",
      homeTeam: "Spain",
      awayTeam: "Saudi Arabia",
      homeGoals: 4,
      awayGoals: 0,
      minute: 90,
      period: "2H",
      isLive: true,
      elapsedSeconds: 90 * 60
    });

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY"
    });
    expect(provider.socket?.closed).toBe(true);
  });

  test("worldcup watch cleans up the default sports socket after max iterations", async () => {
    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }]
    });

    const provider = await waitForDefaultSportsProvider();
    await provider.emitUpdate({
      eventSlug: "fifwc-esp-ksa-2026-06-21",
      homeTeam: "Spain",
      awayTeam: "Saudi Arabia",
      homeGoals: 4,
      awayGoals: 0,
      minute: 89,
      period: "2H",
      isLive: true,
      elapsedSeconds: 89 * 60
    });

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "no_trade"
      }
    });
    expect(provider.socket?.closed).toBe(true);
  });

  test("worldcup watch passes audit and proxy options to the default sports provider", async () => {
    const eventRef = { eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" };
    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--max-iterations", "1",
      "--live-audit-file", "cli-audit.json"
    ], {
      POLY_LIVE_AUDIT_FILE: "env-audit.json",
      HTTPS_PROXY: "https://proxy.example",
      HTTP_PROXY: "http://proxy.example",
      https_proxy: "https://lower-proxy.example",
      http_proxy: "http://lower-proxy.example"
    }, {
      fetchWorldCupEventRefs: async () => [eventRef]
    });

    const provider = await waitForDefaultSportsProvider();
    expect(provider.options).toMatchObject({
      events: [eventRef],
      auditFile: "cli-audit.json",
      proxyUrl: "https://proxy.example"
    });

    await provider.emitUpdate({
      eventSlug: "fifwc-esp-ksa-2026-06-21",
      homeTeam: "Spain",
      awayTeam: "Saudi Arabia",
      homeGoals: 4,
      awayGoals: 0,
      minute: 89,
      period: "2H",
      isLive: true,
      elapsedSeconds: 89 * 60
    });

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "no_trade"
      }
    });
    expect(provider.socket?.closed).toBe(true);
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
