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
  fetchEventMatchState: vi.fn(async (): Promise<MatchState> => {
    throw new Error("match page polling should not be used");
  }),
  fetchEventStrategyMarkets: vi.fn(async (): Promise<StrategyMarket[]> => {
    throw new Error("market polling should not be used");
  }),
  hasLockedGoalStrategyMarkets: vi.fn((markets: readonly StrategyMarket[]): boolean => markets.some((market) =>
    market.marketType === "total" || market.marketType === "team_total" || market.marketType === "btts"
  ))
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
  fetchEventStrategyMarkets: eventPageMock.fetchEventStrategyMarkets,
  hasLockedGoalStrategyMarkets: eventPageMock.hasLockedGoalStrategyMarkets
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
    marketSlug: "total-3p5",
    question: "Strong vs. Weak: O/U 3.5",
    conditionId: "cond-total",
    outcomes: ["Over", "Under"],
    clobTokenIds: ["total-over", "total-under"],
    line: 3.5
  }
];

afterEach(() => {
  sportsLiveMock.reset();
  eventPageMock.fetchEventMatchState.mockClear();
  eventPageMock.fetchEventStrategyMarkets.mockClear();
  eventPageMock.hasLockedGoalStrategyMarkets.mockClear();
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

function teamTotalMarket(eventSlug: string, homeTeam: string, awayTeam: string, team: string, line: number, underTokenId: string): StrategyMarket {
  const lineSlug = String(line).replace(".", "pt");
  const teamSlug = team.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    eventSlug,
    marketSlug: `${eventSlug}-${teamSlug}-team-total-${lineSlug}`,
    question: `${homeTeam} vs. ${awayTeam}: ${team} O/U ${line}`,
    conditionId: `cond-${eventSlug}-${teamSlug}-team-total-${lineSlug}`,
    outcomes: ["Over", "Under"],
    clobTokenIds: [`${underTokenId}-over`, underTokenId],
    line,
    team,
    marketType: "team_total"
  };
}

describe("CLI", () => {
  test("paper mode prints a filled JSON trade result", async () => {
    const result = await runCli([
      "--mode", "paper",
      "--match-file", "tests/fixtures/matches/spain-5-0.json",
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
      lossRequiresGoals: 3,
      bestAsk: 0.97
    });
  });

  test("live mode without credentials returns LIVE_CREDENTIALS_MISSING", async () => {
    const result = await runCli([
      "--mode", "live",
      "--match-file", "tests/fixtures/matches/spain-5-0.json",
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
        homeGoals: 5,
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
        homeGoals: 5,
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
      "--match-file", "tests/fixtures/matches/spain-5-0.json",
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
      "--match-file", "tests/fixtures/matches/spain-5-0.json",
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
      "--match-file", "tests/fixtures/matches/spain-5-0.json",
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
      "--match-file", "tests/fixtures/matches/spain-5-0.json",
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
      "--match-file", "tests/fixtures/matches/spain-5-0.json",
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
          homeGoals: 5,
          awayGoals: 0,
          minute: calls === 1 ? 91 : 93,
          remainingSeconds: calls === 1 ? 241 : 240,
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
        homeGoals: 5,
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
        homeGoals: 5,
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

  test("worldcup watch buys locked overs immediately from score updates without waiting for remaining time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-immediate-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-locked-immediate-2026-06-27";
    const overToken = "locked-immediate-over";
    await writeFile(marketsFile, JSON.stringify([{
      eventSlug,
      marketSlug: `${eventSlug}-total-0pt5`,
      question: "Locked Immediate vs. Opponent: O/U 0.5",
      conditionId: "cond-locked-immediate",
      outcomes: ["Over", "Under"],
      clobTokenIds: [overToken, "locked-immediate-under"],
      line: 0.5,
      marketType: "total"
    } satisfies StrategyMarket]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug,
        homeTeam: "Locked Immediate",
        awayTeam: "Opponent",
        homeGoals: 1,
        awayGoals: 0,
        minute: 60,
        period: "2H",
        isLive: true,
        elapsedSeconds: 60 * 60
      };
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
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Locked Immediate", awayTeam: "Opponent" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        action: "BUY",
        eventSlug,
        tokenId: overToken,
        strategy: "total_over_locked",
        locked: true
      }
    });
  });

  test("worldcup watch buys first-half locked overs immediately from score updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-first-half-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-locked-first-half-2026-07-01";
    const overToken = "locked-first-half-over";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Locked", "First Half", 0.5, "locked-first-half")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.95, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug,
        homeTeam: "Locked",
        awayTeam: "First Half",
        homeGoals: 1,
        awayGoals: 0,
        minute: 45,
        period: "1H",
        isLive: true,
        elapsedSeconds: 45 * 60
      };
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "100",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Locked", awayTeam: "First Half" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        action: "BUY",
        eventSlug,
        tokenId: overToken,
        strategy: "total_over_locked",
        locked: true,
        notional: expect.closeTo(20, 8)
      }
    });
  });

  test("worldcup watch refreshes incomplete market cache so first-half locked goals can trade", async () => {
    const eventSlug = "fifwc-first-half-partial-cache-2026-07-01";
    const overToken = "first-half-partial-cache-over";
    const partialMarkets: StrategyMarket[] = [{
      eventSlug,
      marketSlug: `${eventSlug}-away-win`,
      question: "Will Cache win on 2026-07-01?",
      conditionId: `cond-${eventSlug}-away-win`,
      outcomes: ["Yes", "No"],
      clobTokenIds: ["away-yes", "away-no"],
      marketType: "moneyline"
    }];
    const completeMarkets = [
      totalMarket(eventSlug, "Partial", "Cache", 0.5, "first-half-partial-cache")
    ];
    eventPageMock.fetchEventStrategyMarkets
      .mockResolvedValueOnce(partialMarkets)
      .mockResolvedValue(completeMarkets);
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.95, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield {
        eventSlug,
        homeTeam: "Partial",
        awayTeam: "Cache",
        homeGoals: 1,
        awayGoals: 0,
        minute: 28,
        period: "1H",
        isLive: true,
        elapsedSeconds: 28 * 60
      };
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--stake", "100",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Partial", awayTeam: "Cache" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        eventSlug,
        tokenId: overToken,
        strategy: "total_over_locked",
        locked: true
      }
    });
    expect(eventPageMock.fetchEventStrategyMarkets).toHaveBeenCalledTimes(2);
  });

  test("worldcup watch actively rescans first-half matches for locked opportunities between sports updates", async () => {
    const eventSlug = "fifwc-locked-active-first-half-2026-07-01";
    const overToken = "locked-active-first-half-over";
    eventPageMock.fetchEventStrategyMarkets.mockImplementation(async (): Promise<StrategyMarket[]> => [
      totalMarket(eventSlug, "Active", "First Half", 0.5, "locked-active-first-half")
    ]);
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.96, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug,
        homeTeam: "Active",
        awayTeam: "First Half",
        homeGoals: 0,
        awayGoals: 0,
        minute: 31,
        period: "1H",
        isLive: true,
        elapsedSeconds: 31 * 60
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--stake", "100",
      "--interval-ms", "1",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Active", awayTeam: "First Half" }],
      watchSportsUpdates: async () => updates(),
      fetchMatchState: async () => ({
        eventSlug,
        homeTeam: "Active",
        awayTeam: "First Half",
        homeGoals: 1,
        awayGoals: 0,
        minute: 31,
        period: "1H",
        isLive: true,
        elapsedSeconds: 31 * 60 + 1
      }),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        eventSlug,
        tokenId: overToken,
        strategy: "total_over_locked",
        locked: true
      }
    });
  });

  test("worldcup live watch caps one score-change locked incident to 20 percent of total balance across related markets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-incident-cap-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-incident-cap-2026-06-27";
    const totalOverToken = "locked-incident-total-over";
    const teamOverToken = "locked-incident-team-over";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Incident", "Cap", 0.5, "locked-incident-total"),
      teamTotalMarket(eventSlug, "Incident", "Cap", "Incident", 0.5, "locked-incident-team")
    ]));
    const executed: Array<{ notional: number; legs?: Array<{ tokenId: string; notional: number }> }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: tokenId === totalOverToken || tokenId === teamOverToken
        ? [{ price: 0.95, size: 15 / 0.95 }]
        : []
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Incident", "Cap", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Incident", awayTeam: "Cap" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        const execution: { notional: number; legs?: Array<{ tokenId: string; notional: number }> } = {
          notional: decision.notional
        };
        if (decision.legs) execution.legs = decision.legs.map((leg) => ({ tokenId: leg.tokenId, notional: leg.notional }));
        executed.push(execution);
        return {
          mode: "live",
          status: "filled",
          orderId: "locked-incident-cap-1",
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
    expect(executed).toHaveLength(1);
    expect(executed[0]!.notional).toBeCloseTo(20, 8);
    expect(executed[0]!.legs?.reduce((total, leg) => total + leg.notional, 0)).toBeCloseTo(20, 8);
    expect(executed[0]!.legs?.map((leg) => leg.tokenId)).toEqual(
      expect.arrayContaining([totalOverToken, teamOverToken])
    );
  });

  test("worldcup live watch limits a locked incident to stable S1/S2 cheap liquidity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-delta-pass-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-delta-pass-2026-06-27";
    const totalOverToken = "locked-delta-pass-total-over";
    const teamOverToken = "locked-delta-pass-team-over";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Delta", "Pass", 0.5, "locked-delta-pass-total"),
      teamTotalMarket(eventSlug, "Delta", "Pass", "Delta", 0.5, "locked-delta-pass-team")
    ]));
    const calls = new Map<string, number>();
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => {
      const call = calls.get(tokenId) ?? 0;
      calls.set(tokenId, call + 1);
      return {
        tokenId,
        bids: [],
        asks: [{ price: 0.95, size: 5 / 0.95 }]
      };
    });
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Delta", "Pass", 0, 0);
      yield tailMatch(eventSlug, "Delta", "Pass", 1, 0);
    }
    const executed: Array<{ notional: number; legs?: Array<{ tokenId: string; notional: number }> }> = [];

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Delta", awayTeam: "Pass" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      fetchLockedGoalSignal: async (match) => ({
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        scores365GameId: 456,
        scoreMatchesSports: true,
        hasMatchingGoal: true,
        hasNoGoalSignal: false,
        hasVarReviewSignal: false,
        details: ["365 normal goal"]
      }),
      readPusdBalance: async () => 100,
      executeLive: async (decision) => {
        const execution: { notional: number; legs?: Array<{ tokenId: string; notional: number }> } = {
          notional: decision.notional
        };
        if (decision.legs) execution.legs = decision.legs.map((leg) => ({ tokenId: leg.tokenId, notional: leg.notional }));
        executed.push(execution);
        return {
          mode: "live",
          status: "filled",
          orderId: "locked-delta-pass",
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
    expect(executed).toHaveLength(1);
    expect(executed[0]!.notional).toBeCloseTo(10, 8);
    expect(executed[0]!.legs?.map((leg) => leg.tokenId)).toEqual(
      expect.arrayContaining([totalOverToken, teamOverToken])
    );
    expect(calls.get(totalOverToken)).toBeGreaterThanOrEqual(3);
    expect(calls.get(teamOverToken)).toBeGreaterThanOrEqual(3);
  });

  test("worldcup live watch can use a fast 365 score-only fallback when full goal events lag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-score-fallback-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-score-fallback-2026-07-01";
    const overToken = "locked-score-fallback-total-over";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Score", "Fallback", 0.5, "locked-score-fallback-total"),
      teamTotalMarket(eventSlug, "Score", "Fallback", "Score", 0.5, "locked-score-fallback-team")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.95, size: 20 / 0.95 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Score", "Fallback", 0, 0);
      yield tailMatch(eventSlug, "Score", "Fallback", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Score", awayTeam: "Fallback" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      fetchLockedGoalSignal: async () => null,
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: "locked-score-fallback",
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
    expect(executed).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "filled",
        eventSlug,
        tokenId: overToken,
        strategy: "total_over_locked",
        locked: true
      }
    });
  });

  test("worldcup live watch allows confirmed high-price post-goal liquidity that did not exist in S0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-delta-post-goal-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-delta-post-goal-2026-07-02";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Post", "Goal", 0.5, "locked-delta-post-goal-total"),
      teamTotalMarket(eventSlug, "Post", "Goal", "Post", 0.5, "locked-delta-post-goal-team")
    ]));
    const calls = new Map<string, number>();
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => {
      const call = calls.get(tokenId) ?? 0;
      calls.set(tokenId, call + 1);
      return {
        tokenId,
        bids: [],
        asks: call === 0 ? [] : [{ price: 0.98, size: 10 / 0.98 }]
      };
    });
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Post", "Goal", 0, 0);
      yield tailMatch(eventSlug, "Post", "Goal", 1, 0);
    }
    const executed: Array<{ notional: number; legs?: Array<{ tokenId: string; notional: number }> }> = [];

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Post", awayTeam: "Goal" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      fetchLockedGoalSignal: async (match) => ({
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        scores365GameId: 246,
        scoreMatchesSports: true,
        hasMatchingGoal: true,
        hasNoGoalSignal: false,
        hasVarReviewSignal: false,
        details: ["365 normal goal"]
      }),
      readPusdBalance: async () => 100,
      executeLive: async (decision) => {
        const execution: { notional: number; legs?: Array<{ tokenId: string; notional: number }> } = {
          notional: decision.notional
        };
        if (decision.legs) execution.legs = decision.legs.map((leg) => ({ tokenId: leg.tokenId, notional: leg.notional }));
        executed.push(execution);
        return {
          mode: "live",
          status: "filled",
          orderId: "locked-delta-post-goal",
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
    expect(executed).toHaveLength(1);
    expect(executed[0]!.notional).toBeCloseTo(20, 8);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "filled",
        eventSlug,
        strategy: "total_over_locked",
        locked: true
      }
    });
  });

  test("worldcup live watch caps confirmed growing liquidity to stable S1/S2 notional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-delta-growth-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-locked-delta-growth-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Delta", "Growth", 0.5, "locked-delta-growth-total"),
      teamTotalMarket(eventSlug, "Delta", "Growth", "Delta", 0.5, "locked-delta-growth-team")
    ]));
    const calls = new Map<string, number>();
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => {
      const call = calls.get(tokenId) ?? 0;
      calls.set(tokenId, call + 1);
      const notional = call <= 1 ? 5 : 50;
      return {
        tokenId,
        bids: [],
        asks: [{ price: 0.95, size: notional / 0.95 }]
      };
    });
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Delta", "Growth", 0, 0);
      yield tailMatch(eventSlug, "Delta", "Growth", 1, 0);
    }
    const executed: Array<{ tokenId: string; notional: number; legs?: Array<{ tokenId: string; notional: number }> }> = [];

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", join(dir, "ledger.json"),
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Delta", awayTeam: "Growth" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      fetchLockedGoalSignal: async (match) => ({
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        scores365GameId: 789,
        scoreMatchesSports: true,
        hasMatchingGoal: true,
        hasNoGoalSignal: false,
        hasVarReviewSignal: false,
        details: ["365 normal goal"]
      }),
      readPusdBalance: async () => 100,
      executeLive: async (decision) => {
        const execution: { tokenId: string; notional: number; legs?: Array<{ tokenId: string; notional: number }> } = {
          tokenId: decision.tokenId,
          notional: decision.notional
        };
        if (decision.legs) execution.legs = decision.legs.map((leg) => ({ tokenId: leg.tokenId, notional: leg.notional }));
        executed.push(execution);
        return {
          mode: "live",
          status: "filled",
          orderId: "locked-delta-growth",
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
    expect(executed).toHaveLength(1);
    expect(executed[0]!.notional).toBeCloseTo(10, 8);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "filled",
        eventSlug,
        strategy: "total_over_locked",
        locked: true
      }
    });
  });

  test("worldcup live watch blocks locked incidents when best ask retraces before execution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-delta-retrace-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-locked-delta-retrace-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Delta", "Retrace", 0.5, "locked-delta-retrace-total"),
      teamTotalMarket(eventSlug, "Delta", "Retrace", "Delta", 0.5, "locked-delta-retrace-team")
    ]));
    const calls = new Map<string, number>();
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => {
      const call = calls.get(tokenId) ?? 0;
      calls.set(tokenId, call + 1);
      const price = call >= 2 ? 0.94 : 0.98;
      return {
        tokenId,
        bids: [],
        asks: [{ price, size: 20 / price }]
      };
    });
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Delta", "Retrace", 0, 0);
      yield tailMatch(eventSlug, "Delta", "Retrace", 1, 0);
    }
    const executed: Array<{ tokenId: string; notional: number }> = [];

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", join(dir, "ledger.json"),
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Delta", awayTeam: "Retrace" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      fetchLockedGoalSignal: async (match) => ({
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        scores365GameId: 987,
        scoreMatchesSports: true,
        hasMatchingGoal: true,
        hasNoGoalSignal: false,
        hasVarReviewSignal: false,
        details: ["365 normal goal"]
      }),
      readPusdBalance: async () => 100,
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: "locked-delta-retrace",
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
    expect(executed).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "no_trade",
        reason: "NO_ELIGIBLE_STRATEGY",
        details: expect.stringContaining("best ask retraced")
      }
    });
  });

  test("worldcup live watch skips unconfirmed high-return locked incidents by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-risk-high-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-risk-high-2026-06-27";
    const overToken = "locked-risk-high-total-over";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Risk", "High", 0.5, "locked-risk-high-total")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.95, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Risk", "High", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Risk", awayTeam: "High" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: `locked-risk-high-${executed.length}`,
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
    expect(executed).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "no_trade",
        reason: "NO_ELIGIBLE_STRATEGY",
        details: expect.stringContaining("locked score guard")
      }
    });
  });

  test("worldcup live watch skips unconfirmed medium-return locked incidents by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-risk-medium-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-risk-medium-2026-06-27";
    const overToken = "locked-risk-medium-total-over";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Risk", "Medium", 0.5, "locked-risk-medium-total")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.97, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Risk", "Medium", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Risk", awayTeam: "Medium" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: `locked-risk-medium-${executed.length}`,
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
    expect(executed).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "no_trade",
        reason: "NO_ELIGIBLE_STRATEGY",
        details: expect.stringContaining("locked score guard")
      }
    });
  });

  test("worldcup live watch allows high-price stable locked fallback when 365 goal signal is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-risk-low-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-risk-low-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Risk", "Low", 0.5, "locked-risk-low-total")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.99, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Risk", "Low", 0, 0);
      yield tailMatch(eventSlug, "Risk", "Low", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Risk", awayTeam: "Low" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: `locked-risk-low-${executed.length}`,
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
    expect(executed).toEqual([{ tokenId: "locked-risk-low-total-over", notional: expect.any(Number) }]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "filled",
        eventSlug,
        decision: {
          locked: true,
          bestAsk: 0.99
        }
      }
    });
  });

  test("worldcup live watch blocks locked fallback when a sub-floor ask is in front", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-risk-subfloor-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-risk-subfloor-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Risk", "Subfloor", 0.5, "locked-risk-subfloor-total")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [
        { price: 0.84, size: 100 },
        { price: 0.99, size: 10_000 }
      ]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Risk", "Subfloor", 0, 0);
      yield tailMatch(eventSlug, "Risk", "Subfloor", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Risk", awayTeam: "Subfloor" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: `locked-risk-subfloor-${executed.length}`,
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
    expect(executed).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "no_trade",
        details: expect.stringContaining("below locked floor")
      }
    });
  });

  test("worldcup watch hard-blocks a locked buy when 365 events report no-goal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-nogoal-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-locked-nogoal-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "No", "Goal", 0.5, "locked-nogoal-total"),
      teamTotalMarket(eventSlug, "No", "Goal", "No", 0.5, "locked-nogoal-team")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.95, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "No", "Goal", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", join(dir, "ledger.json"),
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "No", awayTeam: "Goal" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      fetchLockedGoalSignal: async (match) => ({
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        scores365GameId: 123,
        scoreMatchesSports: true,
        hasMatchingGoal: false,
        hasNoGoalSignal: true,
        hasVarReviewSignal: false,
        details: ["Goal Disallowed Var", "VAR Decision: No Goal"]
      }),
      readPusdBalance: async () => 100,
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: "locked-nogoal",
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
    expect(executed).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "no_trade",
        reason: "NO_ELIGIBLE_STRATEGY",
        details: expect.stringContaining("No Goal")
      }
    });
  });

  test("worldcup watch hard-blocks a locked buy when 365 reports a post-regulation goal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-post-regulation-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-locked-post-regulation-2026-07-02";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Extra", "Time", 4.5, "locked-post-regulation-total")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.95, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Extra", "Time", 2, 2);
      yield tailMatch(eventSlug, "Extra", "Time", 3, 2);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", join(dir, "ledger.json"),
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Extra", awayTeam: "Time" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      fetchLockedGoalSignal: async (match) => ({
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        scores365GameId: 321,
        scoreMatchesSports: true,
        hasMatchingGoal: true,
        hasNoGoalSignal: false,
        hasVarReviewSignal: false,
        hasPostRegulationGoalSignal: true,
        details: ["365 event post-regulation goal at 120+5"]
      }),
      readPusdBalance: async () => 100,
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: "locked-post-regulation",
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
    expect(executed).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "no_trade",
        reason: "NO_ELIGIBLE_STRATEGY",
        details: expect.stringContaining("post-regulation")
      }
    });
  });

  test("worldcup live watch gives the next score increase a fresh 20 percent locked incident budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-next-incident-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-next-incident-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Next", "Incident", 0.5, "next-incident-total-0pt5"),
      totalMarket(eventSlug, "Next", "Incident", 1.5, "next-incident-total-1pt5")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: tokenId.includes("1pt5") ? 0.94 : 0.95, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Next", "Incident", 1, 0);
      yield tailMatch(eventSlug, "Next", "Incident", 2, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Next", awayTeam: "Incident" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: `locked-next-incident-${executed.length}`,
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
    expect(executed).toEqual([
      { tokenId: "next-incident-total-0pt5-over", notional: expect.closeTo(20, 8) },
      { tokenId: "next-incident-total-1pt5-over", notional: expect.closeTo(20, 8) }
    ]);
  });

  test("worldcup live watch lets non-locked tail candidates trade after a locked incident cap is spent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-cap-then-tail-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-cap-then-tail-2026-06-27";
    const lockedOverToken = "cap-then-tail-0pt5-over";
    const tailUnderToken = "cap-then-tail-4pt5-under";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Cap", "Tail", 0.5, "cap-then-tail-0pt5"),
      totalMarket(eventSlug, "Cap", "Tail", 4.5, tailUnderToken)
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: tokenId === lockedOverToken
        ? [{ price: 0.95, size: 10_000 }]
        : tokenId === tailUnderToken
          ? [{ price: 0.97, size: 30 / 0.97 }]
          : []
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Cap", "Tail", 1, 0);
      yield tailMatch(eventSlug, "Cap", "Tail", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Cap", awayTeam: "Tail" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: `cap-then-tail-${executed.length}`,
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
    expect(executed).toEqual([
      { tokenId: lockedOverToken, notional: expect.closeTo(20, 8) },
      { tokenId: tailUnderToken, notional: expect.closeTo(30, 8) }
    ]);
  });

  test("worldcup watch skips a new locked score-change opportunity when an external score source disagrees", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-score-mismatch-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-locked-score-mismatch-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Score", "Mismatch", 0.5, "locked-score-mismatch-total")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.95, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      const { remainingSeconds: _remainingSeconds, remainingSecondsSource: _remainingSecondsSource, ...update } = tailMatch(eventSlug, "Score", "Mismatch", 1, 0);
      yield update;
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
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Score", awayTeam: "Mismatch" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => ({
        homeGoals: 0,
        awayGoals: 0
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      last: {
        status: "no_trade",
        reason: "NO_ELIGIBLE_STRATEGY",
        details: expect.stringContaining("365 score")
      }
    });
  });

  test("worldcup live watch treats a rolled-back score that appears again as a fresh locked incident", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-score-rollback-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-score-rollback-2026-06-27";
    const overToken = "locked-score-rollback-total-over";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Score", "Rollback", 0.5, "locked-score-rollback-total")
    ]));
    const executed: Array<{ tokenId: string; notional: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.95, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Score", "Rollback", 1, 0);
      yield tailMatch(eventSlug, "Score", "Rollback", 0, 0);
      yield tailMatch(eventSlug, "Score", "Rollback", 1, 0);
    }

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "3"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Score", awayTeam: "Rollback" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      readPusdBalance: async () => 100 - executed.reduce((total, trade) => total + trade.notional, 0),
      executeLive: async (decision) => {
        executed.push({ tokenId: decision.tokenId, notional: decision.notional });
        return {
          mode: "live",
          status: "filled",
          orderId: `locked-score-rollback-${executed.length}`,
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
    expect(executed).toEqual([
      { tokenId: overToken, notional: expect.closeTo(20, 8) },
      { tokenId: overToken, notional: expect.closeTo(20, 8) }
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "watch_complete",
      last: {
        status: "filled",
        tokenId: overToken
      }
    });
  });

  test("worldcup watch actively rescans second-half matches for locked opportunities between sports updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-active-poll-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-locked-active-poll-2026-06-29";
    const overToken = "locked-active-poll-over";
    await writeFile(marketsFile, JSON.stringify([{
      eventSlug,
      marketSlug: `${eventSlug}-total-0pt5`,
      question: "Locked Active vs. Poll: O/U 0.5",
      conditionId: "cond-locked-active-poll",
      outcomes: ["Over", "Under"],
      clobTokenIds: [overToken, "locked-active-poll-under"],
      line: 0.5,
      marketType: "total"
    } satisfies StrategyMarket]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug,
        homeTeam: "Locked Active",
        awayTeam: "Poll",
        homeGoals: 0,
        awayGoals: 0,
        minute: 60,
        period: "2H",
        isLive: true,
        elapsedSeconds: 60 * 60
      };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    let matchPolls = 0;

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "97",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Locked Active", awayTeam: "Poll" }],
      watchSportsUpdates: async () => updates(),
      fetchMatchState: async () => {
        matchPolls += 1;
        return {
          eventSlug,
          homeTeam: "Locked Active",
          awayTeam: "Poll",
          homeGoals: 1,
          awayGoals: 0,
          minute: 60,
          period: "2H",
          isLive: true,
          elapsedSeconds: 60 * 60 + matchPolls
        };
      },
      fetchLockedGoalSignal: async (match) => ({
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        scores365GameId: 1301,
        scoreMatchesSports: true,
        hasMatchingGoal: true,
        hasNoGoalSignal: false,
        hasVarReviewSignal: false,
        details: ["365 normal goal"]
      }),
      fetchVerifiedClock: async () => {
        throw new Error("365 clock should not be needed before the tail window");
      }
    });

    expect(result.exitCode).toBe(0);
    expect(matchPolls).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        action: "BUY",
        eventSlug,
        tokenId: overToken,
        strategy: "total_over_locked",
        locked: true
      }
    });
  });

  test("worldcup watch does not let a verified clock patch change the event score", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-clock-score-guard-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-col-prt-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Colombia", "Portugal", 0.5, "col-prt-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.99, size: 10_000 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug,
        homeTeam: "Colombia",
        awayTeam: "Portugal",
        homeGoals: 0,
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
      "--markets-file", marketsFile,
      "--stake", "97",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Colombia", awayTeam: "Portugal" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => ({
        remainingSeconds: 120,
        remainingSecondsSource: "365scores_added_time_precise_game_time",
        homeGoals: 3,
        awayGoals: 1
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "no_trade",
        eventSlug
      }
    });
    expect(clobMock.fetchOrderbook).toHaveBeenCalledTimes(1);
  });

  test("worldcup watch keeps polling 365Scores after the sports feed stops at 90 minutes", async () => {
    let clockCalls = 0;
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug: "fifwc-esp-ksa-2026-06-21",
        homeTeam: "Spain",
        awayTeam: "Saudi Arabia",
        homeGoals: 5,
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
        homeGoals: 5,
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
      totalMarket(firstSlug, "First", "Match", 6.5, "first-under"),
      totalMarket(secondSlug, "Second", "Match", 6.5, "second-under")
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
      totalMarket(firstSlug, "Clock", "First", 6.5, "clock-first-under"),
      totalMarket(secondSlug, "Clock", "Second", 6.5, "clock-second-under")
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
      totalMarket(eventSlug, "Senegal", "Iraq", 7.5, "senegal-iraq-under")
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
      totalMarket(eventSlug, "Default", "Threshold", 6.5, "default-threshold-under")
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

  test("worldcup live watch executes the default buy path without a dry-run refetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-fast-live-default-"));
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-fast-live-default-2026-06-30";
    eventPageMock.fetchEventStrategyMarkets.mockImplementation(async (): Promise<StrategyMarket[]> => [
      totalMarket(eventSlug, "Fast", "Live", 6.5, "fast-live-under")
    ]);
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Fast", "Live", 2, 2);
    }
    const executeLive = vi.fn(async (decision) => ({
      mode: "live" as const,
      status: "filled" as const,
      orderId: "fast-live-default",
      tokenId: decision.tokenId,
      price: decision.bestAsk,
      shares: decision.shares,
      notional: decision.notional,
      fee: decision.estimatedFee,
      estimatedPayout: decision.shares,
      estimatedProfit: decision.shares - decision.notional - decision.estimatedFee
    }));

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--stake", "10",
      "--ledger-file", ledgerFile,
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Fast", awayTeam: "Live" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      executeLive
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "live",
      status: "watch_complete",
      iterations: 1,
      last: {
        status: "filled",
        eventSlug,
        tokenId: "fast-live-under"
      }
    });
    expect(executeLive).toHaveBeenCalledTimes(1);
    expect(eventPageMock.fetchEventStrategyMarkets).toHaveBeenCalledTimes(1);
    expect(clobMock.fetchOrderbook).toHaveBeenCalledTimes(1);
  });

  test("worldcup watch reuses event market discovery across active locked rescans", async () => {
    const eventSlug = "fifwc-market-cache-locked-2026-06-30";
    const overToken = "market-cache-under-over";
    eventPageMock.fetchEventStrategyMarkets.mockImplementation(async (): Promise<StrategyMarket[]> => [
      totalMarket(eventSlug, "Market", "Cache", 0.5, "market-cache-under")
    ]);
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug,
        homeTeam: "Market",
        awayTeam: "Cache",
        homeGoals: 0,
        awayGoals: 0,
        minute: 60,
        period: "2H",
        isLive: true,
        elapsedSeconds: 60 * 60
      };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--stake", "10",
      "--interval-ms", "0",
      "--max-iterations", "2"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Market", awayTeam: "Cache" }],
      watchSportsUpdates: async () => updates(),
      fetchMatchState: async () => ({
        eventSlug,
        homeTeam: "Market",
        awayTeam: "Cache",
        homeGoals: 1,
        awayGoals: 0,
        minute: 60,
        period: "2H",
        isLive: true,
        elapsedSeconds: 60 * 60 + 1
      }),
      fetchLockedGoalSignal: async (match) => ({
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        scores365GameId: 2101,
        scoreMatchesSports: true,
        hasMatchingGoal: true,
        hasNoGoalSignal: false,
        hasVarReviewSignal: false,
        details: ["365 normal goal"]
      }),
      fetchVerifiedClock: async () => {
        throw new Error("locked active rescan should not need verified clock");
      }
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        eventSlug,
        tokenId: overToken
      }
    });
    expect(eventPageMock.fetchEventStrategyMarkets).toHaveBeenCalledTimes(1);
    expect(clobMock.fetchOrderbook).toHaveBeenCalledTimes(3);
  });

  test("writes depth audit records with candidate books and decisions for replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-depth-audit-"));
    const marketsFile = join(dir, "markets.json");
    const depthAuditFile = join(dir, "depth.ndjson");
    const eventSlug = "fifwc-depth-audit-2026-06-30";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Depth", "Audit", 6.5, "depth-audit-under-a"),
      totalMarket(eventSlug, "Depth", "Audit", 7.5, "depth-audit-under-b")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [{ price: 0.95, size: 7 }],
      asks: tokenId === "depth-audit-under-b"
        ? [{ price: 0.97, size: 3 }, { price: 0.98, size: 2 }]
        : [{ price: 0.98, size: 4 }]
    }));

    const result = await runCli([
      "--mode", "paper",
      "--event-slug", eventSlug,
      "--markets-file", marketsFile,
      "--depth-audit-file", depthAuditFile,
      "--stake", "10"
    ], {}, {
      fetchMatchState: async () => tailMatch(eventSlug, "Depth", "Audit", 2, 2),
      fetchVerifiedClock: async () => null
    });

    expect(result.exitCode).toBe(0);
    const lines = (await readFile(depthAuditFile, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      mode: "paper",
      eventSlug,
      match: {
        homeGoals: 2,
        awayGoals: 2
      },
      thresholds: {
        minimumNetReturn: 0.005,
        minimumNotional: 1,
        maxNotional: 10
      },
      decision: {
        action: "BUY",
        bestAsk: 0.97
      }
    });
    expect(record).toHaveProperty("timestamp", expect.any(String));
    expect(record).toHaveProperty("candidates", expect.arrayContaining([
      expect.objectContaining({ tokenId: "depth-audit-under-a", lossRequiresGoals: 3 }),
      expect.objectContaining({ tokenId: "depth-audit-under-b", lossRequiresGoals: 4 })
    ]));
    expect(record).toHaveProperty("orderbooks", expect.arrayContaining([
      expect.objectContaining({
        tokenId: "depth-audit-under-a",
        asks: [{ price: 0.98, size: 4 }]
      }),
      expect.objectContaining({
        tokenId: "depth-audit-under-b",
        asks: [{ price: 0.97, size: 3 }, { price: 0.98, size: 2 }]
      })
    ]));
  });

  test("writes depth audit records when an early live match has no locked candidates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-depth-audit-early-"));
    const marketsFile = join(dir, "markets.json");
    const depthAuditFile = join(dir, "depth.ndjson");
    const eventSlug = "fifwc-depth-audit-early-2026-07-01";
    await writeFile(marketsFile, JSON.stringify([{
      eventSlug,
      marketSlug: `${eventSlug}-away-win`,
      question: "Will Audit win on 2026-07-01?",
      conditionId: `cond-${eventSlug}-away-win`,
      outcomes: ["Yes", "No"],
      clobTokenIds: ["audit-yes", "audit-no"],
      marketType: "moneyline"
    } satisfies StrategyMarket]));
    async function* updates(): AsyncIterable<MatchState> {
      yield {
        eventSlug,
        homeTeam: "Early",
        awayTeam: "Audit",
        homeGoals: 1,
        awayGoals: 0,
        minute: 22,
        period: "1H",
        isLive: true,
        elapsedSeconds: 22 * 60
      };
    }

    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--depth-audit-file", depthAuditFile,
      "--stake", "100",
      "--interval-ms", "0",
      "--max-iterations", "1"
    ], {}, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Early", awayTeam: "Audit" }],
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
        reason: "MATCH_NOT_LATE_ENOUGH",
        eventSlug
      }
    });
    const [line] = (await readFile(depthAuditFile, "utf8")).trim().split("\n");
    const record = JSON.parse(line!) as Record<string, unknown>;
    expect(record).toMatchObject({
      mode: "paper",
      eventSlug,
      candidates: [],
      orderbooks: [],
      decision: {
        action: "NO_TRADE",
        reason: "MATCH_NOT_LATE_ENOUGH",
        eventSlug
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
      totalMarket(firstSlug, "Live", "Error", 6.5, "live-error-first-under"),
      totalMarket(secondSlug, "Live", "Next", 6.5, "live-error-second-under")
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

  test("worldcup live watch retries the same event after a transient execution error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-live-exec-error-retry-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-live-error-retry-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Live", "Retry", 6.5, "live-error-retry-under")
    ]));
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => ({
      tokenId,
      bids: [],
      asks: [{ price: 0.98, size: 100 }]
    }));
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Live", "Retry", 2, 2);
      yield tailMatch(eventSlug, "Live", "Retry", 2, 2);
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
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Live", awayTeam: "Retry" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async () => null,
      executeLive: async (decision) => {
        calls += 1;
        if (calls === 1) throw new Error("temporary balance propagation failed");
        return {
          mode: "live",
          status: "filled",
          orderId: "live-retry-after-error",
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
    expect(calls, result.stdout).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "live",
      status: "watch_complete",
      iterations: 2,
      last: {
        status: "filled",
        eventSlug
      }
    });
  });

  test("worldcup live watch retries the same event after an all-rejected FAK basket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-live-rejected-retry-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-live-retry-after-rejected-2026-06-27";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Retry", "Rejected", 6.5, "retry-rejected-under")
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

  test("worldcup live watch keeps refilling a locked event when new profitable depth appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-locked-refill-"));
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const eventSlug = "fifwc-locked-refill-2026-06-27";
    const overToken = "locked-refill-under-over";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Locked", "Refill", 0.5, "locked-refill-under")
    ]));
    const executed: Array<{ eventSlug: string; tokenId: string; notional: number; price: number }> = [];
    clobMock.fetchOrderbook.mockImplementation(async (tokenId: string): Promise<OrderbookSnapshot> => {
      const price = executed.length === 0 ? 0.91 : executed.length === 1 ? 0.92 : 0.995;
      return {
        tokenId,
        bids: [],
        asks: [{ price, size: 10 }]
      };
    });
    async function* updates(): AsyncIterable<MatchState> {
      yield tailMatch(eventSlug, "Locked", "Refill", 1, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const balances = [100, 100, 90, 90, 80, 80];
    let balanceCalls = 0;

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--stake", "30",
      "--ledger-file", ledgerFile,
      "--interval-ms", "0",
      "--max-iterations", "3"
    ], {
      POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
    }, {
      fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Locked", awayTeam: "Refill" }],
      watchSportsUpdates: async () => updates(),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      readPusdBalance: async () => balances[Math.min(balanceCalls++, balances.length - 1)]!,
      executeLive: async (decision) => {
        executed.push({
          eventSlug: decision.eventSlug,
          tokenId: decision.tokenId,
          notional: decision.notional,
          price: decision.bestAsk
        });
        return {
          mode: "live",
          status: "filled",
          orderId: `locked-refill-${executed.length}`,
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
    expect(executed).toEqual([
      { eventSlug, tokenId: overToken, notional: 9.1, price: 0.91 },
      { eventSlug, tokenId: overToken, notional: expect.closeTo(9.2, 8), price: 0.92 }
    ]);
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    expect(ledger).toEqual([
      expect.objectContaining({ eventSlug, tokenId: overToken, status: "filled", price: 0.91 }),
      expect.objectContaining({ eventSlug, tokenId: overToken, status: "filled", price: 0.92 })
    ]);
  });

  test("worldcup watch skips candidates below the default 0.5% minimum without waiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-default-min-return-"));
    const marketsFile = join(dir, "markets.json");
    const eventSlug = "fifwc-default-min-return-2026-06-26";
    await writeFile(marketsFile, JSON.stringify([
      totalMarket(eventSlug, "Default", "Minimum", 6.5, "default-minimum-under")
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
      totalMarket(lowSlug, "Low", "Return", 6.5, "low-under"),
      totalMarket(highSlug, "High", "Return", 4.5, "high-under")
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
        marketSlug: `${highSlug}-total-4pt5`,
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
      totalMarket(lowerSlug, "Lower", "Deferred", 6.5, "lower-under"),
      totalMarket(betterSlug, "Better", "Deferred", 6.5, "better-under")
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
        marketSlug: `${lowerSlug}-total-6pt5`,
        bestAsk: 0.99
      }
    });
  });

  test("worldcup live watch skips balance before the tail window when no locked market is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-early-tail-"));
    const marketsFile = join(dir, "markets.json");
    await writeFile(marketsFile, JSON.stringify([]));
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
      "--markets-file", marketsFile,
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

  test("worldcup watch retries transient event discovery fetch failures", async () => {
    let discoveryCalls = 0;
    const result = await runCli([
      "--mode", "paper",
      "--watch", "true",
      "--worldcup", "true",
      "--interval-ms", "0"
    ], {}, {
      fetchWorldCupEventRefs: async () => {
        discoveryCalls += 1;
        if (discoveryCalls === 1) throw new TypeError("fetch failed");
        throw new Error("REDISCOVERED_AFTER_TRANSIENT_DISCOVERY_ERROR");
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("REDISCOVERED_AFTER_TRANSIENT_DISCOVERY_ERROR");
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

  test("worldcup watch uses a short default reconnect delay after transient sports stream errors", async () => {
    vi.useFakeTimers();
    let discoveryCalls = 0;
    try {
      const resultPromise = runCli([
        "--mode", "paper",
        "--watch", "true",
        "--worldcup", "true"
      ], {}, {
        fetchWorldCupEventRefs: async () => {
          discoveryCalls += 1;
          if (discoveryCalls === 1) return [{ eventSlug: "fifwc-fast-reconnect-2026-06-27", homeTeam: "Fast", awayTeam: "Reconnect" }];
          throw new Error("REDISCOVERED_FAST_RECONNECT");
        },
        watchSportsUpdates: async () => (async function* (): AsyncIterable<MatchState> {
          throw new Error("temporary sports stream down");
        })()
      });

      await vi.waitFor(() => {
        expect(discoveryCalls).toBe(1);
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(discoveryCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("REDISCOVERED_FAST_RECONNECT");
      expect(discoveryCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("worldcup live watch starts auto redeem settlement in the background", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-cli-auto-settle-"));
    const marketsFile = join(dir, "markets.json");
    await writeFile(marketsFile, JSON.stringify([]));
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
      "--markets-file", marketsFile,
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
      homeGoals: 5,
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
      homeGoals: 5,
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
      homeGoals: 5,
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
