import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { netReturnRate, sportsTakerFeePerShare } from "../../src/domain/fees.js";
import type { MatchState, OrderbookSnapshot, StrategyMarket, TradeDecision, TradeResult } from "../../src/domain/types.js";

const MIN_RETURN = 0.005;
const MIN_NOTIONAL = 1;
const BALANCE_BUFFER = 5;
const EPSILON = 1e-8;

describe("locked refill watch stress coverage", () => {
  test("keeps refilling locked events across random depth moves without crossing return or balance limits", async () => {
    const random = seededRandom(0x52454649);
    const dir = await mkdtemp(join(tmpdir(), "poly-locked-refill-stress-"));

    for (let caseIndex = 0; caseIndex < 80; caseIndex += 1) {
      const eventSlug = `fifwc-locked-refill-stress-${caseIndex}-2026-06-27`;
      const overToken = `${eventSlug}-over`;
      const marketsFile = join(dir, `markets-${caseIndex}.json`);
      const ledgerFile = join(dir, `ledger-${caseIndex}.json`);
      const stages = randomStages(random);
      const initialBalance = round(40 + random() * 120, 6);
      const expected = simulate(stages, initialBalance);

      await writeFile(marketsFile, JSON.stringify([totalMarket(eventSlug, overToken)]));

      let balance = initialBalance;
      let attemptIndex = 0;
      let refreshPhase = false;
      const executed: ExpectedEntry[] = [];

      const result = await runCli([
        "--mode", "live",
        "--watch", "true",
        "--worldcup", "true",
        "--markets-file", marketsFile,
        "--ledger-file", ledgerFile,
        "--interval-ms", "0",
        "--max-iterations", String(stages.length + 3),
        "--balance-buffer", String(BALANCE_BUFFER)
      ], {
        POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
      }, {
        fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Locked", awayTeam: "Refill" }],
        fetchMatchState: async () => liveLockedMatch(eventSlug),
        watchSportsUpdates: async () => oneLiveUpdate(liveLockedMatch(eventSlug)),
        fetchVerifiedClock: async () => null,
        readPusdBalance: async () => balance,
        fetchOrderbook: async (tokenId) => {
          const stage = stages[Math.min(attemptIndex, stages.length - 1)]!;
          const price = refreshPhase ? stage.refreshPrice : stage.decisionPrice;
          const size = refreshPhase ? stage.refreshSize : stage.decisionSize;
          return book(tokenId, price, size);
        },
        executeLive: async (decision, options) => {
          const stage = stages[Math.min(attemptIndex, stages.length - 1)]!;
          refreshPhase = true;
          const refreshed = await options.refreshOrderbook?.(decision.tokenId);
          refreshPhase = false;
          const entry = executeAgainstRefresh(decision, refreshed, stage, attemptIndex);
          attemptIndex += 1;
          executed.push(entry);
          if (entry.status === "filled") balance = round(balance - entry.notional, 6);
          return tradeResult(decision, entry);
        }
      });

      expect(result.exitCode, `case ${caseIndex}: ${result.stderr}`).toBe(0);
      expect(executed, `case ${caseIndex}`).toEqual(expected.entries);

      const ledger = JSON.parse(await readFile(ledgerFile, "utf8")) as Array<Record<string, unknown>>;
      expect(ledger.map((entry) => ({
        status: entry.status,
        price: entry.price,
        notional: entry.notional
      })), `case ${caseIndex}`).toEqual(expected.entries);
      expect(ledger.filter((entry) => entry.status === "filled").length, `case ${caseIndex}`).toBeGreaterThanOrEqual(2);
    }
  });
});

interface Stage {
  decisionPrice: number;
  decisionSize: number;
  refreshPrice: number;
  refreshSize: number;
}

interface ExpectedEntry {
  status: "filled" | "rejected";
  price: number;
  notional: number;
}

function simulate(stages: readonly Stage[], initialBalance: number): { entries: ExpectedEntry[] } {
  let balance = initialBalance;
  let hasLockedFill = false;
  const entries: ExpectedEntry[] = [];

  for (const stage of stages) {
    const availableBalance = roundDownMoney(balance - BALANCE_BUFFER);
    if (availableBalance < MIN_NOTIONAL) break;
    if (!isProfitableLockedPrice(stage.decisionPrice)) break;

    const plannedNotional = Math.min(availableBalance, stage.decisionPrice * stage.decisionSize);
    if (plannedNotional < MIN_NOTIONAL) break;

    const refreshCapacity = isProfitableLockedPrice(stage.refreshPrice) ? stage.refreshPrice * stage.refreshSize : 0;
    const notional = Math.min(plannedNotional, refreshCapacity);
    if (notional < MIN_NOTIONAL) {
      entries.push({ status: "rejected", price: stage.refreshPrice, notional: 0 });
      if (!hasLockedFill) break;
      continue;
    }

    const entry = { status: "filled" as const, price: stage.refreshPrice, notional: round(notional, 8) };
    entries.push(entry);
    balance = round(balance - entry.notional, 6);
    hasLockedFill = true;
  }

  return { entries };
}

function executeAgainstRefresh(
  decision: Extract<TradeDecision, { action: "BUY" }>,
  refreshed: OrderbookSnapshot | undefined,
  stage: Stage,
  attemptIndex: number
): ExpectedEntry {
  expect(decision.locked, `attempt ${attemptIndex}`).toBe(true);
  expect(decision.strategy, `attempt ${attemptIndex}`).toBe("total_over_locked");
  expect(decision.estimatedNetReturn, `attempt ${attemptIndex}`).toBeGreaterThanOrEqual(MIN_RETURN - EPSILON);

  const asks = refreshed?.asks ?? [];
  const executable = asks
    .filter((ask) => isProfitableLockedPrice(ask.price) && ask.size > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = decision.notional;
  let notional = 0;
  let price = stage.refreshPrice;

  for (const ask of executable) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, ask.price * ask.size);
    notional += take;
    remaining -= take;
    price = ask.price;
  }

  if (notional < MIN_NOTIONAL) return { status: "rejected", price, notional: 0 };
  return { status: "filled", price, notional: round(notional, 8) };
}

function tradeResult(decision: Extract<TradeDecision, { action: "BUY" }>, entry: ExpectedEntry): TradeResult {
  if (entry.status === "rejected") {
    return {
      mode: "live",
      status: "rejected",
      orderId: `stress-rejected-${decision.eventSlug}`,
      tokenId: decision.tokenId,
      price: entry.price,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    };
  }

  const shares = entry.notional / entry.price;
  const fee = shares * sportsTakerFeePerShare(entry.price);
  return {
    mode: "live",
    status: "filled",
    orderId: `stress-filled-${decision.eventSlug}-${entry.price}`,
    tokenId: decision.tokenId,
    price: entry.price,
    shares,
    notional: entry.notional,
    fee,
    estimatedPayout: shares,
    estimatedProfit: shares - entry.notional - fee
  };
}

function randomStages(random: () => number): Stage[] {
  const stages: Stage[] = [
    fillStage(random),
    fillStage(random)
  ];
  const extraCount = 2 + Math.floor(random() * 4);
  for (let index = 0; index < extraCount; index += 1) {
    const roll = random();
    if (roll < 0.55) stages.push(fillStage(random));
    else if (roll < 0.8) stages.push(staleStage(random));
    else stages.push(tinyRefreshStage(random));
  }
  stages.push(stopStage(random));
  return stages;
}

function fillStage(random: () => number): Stage {
  const decisionPrice = randomPrice(random, 0.9, 0.985);
  const refreshPrice = randomPrice(random, 0.9, 0.9935);
  const decisionNotional = 2 + random() * 20;
  const refreshNotional = decisionNotional * (0.5 + random() * 1.5);
  return {
    decisionPrice,
    decisionSize: decisionNotional / decisionPrice,
    refreshPrice,
    refreshSize: refreshNotional / refreshPrice
  };
}

function staleStage(random: () => number): Stage {
  const decisionPrice = randomPrice(random, 0.9, 0.985);
  return {
    decisionPrice,
    decisionSize: (2 + random() * 20) / decisionPrice,
    refreshPrice: randomPrice(random, 0.995, 0.999),
    refreshSize: 100
  };
}

function tinyRefreshStage(random: () => number): Stage {
  const decisionPrice = randomPrice(random, 0.9, 0.985);
  const refreshPrice = randomPrice(random, 0.9, 0.9935);
  return {
    decisionPrice,
    decisionSize: (2 + random() * 20) / decisionPrice,
    refreshPrice,
    refreshSize: (0.1 + random() * 0.7) / refreshPrice
  };
}

function stopStage(random: () => number): Stage {
  const decisionPrice = randomPrice(random, 0.995, 0.999);
  return {
    decisionPrice,
    decisionSize: 100,
    refreshPrice: decisionPrice,
    refreshSize: 100
  };
}

async function* oneLiveUpdate(match: MatchState): AsyncIterable<MatchState> {
  yield match;
  await new Promise<never>(() => {});
}

function liveLockedMatch(eventSlug: string): MatchState {
  return {
    eventSlug,
    homeTeam: "Locked",
    awayTeam: "Refill",
    homeGoals: 1,
    awayGoals: 0,
    minute: 90,
    period: "2H",
    isLive: true,
    remainingSeconds: 120,
    remainingSecondsSource: "365scores_added_time_precise_game_time"
  };
}

function totalMarket(eventSlug: string, overToken: string): StrategyMarket {
  return {
    eventSlug,
    marketSlug: `${eventSlug}-total-0pt5`,
    question: "Locked vs. Refill: O/U 0.5",
    conditionId: `${eventSlug}-condition`,
    outcomes: ["Over", "Under"],
    clobTokenIds: [overToken, `${eventSlug}-under`],
    line: 0.5,
    marketType: "total"
  };
}

function book(tokenId: string, price: number, size: number): OrderbookSnapshot {
  return {
    tokenId,
    bids: [],
    asks: [{ price, size }]
  };
}

function isProfitableLockedPrice(price: number): boolean {
  return price >= 0.9 && price < 1 && netReturnRate(price) >= MIN_RETURN;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomPrice(random: () => number, min: number, max: number): number {
  return round(min + random() * (max - min), 4);
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function roundDownMoney(value: number): number {
  return Math.floor(value * 1_000_000) / 1_000_000;
}
