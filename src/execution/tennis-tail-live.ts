/**
 * Live/dry-run watch loop for the tennis tail ladder.
 *
 * Responsibilities kept here (the I/O shell):
 *  - discover the live tennis moneyline markets;
 *  - read the latest Polymarket sports-feed score for each event (the same
 *    game-granularity feed the backtest replayed) and derive Gen1 with the
 *    shared `src/domain/tennis-gen1.ts` rule;
 *  - while Gen1 holds, sweep the ladder at a bounded cadence and immediately
 *    after every score update, submitting missing levels as they become
 *    restable (the backtest arms each level at its own first qualifying
 *    snapshot, so a single one-shot sweep would diverge);
 *  - persist every level through the write-ahead ledger so a crash cannot
 *    silently re-arm the same event.
 *
 * The strategy rules themselves live in `tennis-tail-orchestrator.ts`; this
 * module only wires them to feeds and the executor so it can be exercised with
 * fakes in tests.
 */
import type { OrderbookSnapshot, BuyTradeDecision, TradeResult } from "../domain/types.js";
import { sportsTakerFeePerShare, netReturnRate } from "../domain/fees.js";
import { tennisGen1, type TennisGen1Decision } from "../domain/tennis-gen1.js";
import type { LiveLedger } from "../persistence/ledger.js";
import {
  orderbookBestBid,
  planTennisTailFromScore,
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
  /** Polymarket sports-feed game id; the score board is keyed by it. */
  gameId: string;
  /**
   * Winner's set target: 2 for best-of-three (every archived sample), 3 for
   * best-of-five. Grand Slam men's events are excluded by discovery instead.
   */
  setsToWin?: number;
  markets: readonly TennisTailMarket[];
}

/**
 * One score observation from the sports feed, as the live loop sees it.
 * `observedAtMs` is when this score first became visible (the moment the
 * backtest would have used it); `receivedAtMs` is the last repeat of the same
 * score, which keeps liveness detection honest across long games.
 */
export interface TennisTailScoreObservation {
  score: string;
  homeName: string;
  awayName: string;
  observedAtMs: number;
  receivedAtMs: number;
  live: boolean;
  ended: boolean;
}

/**
 * Periodic liveness snapshot. A discovered event that never produces a score
 * frame (game-id mismatch, feed outage) is otherwise invisible: nothing is
 * armed and nothing is logged, so the operator cannot tell monitoring apart
 * from a silent miss.
 */
export interface TennisTailHeartbeat {
  iterations: number;
  discovered: number;
  /** Discovered events with a score observation this iteration. */
  polled: number;
  /** Discovered events whose score frame arrived within the staleness window. */
  monitored: number;
  levelsPlaced: number;
  /** Discovered events that have never produced a score frame. */
  neverPolled: readonly string[];
  /** Events whose last score frame is older than the staleness window. */
  stale: readonly string[];
}

/**
 * Latency of one arm, in the same clock as `observation.observedAtMs` (the
 * moment the sports feed first published that score). The backtest arms on the
 * archived book-snapshot grid with the same score; these fields measure how far
 * the live path is from that grid on every real arm.
 */
export interface TennisTailArmTiming {
  scoreObservedAtMs: number;
  sweepStartedAtMs: number;
  /** How old the score observation was when its sweep started. */
  signalAgeMs: number;
  /** The sports-feed score the arm was decided on. */
  score: string;
  /** `game` for 5-x / 6-5, `tiebreak` for a 6-6 set. */
  gen1Kind: "game" | "tiebreak";
  /** Sweep start -> order book snapshot(s) available. */
  orderbookMs: number;
  /** Sweep start -> arm emitted. */
  sweepMs: number;
  /** Sweep start -> ladder submission settled (live only). */
  submitMs?: number;
}

export interface TennisTailArmRecord {
  kind: "armed" | "skipped" | "error" | "heartbeat";
  eventSlug: string;
  details: string;
  plan?: TennisTailLadderPlan;
  results?: TradeResult[];
  heartbeat?: TennisTailHeartbeat;
  timing?: TennisTailArmTiming;
}

export interface TennisTailLiveDeps {
  discover: () => Promise<readonly TennisTailEvent[]>;
  /** Latest sports-feed score for one game id, when the feed has delivered it. */
  latestScore: (gameId: string) => TennisTailScoreObservation | undefined;
  /** Restricts feed wake-ups to the discovered events. */
  selectScoreGameIds?: (gameIds: readonly string[]) => void;
  /**
   * Monotonic score-feed revision. Together with `waitForScore` this lets the
   * loop sweep immediately when a monitored score changes and re-run without
   * sleeping when an update lands mid-sweep.
   */
  scoreVersion?: () => number;
  /** Resolves on the next monitored score change, or after `timeoutMs`. */
  waitForScore?: (sinceVersion: number, timeoutMs: number) => Promise<void>;
  /** When it flips true the loop finishes the current sweep and returns. */
  shouldStop?: () => boolean;
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
  /**
   * Book sweep cadence while Gen1 holds. The archived book snapshots arrived
   * at p50 ~20s; sweeping faster can only arm earlier, never later.
   */
  intervalMs: number;
  /** How often discovery re-reads Gamma (default 30s). */
  discoveryIntervalMs?: number;
  maxIterations?: number;
  /**
   * Safety cap on how many times one event may be re-swept while Gen1 holds.
   * The default covers a full hour at the 10s scan cadence; the sweep normally
   * stops early once every qualifying level is resting or the cap is reached.
   */
  maxSweepsPerEvent?: number;
  /** Iterations between read-only reconciliations of resting bids (default 8). */
  reconcileEveryIterations?: number;
  /** Iterations between liveness heartbeats; 0 disables them (default 20). */
  heartbeatEveryIterations?: number;
  /** How long an event may go without a score frame before it is reported stale. */
  heartbeatStaleMs?: number;
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
  /** Last skip reason, so a 10s sweep does not repeat the same log line. */
  lastSkip?: string;
  /** `observedAtMs` of the score the last sweep was decided on. */
  lastScoreAtMs: number;
  /** Wall-clock deadline of the next cadence sweep while Gen1 holds. */
  nextScanAtMs: number;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 30_000;
const DEFAULT_MAX_SWEEPS = 240;
const DEFAULT_HEARTBEAT_ITERATIONS = 20;
const DEFAULT_HEARTBEAT_STALE_MS = 180_000;
// A timer that fires a few milliseconds early must not push the next sweep a
// whole cadence into the future.
const SCAN_TIMER_GRACE_MS = 100;

export async function runTennisTailWatch(
  deps: TennisTailLiveDeps,
  options: TennisTailLiveOptions
): Promise<TennisTailLiveSummary> {
  if (!options.dryRun && !deps.placeLadder) {
    throw new Error("TENNIS_TAIL_LIVE_EXECUTOR_REQUIRED: non-dry-run watch needs placeLadder");
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const scanIntervalMs = options.intervalMs >= 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const discoveryIntervalMs = options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS;
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const maxSweepsPerEvent = options.maxSweepsPerEvent ?? DEFAULT_MAX_SWEEPS;
  const reconcileEveryIterations = options.reconcileEveryIterations ?? 8;
  const heartbeatEveryIterations = options.heartbeatEveryIterations ?? DEFAULT_HEARTBEAT_ITERATIONS;
  const heartbeatStaleMs = options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const states = new Map<string, EventArmState>();
  /** eventSlug -> timestamp of its last score frame; 0 means never matched. */
  const monitoring = new Map<string, number>();
  let events: readonly TennisTailEvent[] = [];
  let nextDiscoveryAtMs = Number.NEGATIVE_INFINITY;
  // Reconciliation is read-only venue I/O whose results only matter to the next
  // sweep. Run it in the background so a slow venue read cannot delay the
  // signal -> book -> order critical path (the backtest has no such step).
  let reconcileInFlight: Promise<void> | undefined;
  const kickReconcile = (): void => {
    const reconcile = deps.reconcile;
    if (!reconcile || reconcileInFlight) return;
    reconcileInFlight = Promise.resolve()
      .then(() => reconcile())
      .catch(async (error) => {
        summary.errors += 1;
        await emit(deps, { kind: "error", eventSlug: "-", details: `reconcile failed: ${describe(error)}` });
      })
      .finally(() => { reconcileInFlight = undefined; });
  };
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
    if (deps.reconcile && (summary.iterations - 1) % reconcileEveryIterations === 0) kickReconcile();
    const iterationStartedAtMs = now();
    if (iterationStartedAtMs >= nextDiscoveryAtMs) {
      try {
        events = await deps.discover();
      } catch (error) {
        summary.errors += 1;
        await emit(deps, { kind: "error", eventSlug: "-", details: `discovery failed: ${describe(error)}` });
        if (summary.iterations >= maxIterations) break;
        await sleep(scanIntervalMs);
        continue;
      }
      summary.discoveredEvents = events.length;
      nextDiscoveryAtMs = iterationStartedAtMs + discoveryIntervalMs;
      deps.selectScoreGameIds?.(events.map((event) => event.gameId));
      for (const event of events) {
        if (!monitoring.has(event.eventSlug)) monitoring.set(event.eventSlug, 0);
      }
    }

    const versionBeforeSweeps = deps.scoreVersion?.() ?? 0;
    const sweepStartedAtMs = now();
    for (const event of events) {
      const state = states.get(event.eventSlug)
        ?? { placedPrices: new Set<number>(), sweeps: 0, done: false, lastScoreAtMs: 0, nextScanAtMs: 0 };
      states.set(event.eventSlug, state);
      const observation = deps.latestScore(event.gameId);
      if (!observation) continue;
      monitoring.set(event.eventSlug, observation.receivedAtMs);
      if (state.done || observation.ended) continue;
      const scoreChanged = observation.observedAtMs > state.lastScoreAtMs;
      const cadenceDue = sweepStartedAtMs + SCAN_TIMER_GRACE_MS >= state.nextScanAtMs;
      if (!scoreChanged && !cadenceDue) continue;
      state.lastScoreAtMs = Math.max(state.lastScoreAtMs, observation.observedAtMs);
      state.nextScanAtMs = sweepStartedAtMs + scanIntervalMs;
      await sweepEvent(deps, options, event, observation, state, summary, now, maxSweepsPerEvent);
    }

    if (heartbeatEveryIterations > 0 && summary.iterations % heartbeatEveryIterations === 0) {
      const observedAt = now();
      const neverPolled: string[] = [];
      const stale: string[] = [];
      let polled = 0;
      for (const event of events) {
        const lastFrameAt = monitoring.get(event.eventSlug) ?? 0;
        if (lastFrameAt > 0) polled += 1;
        if (lastFrameAt === 0) neverPolled.push(event.eventSlug);
        else if (observedAt - lastFrameAt > heartbeatStaleMs) stale.push(event.eventSlug);
      }
      const monitored = events.length - neverPolled.length - stale.length;
      await emit(deps, {
        kind: "heartbeat",
        eventSlug: "-",
        details: `monitoring ${monitored}/${events.length} events; ${polled} with a score frame; ${neverPolled.length} never matched a sports game; ${stale.length} stale`,
        heartbeat: {
          iterations: summary.iterations,
          discovered: events.length,
          polled,
          monitored,
          levelsPlaced: summary.levelsPlaced,
          neverPolled,
          stale
        }
      });
    }

    // A signal handler can end the watch after the in-flight sweep settles;
    // resting orders are intentionally left on the book.
    if (deps.shouldStop?.()) break;
    if (summary.iterations >= maxIterations) break;
    const discoveryDueInMs = Math.max(0, nextDiscoveryAtMs - now());
    const sleepMs = Math.max(0, Math.min(scanIntervalMs, discoveryDueInMs));
    const versionAfterSweeps = deps.scoreVersion?.() ?? 0;
    if (versionAfterSweeps !== versionBeforeSweeps) continue; // score landed mid-sweep
    if (deps.waitForScore) {
      await Promise.race([
        sleep(sleepMs),
        deps.waitForScore(versionAfterSweeps, sleepMs)
      ]);
    } else {
      await sleep(sleepMs);
    }
  }

  return summary;
}

async function sweepEvent(
  deps: TennisTailLiveDeps,
  options: TennisTailLiveOptions,
  event: TennisTailEvent,
  observation: TennisTailScoreObservation,
  state: EventArmState,
  summary: TennisTailLiveSummary,
  now: () => number,
  maxSweeps: number
): Promise<void> {
  const setsToWin = event.setsToWin ?? 2;
  const sweepStartedAtMs = now();
  // The shared Gen1 rule decides whether there is anything to arm at all; a
  // non-Gen1 score stays silent and resting levels stay put.
  const decision = tennisGen1(observation.score, setsToWin);
  if (!decision) return;
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

  const header = { homeName: observation.homeName, awayName: observation.awayName };
  // Resolve the favoured token before fetching books: the backtest's Gen1 rule
  // names the side, the title/outcome mapping names the token.
  const resolved = resolveDecisionToken(market, header, decision);
  if (!resolved) {
    state.done = true;
    await recordSkip(deps, summary, event.eventSlug, "no outcome maps to the sports-feed favoured side");
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
  let orderbookReadyAtMs = 0;
  try {
    // Both books are only needed for the market-leader check; fetch them in
    // parallel so the critical path pays one round trip, not two.
    const otherTokenId = market.tokenIds[1 - resolved.outcomeIndex];
    const otherBook = typeof otherTokenId === "string" && otherTokenId.length > 0
      ? deps.fetchOrderbook(otherTokenId).catch(() => undefined)
      : Promise.resolve(undefined);
    const [favouredBook, other] = await Promise.all([deps.fetchOrderbook(resolved.tokenId), otherBook]);
    orderbook = favouredBook;
    if (other) otherBestBid = orderbookBestBid(other);
    orderbookReadyAtMs = now();
  } catch (error) {
    summary.errors += 1;
    await emit(deps, { kind: "error", eventSlug: event.eventSlug, details: `orderbook failed: ${describe(error)}` });
    return;
  }

  const committed = await committedNotional(deps.ledger, event.eventSlug, now());
  const planned: TennisTailPlanResult = planTennisTailFromScore({
    market,
    score: observation.score,
    setsToWin,
    homeName: observation.homeName,
    awayName: observation.awayName,
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
      // arms each level at its own first qualifying snapshot: a quiet sweep must
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
    // its own first qualifying snapshot, so keep sweeping on later polls.
    await recordSkip(deps, summary, event.eventSlug, `${planned.reason}: ${planned.details}`, state);
    return;
  }

  summary.armed.push(planned.plan);
  summary.levelsPlaced += planned.plan.levels.length;
  delete state.lastSkip;

  const timing: TennisTailArmTiming = {
    scoreObservedAtMs: observation.observedAtMs,
    sweepStartedAtMs,
    signalAgeMs: Math.max(0, sweepStartedAtMs - observation.observedAtMs),
    score: observation.score,
    gen1Kind: decision.kind,
    orderbookMs: Math.max(0, orderbookReadyAtMs - sweepStartedAtMs),
    sweepMs: Math.max(0, now() - sweepStartedAtMs)
  };

  if (options.dryRun) {
    for (const level of planned.plan.levels) state.placedPrices.add(Number(level.price.toFixed(6)));
    await emit(deps, { kind: "armed", eventSlug: event.eventSlug, details: "dry-run", plan: planned.plan, timing });
    return;
  }

  try {
    const { results, placedPrices } = await submitLadder(deps, options, planned.plan);
    for (const price of placedPrices) state.placedPrices.add(price);
    timing.submitMs = Math.max(0, now() - sweepStartedAtMs);
    await emit(deps, { kind: "armed", eventSlug: event.eventSlug, details: "submitted", plan: planned.plan, results, timing });
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

/** Token for a Gen1 decision's favoured side, when the title maps exactly one. */
function resolveDecisionToken(
  market: TennisTailMarket,
  header: { homeName: string; awayName: string },
  decision: TennisGen1Decision
): { tokenId: string; outcome: string; outcomeIndex: number } | null {
  return resolveTennisTailToken(market, header, decision.side);
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
  // transition so a long Gen1 does not write the same line every sweep.
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
