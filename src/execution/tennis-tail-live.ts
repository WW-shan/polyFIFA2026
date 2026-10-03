/**
 * Live/dry-run watch loop for the tennis tail ladder.
 *
 * Responsibilities kept here (the I/O shell):
 *  - discover the live tennis moneyline markets;
 *  - poll 365Scores point frames for those events;
 *  - on the first Gen1 frame, plan the passive ladder and submit it;
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
  /** Poll attempts allowed to arm one Gen1 event before giving up for this run. */
  maxArmAttempts?: number;
  /** Iterations between read-only reconciliations of resting bids (default 8). */
  reconcileEveryIterations?: number;
}

export interface TennisTailLiveSummary {
  iterations: number;
  discoveredEvents: number;
  armed: TennisTailLadderPlan[];
  skipped: number;
  errors: number;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_ARM_ATTEMPTS = 4;

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
  const maxArmAttempts = options.maxArmAttempts ?? DEFAULT_MAX_ARM_ATTEMPTS;
  const reconcileEveryIterations = options.reconcileEveryIterations ?? 8;
  const armed = new Set<string>();
  const attempts = new Map<string, number>();
  const summary: TennisTailLiveSummary = {
    iterations: 0,
    discoveredEvents: 0,
    armed: [],
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
        if (armed.has(frame.eventSlug)) continue;
        if ((attempts.get(frame.eventSlug) ?? 0) >= maxArmAttempts) continue;
        const event = bySlug.get(frame.eventSlug);
        if (!event) continue;
        await armEvent(deps, options, event, frame, armed, attempts, summary, now);
      }
    }

    if (summary.iterations >= maxIterations) break;
    await sleep(options.intervalMs >= 0 ? options.intervalMs : DEFAULT_INTERVAL_MS);
  }

  return summary;
}

async function armEvent(
  deps: TennisTailLiveDeps,
  options: TennisTailLiveOptions,
  event: TennisTailEvent,
  frame: TennisPointPollResult,
  armed: Set<string>,
  attempts: Map<string, number>,
  summary: TennisTailLiveSummary,
  now: () => number
): Promise<void> {
  const signal = frame.signal;
  if (!signal) return;
  const market = event.markets.find((candidate) => candidate.marketType === "moneyline");
  if (!market) {
    await recordSkip(deps, summary, event.eventSlug, "no moneyline market for event");
    return;
  }
  const resolved = resolveTennisTailToken(market, frame.frame, signal.favored);
  if (!resolved) {
    await recordSkip(deps, summary, event.eventSlug, "no outcome maps to the 365Scores favoured side");
    return;
  }
  attempts.set(event.eventSlug, (attempts.get(event.eventSlug) ?? 0) + 1);

  let orderbook: OrderbookSnapshot;
  try {
    orderbook = await deps.fetchOrderbook(resolved.tokenId);
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
    committedDayNotional: committed.day
  });

  if (planned.action === "SKIP") {
    if (planned.reason === "NOT_GEN1") return; // not an entry state; nothing to report
    await recordSkip(deps, summary, event.eventSlug, `${planned.reason}: ${planned.details}`);
    return;
  }

  // Mark armed before submitting: a crash mid-submit must not re-arm the same
  // event on the next poll. The write-ahead ledger is the durable backstop.
  armed.add(event.eventSlug);
  summary.armed.push(planned.plan);

  if (options.dryRun) {
    await emit(deps, { kind: "armed", eventSlug: event.eventSlug, details: "dry-run", plan: planned.plan });
    return;
  }

  try {
    const results = await submitLadder(deps, options, planned.plan);
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

async function submitLadder(
  deps: TennisTailLiveDeps,
  options: TennisTailLiveOptions,
  plan: TennisTailLadderPlan
): Promise<TradeResult[]> {
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
  return results;
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
  details: string
): Promise<void> {
  summary.skipped += 1;
  await emit(deps, { kind: "skipped", eventSlug, details });
}

async function emit(deps: TennisTailLiveDeps, record: TennisTailArmRecord): Promise<void> {
  if (deps.onRecord) await deps.onRecord(record);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
