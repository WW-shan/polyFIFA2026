/**
 * Live/dry-run watch loop for the tennis tail ladder.
 *
 * Responsibilities kept here (the I/O shell):
 *  - discover the live tennis moneyline markets;
 *  - poll 365Scores point frames for those events;
 *  - while Gen1 holds, sweep the ladder and submit missing levels as they
 *    become restable (the backtest arms each level at its own first qualifying
 *    second, so a single one-shot sweep would diverge);
 *  - persist every level through the write-ahead ledger so a crash cannot
 *    silently re-arm the same event.
 *
 * The strategy rules themselves live in `tennis-tail-orchestrator.ts`; this
 * module only wires them to feeds and the executor so it can be exercised with
 * fakes in tests.
 */
import type { OrderbookSnapshot, BuyTradeDecision, TradeResult } from "../domain/types.js";
import type { TennisPointPollResult, TennisPointsPollTarget } from "../collector/tennis-points.js";
import { sportsTakerFeePerShare, netReturnRate } from "../domain/fees.js";
import type { LiveLedger } from "../persistence/ledger.js";
import {
  isTennisTailEntry,
  orderbookBestBid,
  planTennisTailLadder,
  resolveTennisTailToken,
  type TennisTailLadderConfig,
  type TennisTailLadderPlan,
  type TennisTailLevelPlan,
  type TennisTailMarket,
  type TennisTailPlanResult
} from "./tennis-tail-orchestrator.js";
import type { LiveExecuteOptions, LiveRestingLevel, LiveOrderType } from "./live-executor.js";

/** A discovered tennis event with its moneyline market(s). */
export interface TennisTailEvent {
  eventSlug: string;
  eventTitle: string;
  markets: readonly TennisTailMarket[];
}

export interface TennisTailArmRecord {
  kind: "armed" | "skipped" | "error";
  eventSlug: string;
  details: string;
  plan?: TennisTailLadderPlan;
  results?: TradeResult[];
}

export interface TennisTailLiveDeps {
  discover: () => Promise<readonly TennisTailEvent[]>;
  pollPoints: (targets: readonly TennisPointsPollTarget[]) => Promise<readonly TennisPointPollResult[]>;
  fetchOrderbook: (tokenId: string) => Promise<OrderbookSnapshot>;
  /** Required unless `dryRun` is set. */
  placeLadder?: (levels: readonly LiveRestingLevel[], options: LiveExecuteOptions) => Promise<TradeResult[]>;
  ledger?: LiveLedger;
  /** Read-only venue reconciliation of previously posted resting bids. */
  reconcile?: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (record: TennisTailArmRecord) => void | Promise<void>;
}

export interface TennisTailLiveOptions {
  config: TennisTailLadderConfig;
  orderType?: LiveOrderType;
  restSeconds?: number;
  postOnly?: boolean;
  dryRun: boolean;
  intervalMs: number;
  maxIterations?: number;
  /**
   * Safety cap on how many times one event may be re-swept while Gen1 holds.
   * The default covers a full hour at the 15s poll cadence; the sweep normally
   * stops early once every qualifying level is resting or the cap is reached.
   */
  maxSweepsPerEvent?: number;
  /** Iterations between read-only reconciliations of resting bids (default 8). */
  reconcileEveryIterations?: number;
}

export interface TennisTailLiveSummary {
  iterations: number;
  discoveredEvents: number;
  /** One entry per sweep that placed at least one new level. */
  armed: TennisTailLadderPlan[];
  /** Total resting levels submitted (or planned, in dry-run) across all sweeps. */
  levelsPlaced: number;
  skipped: number;
  errors: number;
}

interface EventArmState {
  /** Ladder prices already resting or planned for this event/token. */
  placedPrices: Set<number>;
  sweeps: number;
  done: boolean;
  /** Last skip reason, so a 15s poll does not repeat the same log line. */
  lastSkip?: string;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_SWEEPS = 240;

export async function runTennisTailWatch(
  deps: TennisTailLiveDeps,
  options: TennisTailLiveOptions
): Promise<TennisTailLiveSummary> {
  if (!options.dryRun && !deps.placeLadder) {
    throw new Error("TENNIS_TAIL_LIVE_EXECUTOR_REQUIRED: non-dry-run watch needs placeLadder");
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const maxSweepsPerEvent = options.maxSweepsPerEvent ?? DEFAULT_MAX_SWEEPS;
  const reconcileEveryIterations = options.reconcileEveryIterations ?? 8;
  const states = new Map<string, EventArmState>();
  const summary: TennisTailLiveSummary = {
    iterations: 0,
    discoveredEvents: 0,
    armed: [],
    levelsPlaced: 0,
    skipped: 0,
    errors: 0
  };

  while (summary.iterations < maxIterations) {
    summary.iterations += 1;
    if (deps.reconcile && (summary.iterations - 1) % reconcileEveryIterations === 0) {
      try {
        await deps.reconcile();
      } catch (error) {
        summary.errors += 1;
        await emit(deps, { kind: "error", eventSlug: "-", details: `reconcile failed: ${describe(error)}` });
      }
    }
    let events: readonly TennisTailEvent[];
    try {
      events = await deps.discover();
    } catch (error) {
      summary.errors += 1;
      await emit(deps, { kind: "error", eventSlug: "-", details: `discovery failed: ${describe(error)}` });
      if (summary.iterations >= maxIterations) break;
      await sleep(options.intervalMs >= 0 ? options.intervalMs : DEFAULT_INTERVAL_MS);
      continue;
    }
    summary.discoveredEvents = events.length;
    const bySlug = new Map(events.map((event) => [event.eventSlug, event]));
    const targets: TennisPointsPollTarget[] = events.map((event) => ({
      eventSlug: event.eventSlug,
      title: event.eventTitle
    }));

    if (targets.length > 0) {
      let frames: readonly TennisPointPollResult[];
      try {
        frames = await deps.pollPoints(targets);
      } catch (error) {
        summary.errors += 1;
        await emit(deps, { kind: "error", eventSlug: "-", details: `poll failed: ${describe(error)}` });
        frames = [];
      }
      for (const frame of frames) {
        const state = states.get(frame.eventSlug) ?? { placedPrices: new Set<number>(), sweeps: 0, done: false };
        states.set(frame.eventSlug, state);
        if (state.done) continue;
        const event = bySlug.get(frame.eventSlug);
        if (!event) continue;
        await sweepEvent(deps, options, event, frame, state, summary, now, maxSweepsPerEvent);
      }
    }

    if (summary.iterations >= maxIterations) break;
    await sleep(options.intervalMs >= 0 ? options.intervalMs : DEFAULT_INTERVAL_MS);
  }

  return summary;
}

async function sweepEvent(
  deps: TennisTailLiveDeps,
  options: TennisTailLiveOptions,
  event: TennisTailEvent,
  frame: TennisPointPollResult,
  state: EventArmState,
  summary: TennisTailLiveSummary,
  now: () => number,
  maxSweeps: number
): Promise<void> {
  const signal = frame.signal;
  if (!signal || !isTennisTailEntry(signal)) return; // nothing to arm; resting levels stay put
  const market = event.markets.find((candidate) => candidate.marketType === "moneyline");
  if (!market) {
    state.done = true;
    await recordSkip(deps, summary, event.eventSlug, "no moneyline market for event");
    return;
  }
  if (state.sweeps >= maxSweeps) {
    state.done = true;
    await recordSkip(deps, summary, event.eventSlug, `sweep cap reached (${maxSweeps})`);
    return;
  }
  state.sweeps += 1;

  const resolved = resolveTennisTailToken(market, frame.frame, signal.favored);
  if (!resolved) {
    state.done = true;
    await recordSkip(deps, summary, event.eventSlug, "no outcome maps to the 365Scores favoured side");
    return;
  }

  // Durable level memory: a restart between two sweeps must not re-place a
  // level that is already resting on the venue.
  if (deps.ledger) {
    for (const price of await placedLadderPrices(deps.ledger, event.eventSlug, resolved.tokenId)) {
      state.placedPrices.add(price);
    }
  }

  let orderbook: OrderbookSnapshot;
  let otherBestBid: number | undefined;
  try {
    orderbook = await deps.fetchOrderbook(resolved.tokenId);
    const otherTokenId = market.tokenIds[1 - resolved.outcomeIndex];
    if (typeof otherTokenId === "string" && otherTokenId.length > 0) {
      const other = await deps.fetchOrderbook(otherTokenId).catch(() => undefined);
      if (other) otherBestBid = orderbookBestBid(other);
    }
  } catch (error) {
    summary.errors += 1;
    await emit(deps, { kind: "error", eventSlug: event.eventSlug, details: `orderbook failed: ${describe(error)}` });
    return;
  }

  const committed = await committedNotional(deps.ledger, event.eventSlug, now());
  const planned: TennisTailPlanResult = planTennisTailLadder({
    market,
    frame: frame.frame,
    signal,
    orderbook,
    config: options.config,
    committedEventNotional: committed.event,
    committedDayNotional: committed.day,
    alreadyPlacedPrices: [...state.placedPrices],
    ...(otherBestBid !== undefined ? { otherBestBid } : {})
  });

  if (planned.action === "SKIP") {
    if (planned.reason === "NOT_GEN1") return; // not an entry state; nothing to report
    if (planned.reason === "NO_NEW_LEVELS") {
      // Every level restable *right now* is already resting, but the backtest
      // arms each level at its own first qualifying second: a quiet poll must
      // not stop a higher level that can still become restable before the set
      // ends. The per-event sweep cap bounds the retries.
      return;
    }
    if (planned.reason === "BUDGET_EXHAUSTED" || planned.reason === "MARKET_NOT_MONEYLINE" || planned.reason === "NO_MATCHING_TOKEN") {
      state.done = true;
      await recordSkip(deps, summary, event.eventSlug, `${planned.reason}: ${planned.details}`, state);
      return;
    }
    // ORDERBOOK_UNRESTABLE / NOT_MARKET_LEADER: the backtest arms each level at
    // its own first qualifying second, so keep sweeping on later polls.
    await recordSkip(deps, summary, event.eventSlug, `${planned.reason}: ${planned.details}`, state);
    return;
  }

  summary.armed.push(planned.plan);
  summary.levelsPlaced += planned.plan.levels.length;
  delete state.lastSkip;

  if (options.dryRun) {
    for (const level of planned.plan.levels) state.placedPrices.add(Number(level.price.toFixed(6)));
    await emit(deps, { kind: "armed", eventSlug: event.eventSlug, details: "dry-run", plan: planned.plan });
    return;
  }

  try {
    const { results, placedPrices } = await submitLadder(deps, options, planned.plan);
    for (const price of placedPrices) state.placedPrices.add(price);
    await emit(deps, { kind: "armed", eventSlug: event.eventSlug, details: "submitted", plan: planned.plan, results });
  } catch (error) {
    summary.errors += 1;
    await emit(deps, {
      kind: "error",
      eventSlug: event.eventSlug,
      details: `ladder submit failed: ${describe(error)}`,
      plan: planned.plan
    });
  }
}

/**
 * Ladder prices already resting (or filled) for this event/token. Rejected
 * submissions never reached the book, so they stay eligible for a re-sweep.
 */
async function placedLadderPrices(ledger: LiveLedger, eventSlug: string, tokenId: string): Promise<number[]> {
  const entries = await ledger.readEntries();
  const prices = new Set<number>();
  for (const entry of entries) {
    if (entry.eventSlug !== eventSlug || entry.tokenId !== tokenId) continue;
    if (entry.status === "rejected") continue;
    if (!Number.isFinite(entry.price) || entry.price <= 0) continue;
    prices.add(Number(entry.price.toFixed(6)));
  }
  return [...prices];
}

async function submitLadder(
  deps: TennisTailLiveDeps,
  options: TennisTailLiveOptions,
  plan: TennisTailLadderPlan
): Promise<{ results: TradeResult[]; placedPrices: number[] }> {
  const levels: LiveRestingLevel[] = plan.levels.map((level) => ({
    tokenId: plan.tokenId,
    price: level.price,
    shares: level.shares,
    notional: level.notional,
    tickSize: plan.tickSize,
    negRisk: plan.negRisk,
    eventSlug: plan.eventSlug,
    marketSlug: plan.marketSlug,
    conditionId: plan.conditionId,
    outcome: plan.outcome
  }));

  const ledger = deps.ledger;
  const pendingIds: string[] = [];
  if (ledger) {
    for (const level of plan.levels) {
      pendingIds.push(await ledger.recordPendingSubmission(levelDecision(plan, level), "live"));
    }
  }

  const executeOptions: LiveExecuteOptions = {
    orderType: options.orderType ?? "GTC",
    postOnly: options.postOnly ?? true
  };
  if (options.restSeconds !== undefined) executeOptions.restSeconds = options.restSeconds;
  let results: TradeResult[];
  try {
    results = await deps.placeLadder!(levels, executeOptions);
  } catch (error) {
    if (ledger) for (const pendingId of pendingIds) await ledger.discardPendingSubmission(pendingId);
    throw error;
  }

  if (ledger) {
    for (let index = 0; index < plan.levels.length; index += 1) {
      const level = plan.levels[index]!;
      const result = results[index];
      if (!result) continue;
      await ledger.recordResult(levelDecision(plan, level), result, new Date(), pendingIds[index]);
    }
  }
  // A level the venue refused never reached the book, so it stays eligible for
  // the next sweep; everything else counts as resting.
  const placedPrices = plan.levels
    .filter((_level, index) => results[index] !== undefined && results[index]!.status !== "rejected")
    .map((level) => Number(level.price.toFixed(6)));
  return { results, placedPrices };
}

function levelDecision(plan: TennisTailLadderPlan, level: TennisTailLevelPlan): BuyTradeDecision {
  return {
    action: "BUY",
    eventSlug: plan.eventSlug,
    marketSlug: plan.marketSlug,
    question: `${plan.eventTitle} moneyline`,
    tokenId: plan.tokenId,
    conditionId: plan.conditionId,
    outcome: plan.outcome,
    bestAsk: level.price,
    availableSize: level.shares,
    shares: level.shares,
    notional: level.notional,
    estimatedFee: level.shares * sportsTakerFeePerShare(level.price),
    estimatedNetReturn: netReturnRate(level.price),
    tickSize: plan.tickSize,
    negRisk: plan.negRisk
  };
}

async function committedNotional(
  ledger: LiveLedger | undefined,
  eventSlug: string,
  nowMs: number
): Promise<{ event: number; day: number }> {
  if (!ledger) return { event: 0, day: 0 };
  const entries = await ledger.readActiveEntries();
  const dayStart = startOfUtcDay(nowMs);
  let event = 0;
  let day = 0;
  for (const entry of entries) {
    const notional = entryNotional(entry);
    if (entry.eventSlug === eventSlug) event += notional;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at) || at >= dayStart) day += notional;
  }
  return { event, day };
}

function entryNotional(entry: { notional?: number; reservedNotional?: number }): number {
  const reserved = Number.isFinite(entry.reservedNotional) ? entry.reservedNotional! : 0;
  const filled = Number.isFinite(entry.notional) ? entry.notional! : 0;
  return Math.max(filled, reserved);
}

function startOfUtcDay(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function recordSkip(
  deps: TennisTailLiveDeps,
  summary: TennisTailLiveSummary,
  eventSlug: string,
  details: string,
  state?: EventArmState
): Promise<void> {
  summary.skipped += 1;
  // Waiting for a level to become restable is the normal case; only report the
  // transition so a long Gen1 does not write the same line every poll.
  if (state && state.lastSkip === details) return;
  if (state) state.lastSkip = details;
  await emit(deps, { kind: "skipped", eventSlug, details });
}

async function emit(deps: TennisTailLiveDeps, record: TennisTailArmRecord): Promise<void> {
  if (deps.onRecord) await deps.onRecord(record);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
