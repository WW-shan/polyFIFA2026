import { netReturnRate } from "../../domain/fees.js";
import type { OrderbookSnapshot } from "../../domain/types.js";
import { findGame, liveStateOf, type EspnGame, type EspnSummary } from "./espn.js";
import { linkMarketToGame, type MarketBook, type ShadowLeague, type ShadowMarketRef } from "./market.js";
import { evaluateLateScoreSignal, walkBook, type BookFill, type LateScoreModel, type LateScoreSignalEvaluation } from "./model.js";

export interface ShadowMonitorOptions {
  league: ShadowLeague;
  model: LateScoreModel;
  /** Must be true; the monitor refuses to run otherwise. */
  shadowOnly: boolean;
  pollIntervalMs: number;
  idlePollIntervalMs: number;
  discoveryIntervalMs: number;
  recordWindowSeconds: number;
  windowSeconds: number;
  minProbability: number;
  minEdge: number;
  limitOffset: number;
  maxPrice: number;
  shares: number;
  delaySeconds: number;
  followupWindowSeconds: number;
  followupStepSeconds: number;
  heartbeatIntervalMs: number;
  lookbackHours: number;
  aheadHours: number;
  maxIterations?: number;
  durationMs?: number;
}

export interface ShadowMonitorDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  discoverMarkets: (league: ShadowLeague, window: { lookbackHours: number; aheadHours: number }) => Promise<ShadowMarketRef[]>;
  fetchScoreboard: (league: ShadowLeague, date: string) => Promise<EspnGame[]>;
  fetchSummary: (league: ShadowLeague, espnId: string) => Promise<EspnSummary>;
  fetchBook: (tokenId: string) => Promise<MarketBook>;
  sink: (record: Record<string, unknown>) => void | Promise<void>;
  log?: (message: string) => void;
}

export interface TrackedSignal {
  signalId: string;
  side: "home" | "away";
  tokenId: string;
  firedAtMs: number;
  state: { period: number; clockSeconds: number; clock: string; homeScore: number; awayScore: number };
  limitPrice: number;
  evaluation: LateScoreSignalEvaluation;
  followupsSent: number;
}

export interface TrackedGame {
  key: string;
  market: ShadowMarketRef;
  espnId: string | null;
  homeIndex: 0 | 1 | null;
  tokens: { home: string; away: string } | null;
  nextPollAtMs: number;
  lastHeartbeatAtMs: number;
  lastLinkErrorAtMs: number;
  lastBookErrorAtMs: number;
  signals: TrackedSignal[];
  settled: boolean;
}

export interface ShadowRunState {
  startedAtMs: number;
  iteration: number;
  lastDiscoveryAtMs: number | null;
  tracked: Map<string, TrackedGame>;
  signalCount: number;
}

export interface ShadowRunSummary {
  iterations: number;
  trackedGames: number;
  signals: number;
  startedAtMs: number;
  endedAtMs: number;
}

export function createRunState(startedAtMs: number): ShadowRunState {
  return { startedAtMs, iteration: 0, lastDiscoveryAtMs: null, tracked: new Map(), signalCount: 0 };
}

const LINK_ERROR_INTERVAL_MS = 10 * 60 * 1000;
const BOOK_ERROR_INTERVAL_MS = 60 * 1000;

export const DEFAULT_SHADOW_OPTIONS = {
  pollIntervalMs: 5_000,
  idlePollIntervalMs: 30_000,
  discoveryIntervalMs: 60_000,
  recordWindowSeconds: 900,
  windowSeconds: 180,
  minProbability: 0.9,
  minEdge: 0.03,
  limitOffset: 0.01,
  maxPrice: 0.99,
  shares: 5,
  delaySeconds: 30,
  followupWindowSeconds: 60,
  followupStepSeconds: 15,
  heartbeatIntervalMs: 60_000,
  lookbackHours: 6,
  aheadHours: 2
} as const;

function nowOf(deps: ShadowMonitorDeps): () => number {
  return deps.now ?? Date.now;
}

async function emit(deps: ShadowMonitorDeps, nowMs: number, record: Record<string, unknown>): Promise<void> {
  await deps.sink({
    schemaVersion: 1,
    shadowOnly: true,
    at: new Date(nowMs).toISOString(),
    atMs: nowMs,
    ...record
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gameKey(market: ShadowMarketRef): string {
  return `${market.league}:${market.eventSlug}`;
}

const ET_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function candidateDates(startMs: number): string[] {
  const compact = (value: string): string => value.replace(/-/g, "");
  const dates = [
    compact(ET_FORMAT.format(new Date(startMs))),
    new Date(startMs).toISOString().slice(0, 10).replace(/-/g, ""),
    new Date(startMs - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "")
  ];
  return [...new Set(dates)];
}

function remainingSeconds(league: ShadowLeague, state: { period: number; clockSeconds: number }): number {
  return state.period <= league.finalPeriod
    ? Math.max(0, (league.finalPeriod - state.period) * league.periodSeconds + state.clockSeconds)
    : Math.max(0, state.clockSeconds);
}

function emptyBook(tokenId: string): OrderbookSnapshot {
  return { tokenId, bids: [], asks: [] };
}

function bookSummary(entry: MarketBook | null): Record<string, unknown> | null {
  if (!entry) return null;
  const bid = entry.book.bids[0]?.price ?? null;
  const ask = entry.book.asks[0]?.price ?? null;
  return {
    tokenId: entry.tokenId,
    bestBid: bid,
    bestAsk: ask,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
    askLevels: entry.book.asks.slice(0, 3),
    bidLevels: entry.book.bids.slice(0, 3),
    receivedAtMs: entry.receivedAtMs,
    requestStartedAtMs: entry.requestStartedAtMs,
    roundTripMs: entry.receivedAtMs - entry.requestStartedAtMs,
    bookTimestampMs: entry.bookTimestampMs,
    bookLagMs: entry.bookTimestampMs === null ? null : entry.receivedAtMs - entry.bookTimestampMs
  };
}

function sideSummary(side: LateScoreSignalEvaluation["sides"]["home"]): Record<string, unknown> {
  return {
    fair: side.fair, bid: side.bid, ask: side.ask, mid: side.mid, limit: side.limit,
    edge: side.edge, reason: side.reason, fill: side.fill
  };
}

function totalFollowups(options: ShadowMonitorOptions): number {
  return Math.floor(options.followupWindowSeconds / options.followupStepSeconds) + 1;
}

function followupDueAtMs(signal: TrackedSignal, options: ShadowMonitorOptions): number | null {
  if (signal.followupsSent >= totalFollowups(options)) return null;
  return signal.firedAtMs + (options.delaySeconds + signal.followupsSent * options.followupStepSeconds) * 1000;
}

async function discover(state: ShadowRunState, options: ShadowMonitorOptions, deps: ShadowMonitorDeps, nowMs: number): Promise<void> {
  state.lastDiscoveryAtMs = nowMs;
  let markets: ShadowMarketRef[] = [];
  try {
    markets = await deps.discoverMarkets(options.league, { lookbackHours: options.lookbackHours, aheadHours: options.aheadHours });
  } catch (error) {
    await emit(deps, nowMs, { kind: "error", scope: "discovery", league: options.league.name, message: errorMessage(error) });
    return;
  }
  let added = 0;
  for (const market of markets) {
    const key = gameKey(market);
    if (state.tracked.has(key)) continue;
    state.tracked.set(key, {
      key, market, espnId: null, homeIndex: null, tokens: null,
      nextPollAtMs: nowMs, lastHeartbeatAtMs: 0, lastLinkErrorAtMs: 0, lastBookErrorAtMs: 0, signals: [], settled: false
    });
    added += 1;
  }
  await emit(deps, nowMs, { kind: "discovery", league: options.league.name, markets: markets.length, tracked: state.tracked.size, added });
}

async function scoreboardFor(
  cache: Map<string, Promise<EspnGame[]>>,
  deps: ShadowMonitorDeps,
  league: ShadowLeague,
  date: string
): Promise<EspnGame[]> {
  const key = `${league.name}|${date}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = deps.fetchScoreboard(league, date).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

async function pollGame(state: ShadowRunState, game: TrackedGame, options: ShadowMonitorOptions, deps: ShadowMonitorDeps, nowMs: number, scoreboardCache: Map<string, Promise<EspnGame[]>>): Promise<void> {
  const { league, model } = options;
  const startMs = game.market.startMs ?? nowMs;
  let espn: EspnGame | null = null;
  for (const date of candidateDates(startMs)) {
    let scoreboard: EspnGame[];
    try {
      scoreboard = await scoreboardFor(scoreboardCache, deps, league, date);
    } catch (error) {
      await emit(deps, nowMs, { kind: "error", scope: "scoreboard", key: game.key, date, message: errorMessage(error) });
      continue;
    }
    if (game.espnId !== null) {
      espn = findGame(scoreboard, game.espnId);
      if (espn) break;
      continue;
    }
    const link = linkMarketToGame(game.market, scoreboard);
    if (!link) continue;
    espn = link.game;
    game.espnId = espn.espnId;
    game.homeIndex = link.homeIndex;
    game.tokens = { home: game.market.tokens[link.homeIndex], away: game.market.tokens[link.awayIndex] };
    await emit(deps, nowMs, {
      kind: "game-linked", key: game.key, league: league.name, espnId: espn.espnId, startMs: espn.startMs,
      eventSlug: game.market.eventSlug, eventTitle: game.market.eventTitle, question: game.market.question,
      marketSlug: game.market.marketSlug, conditionId: game.market.conditionId,
      outcomes: game.market.outcomes, homeIndex: link.homeIndex, homeToken: game.tokens.home, awayToken: game.tokens.away
    });
    break;
  }
  if (!espn || !game.tokens) {
    game.nextPollAtMs = nowMs + options.idlePollIntervalMs;
    if (espn === null && nowMs - game.lastLinkErrorAtMs >= LINK_ERROR_INTERVAL_MS) {
      game.lastLinkErrorAtMs = nowMs;
      await emit(deps, nowMs, { kind: "error", scope: "espn-match", key: game.key, message: "no matching ESPN game on candidate dates" });
    }
    return;
  }
  if (espn.status.state === "post" || espn.status.completed) {
    const winner = espn.winner ?? (
      espn.homeScore !== null && espn.awayScore !== null && espn.homeScore !== espn.awayScore
        ? (espn.homeScore > espn.awayScore ? "home" : "away") : null);
    const signals = game.signals.map(signal => {
      const fill = signal.evaluation.sides[signal.side].fill;
      const price = fill.averagePrice;
      const won = winner === null ? null : winner === signal.side;
      const netReturn = won === null || price === null || price <= 0 || price >= 1
        ? null : won ? netReturnRate(price, model.feeRate) : -1;
      return { signalId: signal.signalId, side: signal.side, tokenId: signal.tokenId,
        entry: price, filledShares: fill.filledShares, won, netReturn };
    });
    await emit(deps, nowMs, {
      kind: "settlement", key: game.key, league: league.name, espnId: espn.espnId,
      marketSlug: game.market.marketSlug, conditionId: game.market.conditionId,
      final: { homeScore: espn.homeScore, awayScore: espn.awayScore, winner },
      signals, signalCount: signals.length
    });
    game.settled = true;
    return;
  }
  const live = liveStateOf(espn);
  if (!live) {
    game.nextPollAtMs = nowMs + options.idlePollIntervalMs;
    return;
  }
  const remaining = remainingSeconds(league, live);
  const inRecordWindow = remaining <= options.recordWindowSeconds;
  game.nextPollAtMs = nowMs + (inRecordWindow ? options.pollIntervalMs : options.idlePollIntervalMs);

  let homeBook: MarketBook | null = null;
  let awayBook: MarketBook | null = null;
  const bookErrorDue = nowMs - game.lastBookErrorAtMs >= BOOK_ERROR_INTERVAL_MS;
  if (inRecordWindow) {
    try { homeBook = await deps.fetchBook(game.tokens.home); }
    catch (error) {
      if (bookErrorDue) await emit(deps, nowMs, { kind: "error", scope: "book", key: game.key, side: "home", message: errorMessage(error) });
    }
    try { awayBook = await deps.fetchBook(game.tokens.away); }
    catch (error) {
      if (bookErrorDue) await emit(deps, nowMs, { kind: "error", scope: "book", key: game.key, side: "away", message: errorMessage(error) });
    }
    if (bookErrorDue && (homeBook === null || awayBook === null)) game.lastBookErrorAtMs = nowMs;
  }
  const evaluation = evaluateLateScoreSignal({
    state: live, model,
    market: { homeTokenId: game.tokens.home, awayTokenId: game.tokens.away },
    books: {
      home: homeBook?.book ?? emptyBook(game.tokens.home),
      away: awayBook?.book ?? emptyBook(game.tokens.away)
    },
    options: {
      windowSeconds: options.windowSeconds, minProbability: options.minProbability, minEdge: options.minEdge,
      limitOffset: options.limitOffset, maxPrice: options.maxPrice, shares: options.shares
    }
  });
  const heartbeatDue = nowMs - game.lastHeartbeatAtMs >= options.heartbeatIntervalMs;
  if (inRecordWindow || heartbeatDue) {
    if (heartbeatDue) game.lastHeartbeatAtMs = nowMs;
    await emit(deps, nowMs, {
      kind: "state", key: game.key, league: league.name, espnId: espn.espnId, beacon: inRecordWindow ? "window" : "heartbeat",
      espn: live, remainingSeconds: remaining,
      model: { pHome: evaluation.pHome, fair: evaluation.fair },
      sides: { home: sideSummary(evaluation.sides.home), away: sideSummary(evaluation.sides.away) },
      decision: { fire: evaluation.fire, reason: evaluation.reason, side: evaluation.side },
      books: inRecordWindow ? { home: bookSummary(homeBook), away: bookSummary(awayBook) } : undefined
    });
  }
  if (evaluation.fire && evaluation.side !== null && !game.signals.some(signal => signal.side === evaluation.side)) {
    const side = evaluation.side;
    const tokenId = side === "home" ? game.tokens.home : game.tokens.away;
    const signal: TrackedSignal = {
      signalId: `${game.key}:${side}:${nowMs}`, side, tokenId, firedAtMs: nowMs, state: live,
      limitPrice: evaluation.sides[side].limit, evaluation, followupsSent: 0
    };
    game.signals.push(signal);
    state.signalCount += 1;
    let espnSummary: Record<string, unknown>;
    try {
      const summary = await deps.fetchSummary(league, espn.espnId);
      espnSummary = {
        lastPlayAgeMs: summary.lastPlay === null ? null : nowMs - summary.lastPlay.wallclockMs,
        clockDeltaSeconds: summary.lastPlay === null ? null : summary.lastPlay.clockSeconds - live.clockSeconds,
        scoreDelta: summary.lastPlay === null ? null : (summary.lastPlay.homeScore - live.homeScore) + (summary.lastPlay.awayScore - live.awayScore),
        lastPlay: summary.lastPlay,
        status: summary.status.state
      };
    } catch (error) {
      espnSummary = { error: errorMessage(error) };
    }
    await emit(deps, nowMs, {
      kind: "signal", signalId: signal.signalId, key: game.key, league: league.name, espnId: espn.espnId,
      marketSlug: game.market.marketSlug, conditionId: game.market.conditionId, side, tokenId,
      espnSummary, espn: live, remainingSeconds: remaining,
      pHome: evaluation.pHome, fair: evaluation.fair, limitPrice: signal.limitPrice,
      bid: evaluation.sides[side].bid, ask: evaluation.sides[side].ask, mid: evaluation.sides[side].mid,
      edge: evaluation.sides[side].edge, fill: evaluation.sides[side].fill,
      book: side === "home" ? bookSummary(homeBook) : bookSummary(awayBook)
    });
    deps.log?.(`SIGNAL ${game.key} ${side} @ ${evaluation.sides[side].ask ?? "?"} limit ${signal.limitPrice.toFixed(2)}`);
  }
}

async function processFollowups(state: ShadowRunState, options: ShadowMonitorOptions, deps: ShadowMonitorDeps, nowMs: number): Promise<void> {
  for (const game of state.tracked.values()) {
    for (const signal of game.signals) {
      for (;;) {
        const dueAt = followupDueAtMs(signal, options);
        if (dueAt === null || nowMs < dueAt) break;
        const ordinal = signal.followupsSent;
        signal.followupsSent += 1;
        let entry: MarketBook | null = null;
        try { entry = await deps.fetchBook(signal.tokenId); }
        catch (error) {
          await emit(deps, nowMs, { kind: "error", scope: "followup-book", signalId: signal.signalId, ordinal, message: errorMessage(error) });
          continue;
        }
        const fill: BookFill = walkBook(entry.book, signal.limitPrice, options.shares);
        await emit(deps, nowMs, {
          kind: "fill-check", signalId: signal.signalId, key: game.key, league: options.league.name,
          ordinal, scheduledMs: ordinal * options.followupStepSeconds + options.delaySeconds,
          elapsedMs: nowMs - signal.firedAtMs, tokenId: signal.tokenId, limitPrice: signal.limitPrice,
          bid: entry.book.bids[0]?.price ?? null, ask: entry.book.asks[0]?.price ?? null,
          fill, book: bookSummary(entry)
        });
      }
    }
  }
}

function nextDelay(state: ShadowRunState, options: ShadowMonitorOptions, nowMs: number): number {
  const candidates: number[] = [];
  for (const game of state.tracked.values()) {
    if (!game.settled) candidates.push(game.nextPollAtMs);
    for (const signal of game.signals) {
      const dueAt = followupDueAtMs(signal, options);
      if (dueAt !== null) candidates.push(dueAt);
    }
  }
  candidates.push((state.lastDiscoveryAtMs ?? nowMs) + options.discoveryIntervalMs);
  const next = Math.min(...candidates);
  return Math.max(250, Math.min(options.idlePollIntervalMs, next - nowMs));
}

export async function shadowTick(
  state: ShadowRunState,
  options: ShadowMonitorOptions,
  deps: ShadowMonitorDeps
): Promise<{ nextDelayMs: number; activeGames: number }> {
  const nowMs = nowOf(deps)();
  const discoveryDue = state.lastDiscoveryAtMs === null || nowMs - state.lastDiscoveryAtMs >= options.discoveryIntervalMs;
  if (discoveryDue) await discover(state, options, deps, nowMs);
  const scoreboardCache = new Map<string, Promise<EspnGame[]>>();
  for (const game of state.tracked.values()) {
    if (game.settled || nowMs < game.nextPollAtMs) continue;
    try { await pollGame(state, game, options, deps, nowMs, scoreboardCache); }
    catch (error) { await emit(deps, nowMs, { kind: "error", scope: "tick", key: game.key, message: errorMessage(error) }); }
  }
  await processFollowups(state, options, deps, nowMs);
  const activeGames = [...state.tracked.values()].filter(game => !game.settled).length;
  return { nextDelayMs: nextDelay(state, options, nowMs), activeGames };
}

export async function runLateGameShadow(options: ShadowMonitorOptions, deps: ShadowMonitorDeps): Promise<ShadowRunSummary> {
  if (options.shadowOnly !== true) {
    throw new Error("SHADOW_ONLY_REQUIRED: this monitor must never run with a trading configuration");
  }
  const now = nowOf(deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const state = createRunState(now());
  const deadlineMs = options.durationMs === undefined ? null : state.startedAtMs + options.durationMs;
  await emit(deps, state.startedAtMs, {
    kind: "run-start", league: options.league.name, shadowOnly: true,
    model: { league: options.model.league, trainedGames: options.model.trainedGames, trainedStates: options.model.trainedStates,
      datasetSha256: options.model.datasetSha256, createdAt: options.model.createdAt, lastGameStart: options.model.lastGameStart },
    options: {
      pollIntervalMs: options.pollIntervalMs, idlePollIntervalMs: options.idlePollIntervalMs,
      recordWindowSeconds: options.recordWindowSeconds, windowSeconds: options.windowSeconds,
      minProbability: options.minProbability, minEdge: options.minEdge, limitOffset: options.limitOffset,
      shares: options.shares, delaySeconds: options.delaySeconds, followupWindowSeconds: options.followupWindowSeconds
    }
  });
  for (;;) {
    if (options.maxIterations !== undefined && state.iteration >= options.maxIterations) break;
    if (deadlineMs !== null && now() >= deadlineMs) break;
    const { nextDelayMs } = await shadowTick(state, options, deps);
    state.iteration += 1;
    if (options.maxIterations !== undefined && state.iteration >= options.maxIterations) break;
    if (deadlineMs !== null && now() + nextDelayMs >= deadlineMs) break;
    await sleep(nextDelayMs);
  }
  const endedAtMs = now();
  await emit(deps, endedAtMs, { kind: "run-end", iterations: state.iteration, tracked: state.tracked.size, signals: state.signalCount });
  return {
    iterations: state.iteration,
    trackedGames: state.tracked.size,
    signals: state.signalCount,
    startedAtMs: state.startedAtMs,
    endedAtMs
  };
}
