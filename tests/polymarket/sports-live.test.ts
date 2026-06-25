import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runDecisionFlow } from "../../src/runner.js";
import {
  appendSportsAudit,
  matchSportsUpdateToEvent,
  normalizeSportsUpdate,
  parseElapsedSeconds,
  SportsLiveProvider
} from "../../src/polymarket/sports-live.js";
import type { OrderbookSnapshot, StrategyMarket } from "../../src/domain/types.js";
import type { WorldCupEventRef } from "../../src/polymarket/worldcup-events.js";

const refs: WorldCupEventRef[] = [
  {
    eventSlug: "fifwc-prt-uzb-2026-06-23",
    gameId: 90086952,
    sportradarGameId: "sr:sport_event:66457034",
    homeTeam: "Portugal",
    awayTeam: "Uzbekistan",
    startTime: "2026-06-23T17:00:00Z"
  }
];

describe("sports live update helpers", () => {
  test("parses elapsed formats", () => {
    expect(parseElapsedSeconds("89:30")).toBe(5370);
    expect(parseElapsedSeconds("90+3'")).toBe(5580);
    expect(parseElapsedSeconds("93:00")).toBe(5580);
    expect(parseElapsedSeconds("")).toBeUndefined();
  });

  test("matches by gameId and normalizes score", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "3-1",
      period: "2H",
      elapsed: "90+3'",
      live: true,
      ended: false
    }, refs, new Date("2026-06-23T19:00:00.000Z"));

    expect(update).toMatchObject({
      eventSlug: "fifwc-prt-uzb-2026-06-23",
      homeGoals: 3,
      awayGoals: 1,
      period: "2H",
      elapsedSeconds: 5580,
      isLive: true,
      ended: false
    });
  });

  test("does not trust generic remainingSeconds from sports updates for tail entry", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "3-1",
      period: "2H",
      elapsed: "90:00",
      remaining_seconds: "240",
      live: true
    }, refs, new Date("2026-06-23T19:00:00.000Z"));

    expect(update).toMatchObject({
      elapsedSeconds: 5400
    });
    expect(update).not.toHaveProperty("remainingSeconds");
  });

  test("does not trust generic remainingSeconds fallback fields", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "3-1",
      period: "2H",
      elapsed: "90:00",
      remainingSeconds: "",
      remaining_seconds: "240",
      live: true
    }, refs, new Date("2026-06-23T19:00:00.000Z"));

    expect(update).toMatchObject({
      elapsedSeconds: 5400
    });
    expect(update).not.toHaveProperty("remainingSeconds");
  });

  test("does not trust generic remainingMinutes from sports updates", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "3-1",
      period: "2H",
      elapsed: "90:00",
      remainingMinutes: "4",
      live: true
    }, refs, new Date("2026-06-23T19:00:00.000Z"));

    expect(update).toMatchObject({
      elapsedSeconds: 5400
    });
    expect(update).not.toHaveProperty("remainingMinutes");
  });

  test("blank remainingSeconds does not activate strict remaining-time entry", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "4-0",
      period: "2H",
      elapsed: "89:30",
      remainingSeconds: "   ",
      live: true
    }, refs, new Date("2026-06-23T19:00:00.000Z"));
    expect(update).not.toBeNull();
    expect(update).not.toHaveProperty("remainingSeconds");

    const markets: StrategyMarket[] = [
      {
        eventSlug: refs[0]!.eventSlug,
        marketSlug: "uzbekistan-moneyline",
        question: "Will Uzbekistan win on 2026-06-23?",
        conditionId: "cond-uzb-win",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["uzb-yes", "uzb-no"]
      }
    ];
    const orderbook: OrderbookSnapshot = {
      tokenId: "uzb-no",
      bids: [],
      asks: [{ price: 0.97, size: 100 }]
    };

    const decision = runDecisionFlow({
      match: update!,
      markets,
      orderbooks: [orderbook],
      stake: 10,
      thresholds: { entryWindowMinutes: 3 }
    });

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "MATCH_NOT_LATE_ENOUGH",
      details: expect.stringContaining("No verified remainingSeconds")
    });
  });

  test("elapsed 90 without verified 365 clock does not trade", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "4-0",
      period: "2H",
      elapsed: "90:00",
      remainingSeconds: "240",
      live: true
    }, refs, new Date("2026-06-23T19:00:00.000Z"));
    expect(update).not.toBeNull();

    const markets: StrategyMarket[] = [
      {
        eventSlug: refs[0]!.eventSlug,
        marketSlug: "uzbekistan-moneyline",
        question: "Will Uzbekistan win on 2026-06-23?",
        conditionId: "cond-uzb-win",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["uzb-yes", "uzb-no"]
      }
    ];
    const orderbook: OrderbookSnapshot = {
      tokenId: "uzb-no",
      bids: [],
      asks: [{ price: 0.97, size: 100 }]
    };

    const decision = runDecisionFlow({
      match: update!,
      markets,
      orderbooks: [orderbook],
      stake: 10,
      thresholds: { entryWindowMinutes: 3 }
    });

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "MATCH_NOT_LATE_ENOUGH",
      details: expect.stringContaining("No verified remainingSeconds")
    });
  });

  test("clock-like generic remaining_time is ignored and does not trade", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "4-0",
      period: "2H",
      elapsed: "90:00",
      remaining_time: "04:00",
      live: true
    }, refs, new Date("2026-06-23T19:00:00.000Z"));
    expect(update).toMatchObject({
      elapsedSeconds: 5400
    });
    expect(update).not.toHaveProperty("remainingSeconds");

    const markets: StrategyMarket[] = [
      {
        eventSlug: refs[0]!.eventSlug,
        marketSlug: "uzbekistan-moneyline",
        question: "Will Uzbekistan win on 2026-06-23?",
        conditionId: "cond-uzb-win",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["uzb-yes", "uzb-no"]
      }
    ];
    const orderbook: OrderbookSnapshot = {
      tokenId: "uzb-no",
      bids: [],
      asks: [{ price: 0.97, size: 100 }]
    };

    const decision = runDecisionFlow({
      match: update!,
      markets,
      orderbooks: [orderbook],
      stake: 10,
      thresholds: { entryWindowMinutes: 3 }
    });

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "MATCH_NOT_LATE_ENOUGH",
      details: expect.stringContaining("No verified remainingSeconds")
    });
  });

  test("matches by sportradarGameId", () => {
    expect(matchSportsUpdateToEvent({ sportradarGameId: "sr:sport_event:66457034" }, refs)?.eventSlug)
      .toBe("fifwc-prt-uzb-2026-06-23");
  });

  test("returns null for malformed scores", () => {
    expect(normalizeSportsUpdate({ gameId: 90086952, score: "bad", period: "2H", live: true }, refs)).toBeNull();
  });

  test("handles rejected update callbacks without rejecting message processing", async () => {
    const failure = new Error("handler failed");
    const errors: unknown[] = [];
    const provider = new SportsLiveProvider({
      events: refs,
      onError: (error) => errors.push(error)
    });
    const message = JSON.stringify({
      gameId: 90086952,
      score: "3-1",
      period: "2H",
      elapsed: "90+3'",
      live: true
    });

    await expect((provider as unknown as {
      handleMessage(data: unknown, onUpdate: () => Promise<void>): Promise<void>;
    }).handleMessage(message, async () => {
      throw failure;
    })).resolves.toBeUndefined();
    expect(errors).toEqual([failure]);
  });

  test("writes audit records as ndjson", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-sports-audit-"));
    const file = join(dir, "audit.ndjson");
    await appendSportsAudit(file, {
      receivedAt: "2026-06-23T19:00:00.000Z",
      raw: { gameId: 90086952 },
      normalized: { eventSlug: "fifwc-prt-uzb-2026-06-23" }
    });

    expect(await readFile(file, "utf8")).toContain("\"eventSlug\":\"fifwc-prt-uzb-2026-06-23\"");
  });
});
