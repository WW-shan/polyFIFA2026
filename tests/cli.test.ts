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

const clobMock = vi.hoisted(() => ({
  fetchOrderbook: vi.fn<(tokenId: string) => Promise<unknown>>(async () => {
    throw new Error("orderbook polling should not be used without a test stub");
  })
}));

vi.mock("../src/polymarket/sports-live.js", () => ({
  SportsLiveProvider: sportsLiveMock.FakeSportsLiveProvider
}));

vi.mock("../src/polymarket/event-page.js", () => ({
  fetchEventMatchState: eventPageMock.fetchEventMatchState,
  fetchEventStrategyMarkets: eventPageMock.fetchEventStrategyMarkets
}));

vi.mock("../src/polymarket/clob.js", () => ({
  fetchOrderbook: clobMock.fetchOrderbook
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
  remainingSeconds: 120,
  remainingSecondsSource: "365scores_added_time_precise_game_time"
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
  clobMock.fetchOrderbook.mockReset();
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

function tailMatch(eventSlug: string, homeTeam: string, awayTeam: string, homeGoals: number, awayGoals: number): MatchState {
  return {
    eventSlug,
    homeTeam,
    awayTeam,
    homeGoals,
    awayGoals,
    minute: 90,
    period: "2H",
    isLive: true,
    remainingSeconds: 120,
    remainingSecondsSource: "365scores_added_time_precise_game_time"
  };
}

function totalMarket(eventSlug: string, homeTeam: string, awayTeam: string, line: number, underTokenId: string): StrategyMarket {
  const lineSlug = String(line).replace(".", "pt");
  return {
    eventSlug,
    marketSlug: `${eventSlug}-total-${lineSlug}`,
    question: `${homeTeam} vs. ${awayTeam}: O/U ${line}`,
    conditionId: `cond-${eventSlug}-total-${lineSlug}`,
    outcomes: ["Over", "Under"],
    clobTokenIds: [`${underTokenId}-over`, underTokenId],
    line,
    marketType: "total"
  };
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
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
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

  test("single event mode overlays verified 365Scores time before checking the tail window", async () => {
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
        minute: 90,
        period: "2H",
        isLive: true,
        startTime: "2026-06-21T19:00:00Z"
      }),
      fetchVerifiedClock: async (match) => ({
        remainingSeconds: match.startTime ? 120 : 999,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY",
      decision: {
        tailWindowSource: "remaining_seconds"
      }
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

  test("live mode defaults to FAK orders so stale depth does not kill the whole entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-default-fak-"));
    const eventSlug = "fifwc-default-fak-2026-06-27";
    const matchFile = join(dir, "match.json");
    const marketsFile = join(dir, "markets.json");
    const orderbookFile = join(dir, "orderbook.json");
    const ledgerFile = join(dir, "ledger.json");
    await writeFile(matchFile, JSON.stringify(tailMatch(eventSlug, "Default", "FAK", 2, 0)));
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Default", "FAK", 4.5, "default-fak-under")
    ]));
    await writeFile(orderbookFile, JSON.stringify({
      tokenId: "default-fak-under",
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    let capturedOrderType: unknown;
    const result = await runCli([
      "--mode", "live",
      "--match-file", matchFile,
      "--markets-file", marketsFile,
      "--orderbook-file", orderbookFile,
      "--stake", "5",
      "--use-live-balance", "false",
      "--ledger-file", ledgerFile
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      executeLive: async (decision, options) => {
        capturedOrderType = options.orderType;
        return {
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
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(capturedOrderType).toBe("FAK");
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
          remainingSeconds: calls === 1 ? 240 : 120,
          remainingSecondsSource: "365scores_added_time_precise_game_time"
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
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
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
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        action: "BUY",
        eventSlug: "fifwc-esp-ksa-2026-06-21"
      }
    });
  });

  test("worldcup watch overlays verified 365Scores time before trading", async () => {
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
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => ({
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        action: "BUY",
        decision: {
          tailWindowSource: "remaining_seconds",
          tailWindowDetails: expect.stringContaining("365scores_added_time_precise_game_time")
        }
      }
    });
  });

  test("worldcup watch keeps polling 365Scores after the sports feed stops at 90 minutes", async () => {
    let clockCalls = 0;
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
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => {
        clockCalls += 1;
        return clockCalls <= 2 ? null : {
          remainingSeconds: 120,
          remainingSecondsSource: "365scores_added_time_precise_game_time"
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(clockCalls).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      last: {
        status: "filled",
        action: "BUY",
        decision: {
          tailWindowSource: "remaining_seconds"
        }
      }
    });
  });

  test("worldcup watch does not let a slow interval delay verified 365Scores clock polling near the entry window", async () => {
    let clockCalls = 0;
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
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--interval-ms", "5000",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => {
        clockCalls += 1;
        return clockCalls <= 2 ? null : {
          remainingSeconds: 120,
          remainingSecondsSource: "365scores_added_time_precise_game_time"
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(clockCalls).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      last: {
        status: "filled",
        action: "BUY",
        decision: {
          tailWindowSource: "remaining_seconds"
        }
      }
    });
  });

  test("worldcup watch keeps running after filling one match and can fill a later simultaneous match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-two-live-matches-"));
    const marketsFile = join(dir, "markets.json");
    const firstSlug = "fifwc-first-simultaneous-2026-06-27";
    const secondSlug = "fifwc-second-simultaneous-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(firstSlug, "First", "Match", 5.5, "first-under"),
      totalMarket(secondSlug, "Second", "Match", 5.5, "second-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(firstSlug, "First", "Match", 2, 2);
      yield tailMatch(secondSlug, "Second", "Match", 2, 2);
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "10",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [
        { eventSlug: firstSlug, homeTeam: "First", awayTeam: "Match" },
        { eventSlug: secondSlug, homeTeam: "Second", awayTeam: "Match" }
      ],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        eventSlug: secondSlug
      }
    });
    expect(clobMock.fetchOrderbook).toHaveBeenCalledWith("first-under");
    expect(clobMock.fetchOrderbook).toHaveBeenCalledWith("second-under");
  });

  test("worldcup watch polls verified 365Scores clocks concurrently for simultaneous active matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-concurrent-clock-poll-"));
    const marketsFile = join(dir, "markets.json");
    const firstSlug = "fifwc-clock-first-2026-06-27";
    const secondSlug = "fifwc-clock-second-2026-06-27";
    const clockResolvers = new Map<string, (patch: Partial<MatchState> | null) => void>();
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(firstSlug, "Clock", "First", 5.5, "clock-first-under"),
      totalMarket(secondSlug, "Clock", "Second", 5.5, "clock-second-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "10",
      "--interval-ms", "0",
      "--max-iterations", "4"
    ], {}, {
      fetchWorldCupEventRefs: async () => [
        { eventSlug: firstSlug, homeTeam: "Clock", awayTeam: "First", startTime: new Date(Date.now() - 95 * 60_000).toISOString() },
        { eventSlug: secondSlug, homeTeam: "Clock", awayTeam: "Second", startTime: new Date(Date.now() - 95 * 60_000).toISOString() }
      ],
      fetchMatchState: async (eventSlug) => ({
        eventSlug,
        homeTeam: "Clock",
        awayTeam: eventSlug === firstSlug ? "First" : "Second",
        homeGoals: 2,
        awayGoals: 2,
        minute: 90,
        period: "2H",
        isLive: true,
        elapsedSeconds: 90 * 60
      }),
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => {
        return new Promise<Partial<MatchState> | null>((resolve) => {
          clockResolvers.set(match.eventSlug, resolve);
        });
      }
    });

    await vi.waitFor(() => {
      expect(clockResolvers.size).toBe(2);
    });
    for (const resolve of clockResolvers.values()) {
      resolve({
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
      });
    }
    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        eventSlug: secondSlug
      }
    });
  });

  test("worldcup watch seeds late active matches after restart before the sports feed updates again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-restart-late-seed-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-sen-irq-2026-06-26";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Senegal", "Iraq", 6.5, "senegal-iraq-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "97",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{
        eventSlug,
        homeTeam: "Senegal",
        awayTeam: "Iraq",
        startTime: new Date(Date.now() - 95 * 60_000).toISOString()
      }],
      fetchMatchState: async () => ({
        eventSlug,
        homeTeam: "Senegal",
        awayTeam: "Iraq",
        homeGoals: 5,
        awayGoals: 0,
        minute: 90,
        period: "2H",
        isLive: true,
        elapsedSeconds: 90 * 60
      }),
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => ({
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        eventSlug,
        action: "BUY",
        tailWindowSource: "remaining_seconds"
      }
    });
  });

  test("worldcup watch instantly buys candidates at the default 0.5% minimum return", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-default-instant-threshold-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-default-threshold-2026-06-26";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Default", "Threshold", 5.5, "default-threshold-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.9948, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Default", "Threshold", 2, 2);
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "97",
      "--max-iterations", "1",
      "--interval-ms", "0"
    ], {
      POLY_INSTANT_BUY_NET_RETURN: "0.01"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Default", awayTeam: "Threshold" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        eventSlug,
        bestAsk: 0.9948
      }
    });
  });

  test("worldcup live watch keeps running after one event execution error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-live-exec-error-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const firstSlug = "fifwc-live-error-first-2026-06-27";
    const secondSlug = "fifwc-live-error-second-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(firstSlug, "Live", "Error", 5.5, "live-error-first-under"),
      totalMarket(secondSlug, "Live", "Next", 5.5, "live-error-second-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(firstSlug, "Live", "Error", 2, 2);
      yield tailMatch(secondSlug, "Live", "Next", 2, 2);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "10",
      "--ledger-file", ledgerFile,
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [
        { eventSlug: firstSlug, homeTeam: "Live", awayTeam: "Error" },
        { eventSlug: secondSlug, homeTeam: "Live", awayTeam: "Next" }
      ],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      executeLive: async (decision) => {
        if (decision.eventSlug === firstSlug) throw new Error("temporary CLOB execution failed");
        return {
          mode: "live",
          status: "filled",
          orderId: "live-second",
          tokenId: decision.tokenId,
          price: decision.bestAsk,
          shares: decision.shares,
          notional: decision.notional,
          fee: decision.estimatedFee,
          estimatedPayout: decision.shares,
          estimatedProfit: decision.shares - decision.notional - decision.estimatedFee
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "live",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        eventSlug: secondSlug
      }
    });
  });

  test("worldcup live watch retries the same event after an all-rejected FAK basket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-live-rejected-retry-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-live-retry-after-rejected-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Retry", "Rejected", 5.5, "retry-rejected-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Retry", "Rejected", 2, 2);
      yield tailMatch(eventSlug, "Retry", "Rejected", 2, 2);
    }
    let calls = 0;

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "10",
      "--ledger-file", ledgerFile,
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [
        { eventSlug, homeTeam: "Retry", awayTeam: "Rejected" }
      ],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      executeLive: async (decision) => {
        calls += 1;
        if (calls === 1) {
          return {
            mode: "live",
            status: "rejected",
            orderId: "live-rejected-basket",
            tokenId: decision.tokenId,
            price: decision.bestAsk,
            shares: 0,
            notional: 0,
            fee: 0,
            estimatedPayout: 0,
            estimatedProfit: 0
          };
        }
        return {
          mode: "live",
          status: "filled",
          orderId: "live-retry-filled",
          tokenId: decision.tokenId,
          price: decision.bestAsk,
          shares: decision.shares,
          notional: decision.notional,
          fee: decision.estimatedFee,
          estimatedPayout: decision.shares,
          estimatedProfit: decision.shares - decision.notional - decision.estimatedFee
        };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "live",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        eventSlug
      }
    });
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    expect(ledger.map((entry: { status: string }) => entry.status)).toEqual(["rejected", "filled"]);
  });

  test("worldcup watch skips candidates below the default 0.5% minimum without waiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-default-min-return-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-default-min-return-2026-06-26";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Default", "Minimum", 5.5, "default-minimum-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.995, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Default", "Minimum", 2, 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "97",
      "--max-iterations", "1",
      "--interval-ms", "0"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Default", awayTeam: "Minimum" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "no_trade",
        reason: "RETURN_TOO_LOW",
        eventSlug
      }
    });
  });

  test("worldcup watch uses deferred comparison only when explicitly enabled for experiments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-instant-compare-"));
    const marketsFile = join(dir, "markets.json");
    const lowSlug = "fifwc-low-ret-2026-06-26";
    const highSlug = "fifwc-high-ret-2026-06-26";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(lowSlug, "Low", "Return", 5.5, "low-under"),
      totalMarket(highSlug, "High", "Return", 3.5, "high-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: tokenId === "low-under" ? 0.99 : 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(lowSlug, "Low", "Return", 2, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield tailMatch(highSlug, "High", "Return", 1, 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "97",
      "--minimum-net-return", "0",
      "--instant-buy-net-return", "0.01",
      "--candidate-compare-wait-ms", "60000",
      "--interval-ms", "5",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [
        { eventSlug: lowSlug, homeTeam: "Low", awayTeam: "Return" },
        { eventSlug: highSlug, homeTeam: "High", awayTeam: "Return" }
      ],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        eventSlug: highSlug,
        marketSlug: `${highSlug}-total-3pt5`,
        bestAsk: 0.98
      }
    });
  });

  test("worldcup watch executes deferred sub-threshold candidates after waiting while staying live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-deferred-compare-"));
    const marketsFile = join(dir, "markets.json");
    const lowerSlug = "fifwc-lower-deferred-2026-06-26";
    const betterSlug = "fifwc-better-deferred-2026-06-26";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(lowerSlug, "Lower", "Deferred", 5.5, "lower-under"),
      totalMarket(betterSlug, "Better", "Deferred", 5.5, "better-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: tokenId === "lower-under" ? 0.99 : 0.985, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(lowerSlug, "Lower", "Deferred", 2, 2);
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield tailMatch(betterSlug, "Better", "Deferred", 2, 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "97",
      "--minimum-net-return", "0",
      "--instant-buy-net-return", "0.02",
      "--candidate-compare-wait-ms", "20",
      "--interval-ms", "5",
      "--max-iterations", "10"
    ], {}, {
      fetchWorldCupEventRefs: async () => [
        { eventSlug: lowerSlug, homeTeam: "Lower", awayTeam: "Deferred" },
        { eventSlug: betterSlug, homeTeam: "Better", awayTeam: "Deferred" }
      ],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      last: {
        status: "filled",
        eventSlug: lowerSlug,
        marketSlug: `${lowerSlug}-total-5pt5`,
        bestAsk: 0.99
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
      fetchVerifiedClock: async () => null,
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
        details: expect.stringContaining("No verified remainingSeconds")
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

  test("worldcup watch keeps rediscovering when no events are initially available", async () => {
    let discoveryCalls = 0;
    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--interval-ms", "0"
    ], {}, {
      fetchWorldCupEventRefs: async () => {
        discoveryCalls += 1;
        if (discoveryCalls === 1) return [];
        throw new Error("REDISCOVERED_AFTER_NO_EVENTS");
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("REDISCOVERED_AFTER_NO_EVENTS");
    expect(discoveryCalls).toBe(2);
  });

  test("worldcup watch rediscovers events after a sports update stream finishes", async () => {
    let discoveryCalls = 0;
    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--interval-ms", "0"
    ], {}, {
      fetchWorldCupEventRefs: async () => {
        discoveryCalls += 1;
        if (discoveryCalls === 1) return [{ eventSlug: "fifwc-empty-stream-2026-06-27", homeTeam: "Empty", awayTeam: "Stream" }];
        throw new Error("REDISCOVERED_AFTER_STREAM_END");
      },
      watchSportsUpdates: async () => (async function* (): AsyncIterable<MatchState> {})()
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("REDISCOVERED_AFTER_STREAM_END");
    expect(discoveryCalls).toBe(2);
  });

  test("worldcup watch reconnects instead of exiting after a transient sports stream error", async () => {
    let discoveryCalls = 0;
    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--interval-ms", "0"
    ], {}, {
      fetchWorldCupEventRefs: async () => {
        discoveryCalls += 1;
        if (discoveryCalls === 1) return [{ eventSlug: "fifwc-reconnect-stream-2026-06-27", homeTeam: "Reconnect", awayTeam: "Stream" }];
        throw new Error("REDISCOVERED_AFTER_STREAM_ERROR");
      },
      watchSportsUpdates: async () => (async function* (): AsyncIterable<MatchState> {
        throw new Error("temporary sports stream down");
      })()
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("REDISCOVERED_AFTER_STREAM_ERROR");
    expect(discoveryCalls).toBe(2);
  });

  test("worldcup live watch starts auto redeem settlement in the background", async () => {
    const settleRedeemablePositions = vi.fn(() => new Promise<never>(() => {}));
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug: "fifwc-auto-settle-2026-06-27",
        homeTeam: "Auto",
        awayTeam: "Settle",
        homeGoals: 1,
        awayGoals: 0,
        minute: 70,
        period: "2H",
        isLive: true
      };
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x00000000000000000000000000000000000000bb",
      POLY_PRIVATE_KEY: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-auto-settle-2026-06-27", homeTeam: "Auto", awayTeam: "Settle" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      settleRedeemablePositions
    });

    expect(settleRedeemablePositions).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "live",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "no_trade",
        reason: "MATCH_NOT_LATE_ENOUGH"
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
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }],
      fetchVerifiedClock: async () => ({
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
      })
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
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }],
      fetchVerifiedClock: async () => null
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
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }],
      fetchVerifiedClock: async () => ({
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
      })
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

  test("worldcup watch cleans up the default sports socket after max iterations following a trade", async () => {
    const resultPromise = runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug: "fifwc-esp-ksa-2026-06-21", homeTeam: "Spain", awayTeam: "Saudi Arabia" }],
      fetchVerifiedClock: async () => ({
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time"
      })
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
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        action: "BUY"
      }
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
      fetchWorldCupEventRefs: async () => [eventRef],
      fetchVerifiedClock: async () => null
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
