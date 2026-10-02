/**
 * Point-level tennis state from the public 365Scores JSON API.
 *
 * Polymarket's own sports feed (`wss://sports-api.polymarket.com/ws`) publishes
 * tennis at *game* granularity — `"4-6, 6-6(1-5)"` — with no per-point score
 * inside a normal game. 365Scores' `/web/game/` document carries the point
 * score of the live game (`homeCompetitorScore: 15`), the serving competitor
 * and the point-by-point list, which is the signal a late-game resting order
 * needs: the favourite dropping a point (or two) on serve in a regular game
 * while it is one set from winning the match.
 *
 * This module only parses public data; it never trades.
 */
import type { JsonRequester } from "./types.js";

export const SCORES365_TENNIS_SPORT_ID = 3;
export const SCORES365_TIMEZONE = "Asia/Shanghai";
export const SCORES365_BASE_URL = "https://webws.365scores.com";

export const SCORES365_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Origin": "https://www.365scores.com",
  "Referer": "https://www.365scores.com/"
};

/** One completed point of the game in progress. Winner `null` for unknown feeds. */
export interface TennisGamePoint {
  winner: "home" | "away" | null;
  /** Raw 365Scores point counters *after* this point (0/15/30/40/50 = advantage). */
  home: number;
  away: number;
  /** 365Scores `importantPoint.type` when present (break/set/match point markers). */
  important: number | null;
}

/** Point score of the game in progress, in tennis display notation. */
export interface TennisGamePoints {
  /** Who is serving, when 365Scores names one. */
  serving: "home" | "away" | null;
  home: string;
  away: string;
  /** True for a 6-6 tiebreak, where point counters are raw counts (0..7+). */
  tiebreak: boolean;
  /** The receiver is one point from winning the game. */
  breakPoint: boolean;
  /** The leader in points is one point from the set / the match. */
  setPoint: boolean;
  matchPoint: boolean;
  /** Points already played in the current game, oldest first. */
  points: TennisGamePoint[];
}

export interface TennisSetScore {
  name: string;
  shortName: string | null;
  home: number;
  away: number;
  ended: boolean;
  live: boolean;
}

export interface TennisPointFrame {
  observedAtMs: number;
  scores365GameId: number;
  startTime: string | null;
  statusText: string | null;
  statusGroup: number | null;
  competition: string | null;
  homeName: string;
  awayName: string;
  setsWon: { home: number; away: number } | null;
  sets: TennisSetScore[];
  /** 2 for a best-of-three draw, 3 for best-of-five, null when the draw is unknown. */
  setsToWin: 2 | 3 | null;
  game: TennisGamePoints | null;
}

const POINT_VALUES: Record<string, number> = { "0": 0, "15": 1, "30": 2, "40": 3, "A": 4 };

/** `40` from the numeric wire value, or `A` once a deuce advantage is held. */
export function pointLabel(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (value >= 50) return "A";
  if (value >= 40) return "40";
  if (value >= 30) return "30";
  if (value >= 15) return "15";
  if (value >= 0) return "0";
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function competitorSide(value: unknown, frame: { homeId: number | null; awayId: number | null }): "home" | "away" | null {
  const id = numberValue(value);
  if (id === null) return null;
  if (frame.homeId !== null && id === frame.homeId) return "home";
  if (frame.awayId !== null && id === frame.awayId) return "away";
  return null;
}

/** A point score a receiver can win the game from. */
function isBreakPointFor(receiverPoints: string, serverPoints: string): boolean {
  return (receiverPoints === "40" && (serverPoints === "0" || serverPoints === "15" || serverPoints === "30"))
    || (receiverPoints === "A" && serverPoints === "40");
}

/** Point-by-point list of the live game, oldest first. */
export function parseTennisPointHistory(
  raw: unknown,
  frame: { homeId: number | null; awayId: number | null }
): TennisGamePoint[] {
  const current = record(raw);
  const list = Array.isArray(current?.points) ? current!.points as unknown[] : [];
  const points: TennisGamePoint[] = [];
  for (const value of list) {
    const point = record(value);
    if (!point) continue;
    const score = Array.isArray(point.score) ? point.score : [];
    const home = numberValue(score[0]);
    const away = numberValue(score[1]);
    if (home === null || away === null || !Number.isSafeInteger(home) || !Number.isSafeInteger(away)) continue;
    const importantValue = numberValue(record(point.importantPoint)?.type);
    points.push({
      winner: competitorSide(point.winnerCompetitorId, frame),
      home, away,
      important: importantValue !== null && Number.isSafeInteger(importantValue) ? importantValue : null
    });
  }
  return points;
}

/**
 * Reads the live game out of the `stages` array. 365Scores publishes the game
 * in progress as a stage named `Game` whose competitor scores are point labels
 * (`15`), while every other stage is a completed or pending set in games.
 * The serving competitor lives in `currentPointByPointGame`, not on the stage.
 */
export function parseTennisGameStage(
  stages: readonly unknown[],
  frame: { homeId: number | null; awayId: number | null },
  currentPointByPointGame?: unknown,
  tiebreak = false
): TennisGamePoints | null {
  const live = stages.map(record).filter((stage): stage is Record<string, unknown> => stage !== null)
    .find((stage) => stringValue(stage.name) === "Game" && stage.isLive === true);
  const pointByPoint = record(currentPointByPointGame);
  const rawHome = numberValue(live?.homeCompetitorScore);
  const rawAway = numberValue(live?.awayCompetitorScore);
  if (!live || rawHome === null || rawAway === null) return null;
  // Some feeds keep 15/30/40 notation inside a tiebreak; only treat small
  // counters as raw points when a 6-6 tiebreak is actually being played.
  const rawCounts = tiebreak && rawHome <= 7 && rawAway <= 7;
  const homePoints = rawCounts ? String(Math.trunc(rawHome)) : pointLabel(rawHome);
  const awayPoints = rawCounts ? String(Math.trunc(rawAway)) : pointLabel(rawAway);
  if (homePoints === null || awayPoints === null) return null;
  const serving = competitorSide(pointByPoint?.servingCompetitorId, frame)
    ?? (live.isHomeServing === true ? "home" : live.isAwayServing === true ? "away" : null)
    ?? competitorSide(live.servingCompetitorId, frame);
  const points = parseTennisPointHistory(pointByPoint, frame);
  // A break point exists whenever the non-server is one point from the game.
  const breakPoint = !tiebreak && (serving === "home" ? isBreakPointFor(awayPoints, homePoints)
    : serving === "away" ? isBreakPointFor(homePoints, awayPoints) : false);
  return {
    serving, home: homePoints, away: awayPoints, tiebreak, breakPoint, points,
    setPoint: false, matchPoint: false
  };
}

/** A side at 40 (opponent below 40) or at advantage is one point from the game. */
function gamePointFor(points: TennisGamePoints, side: "home" | "away"): boolean {
  const own = side === "home" ? points.home : points.away;
  const other = side === "home" ? points.away : points.home;
  if (points.tiebreak) {
    const ownCount = Number(own), otherCount = Number(other);
    return Number.isSafeInteger(ownCount) && Number.isSafeInteger(otherCount) && ownCount >= 6 && ownCount > otherCount;
  }
  return own === "A" || (own === "40" && other !== "40" && other !== "A");
}

/** True when taking the current game would also take the set at these games. */
function gameWinsSet(gamesFor: number, gamesAgainst: number): boolean {
  const next = gamesFor + 1;
  return (next >= 6 && gamesAgainst <= 4) || next === 7 && (gamesAgainst === 5 || gamesAgainst === 6);
}

/**
 * Set/match point flags need both the point score and the set score. 365Scores'
 * `importantPoint` markers are not consistently populated, so derive them the
 * same way the scoreboard does: a game point that also closes the set / match.
 */
export function withPointFlags(
  points: TennisGamePoints,
  sets: readonly TennisSetScore[],
  setsWon: { home: number; away: number } | null,
  setsToWin: 2 | 3 | null
): TennisGamePoints {
  const set = [...sets].filter(value => value.live && !value.ended).slice(-1)[0]
    ?? [...sets].filter(value => !value.ended).slice(-1)[0] ?? sets[sets.length - 1];
  if (!set || !setsWon || !setsToWin) return points;
  for (const side of ["home", "away"] as const) {
    if (!gamePointFor(points, side)) continue;
    const gamesFor = side === "home" ? set.home : set.away;
    const gamesAgainst = side === "home" ? set.away : set.home;
    if (!gameWinsSet(gamesFor, gamesAgainst)) continue;
    points.setPoint = true;
    if ((side === "home" ? setsWon.home : setsWon.away) === setsToWin - 1) points.matchPoint = true;
  }
  return points;
}

export function parseTennisSetStages(stages: readonly unknown[]): { sets: TennisSetScore[]; setsWon: { home: number; away: number } | null; setsToWin: 2 | 3 | null } {
  const sets: TennisSetScore[] = [];
  let setsWon: { home: number; away: number } | null = null;
  let maxSetNumber = 0;
  for (const value of stages) {
    const stage = record(value);
    if (!stage) continue;
    const name = stringValue(stage.name);
    if (name === null) continue;
    // Unplayed sets carry -1 but still prove the draw length (best of 3 vs 5).
    const setMatch = /^Set\s*(\d+)$/i.exec(name);
    if (setMatch) maxSetNumber = Math.max(maxSetNumber, Number(setMatch[1]));
    const home = numberValue(stage.homeCompetitorScore);
    const away = numberValue(stage.awayCompetitorScore);
    if (home === null || away === null || home < 0 || away < 0) continue;
    if (/^Sets?$/i.test(name)) { setsWon = { home, away }; continue; }
    if (!setMatch) continue;
    sets.push({
      name, shortName: stringValue(stage.shortName), home, away,
      ended: stage.isEnded === true, live: stage.isLive === true
    });
  }
  const setsToWin: 2 | 3 | null = maxSetNumber >= 5 ? 3 : maxSetNumber >= 3 ? 2 : null;
  return { sets, setsWon, setsToWin };
}

/** Normalizes one `/web/game/` document into a frame, or null when it is not tennis. */
export function normalizeTennisPointFrame(raw: unknown, observedAtMs: number): TennisPointFrame | null {
  const document = record(raw);
  const game = record(document?.game) ?? document;
  if (!game) return null;
  const sportId = numberValue(game.sportId);
  if (sportId !== null && sportId !== SCORES365_TENNIS_SPORT_ID) return null;
  const home = record(game.homeCompetitor), away = record(game.awayCompetitor);
  const homeName = stringValue(home?.name), awayName = stringValue(away?.name);
  const scores365GameId = numberValue(game.id);
  if (homeName === null || awayName === null || scores365GameId === null) return null;
  const ids = { homeId: numberValue(home?.id), awayId: numberValue(away?.id) };
  const stages = Array.isArray(game.stages) ? game.stages : [];
  const currentPointByPointGame = game.currentPointByPointGame;
  const { sets, setsWon: parsedSetsWon, setsToWin } = parseTennisSetStages(stages);
  const setsWon = parsedSetsWon ?? (numberValue(home?.score) !== null && numberValue(away?.score) !== null
    ? { home: numberValue(home?.score)!, away: numberValue(away?.score)! } : null);
  const currentSet = sets.filter(value => value.live && !value.ended).slice(-1)[0]
    ?? sets.filter(value => !value.ended).slice(-1)[0] ?? sets[sets.length - 1];
  const tiebreak = currentSet !== undefined && currentSet.home === 6 && currentSet.away === 6;
  const gamePoints = parseTennisGameStage(stages, ids, currentPointByPointGame, tiebreak);
  return {
    observedAtMs, scores365GameId, startTime: stringValue(game.startTime),
    statusText: stringValue(game.statusText), statusGroup: numberValue(game.statusGroup),
    competition: stringValue(game.competitionDisplayName),
    homeName, awayName,
    setsWon, sets, setsToWin,
    game: gamePoints === null ? null : withPointFlags(gamePoints, sets, setsWon, setsToWin)
  };
}

/** True while the match is being played (365Scores `statusGroup` 3). */
export function isLiveTennisFrame(frame: TennisPointFrame): boolean {
  return frame.statusGroup === 3;
}

/**
 * Stable identity of the point state that matters for a resting entry.
 * Identical consecutive polls are deduplicated instead of re-journaled.
 */
export function tennisPointFrameFingerprint(frame: TennisPointFrame): string {
  const sets = frame.sets.map(set => `${set.name}:${set.home}-${set.away}:${set.ended ? "e" : set.live ? "l" : "p"}`).join(",");
  const game = frame.game;
  const points = game?.points.map(point => `${point.winner ?? "?"}${point.home}-${point.away}`).join(",") ?? "";
  return JSON.stringify([frame.scores365GameId, frame.statusGroup, frame.setsWon, sets,
    game?.serving ?? null, game?.home ?? null, game?.away ?? null, points]);
}

/** Live games out of an `/web/games/allscores/` listing. */
export interface Scores365LiveGame {
  scores365GameId: number;
  homeName: string;
  awayName: string;
  startTime: string | null;
  competition: string | null;
}

export function liveTennisGamesFromAllScores(raw: unknown): Scores365LiveGame[] {
  const document = record(raw);
  const games = Array.isArray(document?.games) ? document!.games as unknown[] : [];
  const out: Scores365LiveGame[] = [];
  for (const rawGame of games) {
    const game = record(rawGame);
    if (!game || numberValue(game.statusGroup) !== 3) continue;
    const id = numberValue(game.id);
    const homeName = stringValue(record(game.homeCompetitor)?.name);
    const awayName = stringValue(record(game.awayCompetitor)?.name);
    if (id === null || homeName === null || awayName === null) continue;
    out.push({ scores365GameId: id, homeName, awayName,
      startTime: stringValue(game.startTime), competition: stringValue(game.competitionDisplayName) });
  }
  return out;
}

export function tennisAllScoresUrl(startDate: string, endDate: string, baseUrl = SCORES365_BASE_URL, timezoneName = SCORES365_TIMEZONE): string {
  const params = new URLSearchParams({ appTypeId: "5", langId: "1", timezoneName, userCountryId: "2",
    sports: String(SCORES365_TENNIS_SPORT_ID), startDate, endDate });
  return `${baseUrl.replace(/\/+$/, "")}/web/games/allscores/?${params.toString()}`;
}

export function tennisGameUrl(gameId: number, baseUrl = SCORES365_BASE_URL, timezoneName = SCORES365_TIMEZONE): string {
  const params = new URLSearchParams({ appTypeId: "5", langId: "1", timezoneName, userCountryId: "2", gameId: String(gameId) });
  return `${baseUrl.replace(/\/+$/, "")}/web/game/?${params.toString()}`;
}

/** 365Scores expects `DD/MM/YYYY` in this endpoint, in the requested timezone. */
export function tennisDateParam(atMs: number, timezoneName = SCORES365_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezoneName, day: "2-digit", month: "2-digit", year: "numeric" })
    .formatToParts(new Date(atMs));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("day")}/${value("month")}/${value("year")}`;
}

/** Normalized name key, matching the resolver's accent/punctuation folding. */
export function tennisNameKey(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
}

/**
 * Pairs a 365Scores game with a Polymarket event title (`"A vs B"` / `"A vs. B"`)
 * by requiring both player names, in either order.
 */
const NAME_STOPWORDS = new Set(["de", "del", "della", "van", "von", "der", "den", "da", "dos", "di", "la", "le", "jr", "sr", "ii", "iii", "iv"]);

/** Word tokens of a player name, accent/punctuation folded and stopwords dropped. */
export function tennisNameTokens(name: string): string[] {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).filter(token => token.length > 0 && !NAME_STOPWORDS.has(token));
}

/**
 * Name matching has to survive both orders and shortened names: Polymarket
 * publishes `"Yunchaokete Bu"` while 365Scores publishes `"Bu Yunchaokete"`,
 * and `"Matheus Pucinelli de Almeida"` versus `"Matheus Almeida"`. Compare
 * token sets, requiring the shorter name's tokens to all appear in the longer
 * one plus at least one meaningful (non-initial) shared fragment.
 */
export function tennisNamesMatch(a: string, b: string): boolean {
  const keyA = tennisNameKey(a), keyB = tennisNameKey(b);
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  // Concatenated-key containment is deliberately not used: "Mackinlay" is a
  // prefix of "Mackinlay J.", and accepting that would pair a singles event
  // with a doubles pair. Token coverage below handles hyphens, accents and
  // given/family order without that false positive.
  const left = new Set(tennisNameTokens(a)), right = new Set(tennisNameTokens(b));
  if (left.size === 0 || right.size === 0) return false;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  if (small.size < 2 && small.size !== large.size) return false;
  let shared = 0, meaningful = false;
  for (const token of small) {
    if (!large.has(token)) continue;
    shared += 1;
    if (token.length >= 4) meaningful = true;
  }
  return shared === small.size && meaningful;
}

export function matchTennisFrameToTitle(frame: { homeName: string; awayName: string }, title: string): boolean {
  const [left, right] = title.split(/\s+vs\.?\s+/i);
  if (!left || !right) return false;
  const { homeName, awayName } = frame;
  // A doubles pair ("A./B. vs C./D.") must never pair with a singles event
  // just because one surname is shared.
  const frameDoubles = homeName.includes("/") || awayName.includes("/");
  const titleDoubles = left.includes("/") || right.includes("/");
  if (frameDoubles !== titleDoubles) return false;
  const direct = tennisNamesMatch(left, homeName) && tennisNamesMatch(right, awayName);
  const swapped = tennisNamesMatch(left, awayName) && tennisNamesMatch(right, homeName);
  return direct !== swapped;
}

export interface TennisEntrySignal {
  favored: "home" | "away";
  favoredSets: number;
  trailerSets: number;
  setsToWin: number;
  /** The favoured side has won `setsToWin - 1` sets and leads the match. */
  oneSetFromMatch: boolean;
  /** Current-set games, when 365Scores publishes the live set. */
  setGames: { home: number; away: number } | null;
  /** 5-x (x<=4), 6-5 or 6-6: the set is decided by the next games / tiebreak. */
  lateSet: boolean;
  tiebreak: boolean;
  /** A normal service game, not a tiebreak. */
  regularGame: boolean;
  favoriteServing: boolean;
  /** Points the receiver has won in the current game == points the server lost. */
  serverLostPoints: number;
  /** The most recent completed point was won by the receiver. */
  recentPointLoss: boolean;
  breakPointAgainstFavorite: boolean;
  /** The fat entry point: late set, one set from winning, favourite dropped a point on serve. */
  candidate: boolean;
}

function currentSet(sets: readonly TennisSetScore[]): TennisSetScore | null {
  const live = sets.filter(set => set.live && !set.ended);
  const pool = live.length > 0 ? live : sets.filter(set => !set.ended);
  const selected = (pool.length > 0 ? pool : sets).slice(-1)[0];
  return selected ?? null;
}

function lateGameScore(home: number, away: number): { late: boolean; tiebreak: boolean } {
  const high = Math.max(home, away), low = Math.min(home, away);
  if (home === 6 && away === 6) return { late: true, tiebreak: true };
  return { late: (high === 5 && low <= 4) || (high === 6 && low === 5), tiebreak: false };
}

/**
 * Derives the late-game entry signal from one point-level frame.
 *
 * The signal is intentionally conservative: the match draw must be known, one
 * side must lead with `setsToWin - 1` sets won, the live set must be at 5-x /
 * 6-5 / 6-6, the game must be a regular service game and the favourite must
 * already have lost at least one point on its own serve. `candidate` is the
 * "常规局丢分" state the resting bid is waiting for.
 */
export function tennisEntrySignal(frame: TennisPointFrame): TennisEntrySignal | null {
  const game = frame.game, setsWon = frame.setsWon, setsToWin = frame.setsToWin;
  if (!game || !setsWon || !setsToWin) return null;
  let favored: "home" | "away";
  if (setsWon.home > setsWon.away) favored = "home";
  else if (setsWon.away > setsWon.home) favored = "away";
  else return null;
  const favoredSets = favored === "home" ? setsWon.home : setsWon.away;
  const trailerSets = favored === "home" ? setsWon.away : setsWon.home;
  const oneSetFromMatch = favoredSets === setsToWin - 1 && favoredSets > trailerSets;
  const set = currentSet(frame.sets);
  const setGames = set ? { home: set.home, away: set.away } : null;
  const late = set ? lateGameScore(set.home, set.away) : { late: false, tiebreak: false };
  const serving = game.serving;
  const favoriteServing = serving === favored;
  const receiverPoints = serving === null ? null : serving === "home" ? game.away : game.home;
  const receiverValue = receiverPoints === null ? null
    : game.tiebreak && /^\d+$/.test(receiverPoints) ? Number(receiverPoints) : POINT_VALUES[receiverPoints] ?? null;
  const history = game.points;
  const serverLostFromHistory = serving === null ? 0 : history.filter(point => point.winner !== null && point.winner !== serving).length;
  const serverLostPoints = history.length > 0 ? serverLostFromHistory : receiverValue ?? 0;
  const lastPoint = history.length > 0 ? history[history.length - 1]! : null;
  const recentPointLoss = lastPoint !== null && serving !== null && lastPoint.winner !== null && lastPoint.winner !== serving;
  return {
    favored, favoredSets, trailerSets, setsToWin, oneSetFromMatch, setGames,
    lateSet: late.late, tiebreak: late.tiebreak, regularGame: late.late && !late.tiebreak,
    favoriteServing, serverLostPoints, recentPointLoss,
    breakPointAgainstFavorite: game.breakPoint && favoriteServing,
    candidate: oneSetFromMatch && late.late && !late.tiebreak && favoriteServing && serverLostPoints >= 1
  };
}

export interface TennisPointsPollTarget { eventSlug: string; title: string }
export interface TennisPointPollResult { eventSlug: string; frame: TennisPointFrame; signal: TennisEntrySignal | null }

export interface TennisPointsPollerOptions {
  request: JsonRequester;
  baseUrl?: string;
  timezoneName?: string;
  now?: () => number;
  /** How long the allscores → Polymarket title mapping is reused. */
  listRefreshMs?: number;
  /** Upper bound on `/web/game/` fetches per poll. */
  maxGames?: number;
  /** Simultaneous `/web/game/` fetches. */
  concurrency?: number;
  /** Re-record an unchanged frame at least this often, for freshness. */
  heartbeatMs?: number;
  onError?: (error: unknown, detail: string) => void;
}

const DEFAULT_LIST_REFRESH_MS = 600_000;
const DEFAULT_MAX_GAMES = 24;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_HEARTBEAT_MS = 60_000;

/**
 * Polls the 365Scores tennis point state for the live Polymarket tennis events
 * the collector is currently watching. The collector owns journalling; this
 * class only resolves `eventSlug → 365Scores game` and returns normalized
 * frames, deduplicating unchanged states.
 */
export class TennisPointsPoller {
  private readonly request: JsonRequester;
  private readonly baseUrl: string;
  private readonly timezoneName: string;
  private readonly now: () => number;
  private readonly listRefreshMs: number;
  private readonly maxGames: number;
  private readonly concurrency: number;
  private readonly heartbeatMs: number;
  private readonly onError: (error: unknown, detail: string) => void;
  private readonly gameIdBySlug = new Map<string, number>();
  private readonly lastRecordedAtMs = new Map<string, number>();
  private readonly lastFingerprint = new Map<string, string>();
  private listFetchedAtMs = 0;
  private pollInFlight: Promise<TennisPointPollResult[]> | undefined;

  constructor(options: TennisPointsPollerOptions) {
    this.request = options.request;
    this.baseUrl = options.baseUrl ?? SCORES365_BASE_URL;
    this.timezoneName = options.timezoneName ?? SCORES365_TIMEZONE;
    this.now = options.now ?? Date.now;
    this.listRefreshMs = options.listRefreshMs ?? DEFAULT_LIST_REFRESH_MS;
    this.maxGames = options.maxGames ?? DEFAULT_MAX_GAMES;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onError = options.onError ?? (() => {});
  }

  private headers(): Record<string, string> { return { ...SCORES365_HEADERS }; }

  private async fetchJson(url: string): Promise<unknown> {
    return this.request(url, { headers: this.headers() });
  }

  /** Fetch the live-game list and match it against the watched event titles. */
  private async refreshGameIds(targets: readonly TennisPointsPollTarget[]): Promise<void> {
    const nowMs = this.now();
    if (this.listFetchedAtMs > 0 && nowMs - this.listFetchedAtMs < this.listRefreshMs
        && targets.every(target => this.gameIdBySlug.has(target.eventSlug))) return;
    const start = tennisDateParam(nowMs - 24 * 3600_000, this.timezoneName);
    const end = tennisDateParam(nowMs + 24 * 3600_000, this.timezoneName);
    let listing: unknown;
    try {
      listing = await this.fetchJson(tennisAllScoresUrl(start, end, this.baseUrl, this.timezoneName));
    } catch (error) {
      this.onError(error, "allscores");
      return;
    }
    const live = liveTennisGamesFromAllScores(listing);
    const next = new Map<string, number>();
    for (const target of targets) {
      const match = live.find(game => matchTennisFrameToTitle(game, target.title));
      if (match) next.set(target.eventSlug, match.scores365GameId);
    }
    // Replace the mapping only when the listing answered: a stale entry that
    // was not on this page must be retried on the next refresh, not trusted.
    this.gameIdBySlug.clear();
    for (const [slug, id] of next) this.gameIdBySlug.set(slug, id);
    // A long-lived collector sees thousands of finished matches; keep the
    // per-match dedupe state bounded to the events still being watched.
    const watched = new Set(targets.map(target => target.eventSlug));
    for (const slug of this.lastFingerprint.keys()) if (!watched.has(slug)) {
      this.lastFingerprint.delete(slug); this.lastRecordedAtMs.delete(slug);
    }
    this.listFetchedAtMs = nowMs;
  }

  async poll(targets: readonly TennisPointsPollTarget[]): Promise<TennisPointPollResult[]> {
    if (this.pollInFlight) return this.pollInFlight;
    const run = this.performPoll(targets).finally(() => { this.pollInFlight = undefined; });
    this.pollInFlight = run;
    return run;
  }

  private async performPoll(targets: readonly TennisPointsPollTarget[]): Promise<TennisPointPollResult[]> {
    if (targets.length === 0) return [];
    await this.refreshGameIds(targets);
    const results: TennisPointPollResult[] = [];
    const targetsWithIds = targets
      .map(target => ({ target, gameId: this.gameIdBySlug.get(target.eventSlug) }))
      .filter((entry): entry is { target: TennisPointsPollTarget; gameId: number } => entry.gameId !== undefined)
      .slice(0, this.maxGames);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, targetsWithIds.length) }, async () => {
      while (cursor < targetsWithIds.length) {
        const entry = targetsWithIds[cursor++];
        if (!entry) return;
        let raw: unknown;
        try {
          raw = await this.fetchJson(tennisGameUrl(entry.gameId, this.baseUrl, this.timezoneName));
        } catch (error) {
          this.onError(error, `game:${entry.gameId}`);
          continue;
        }
        const frame = normalizeTennisPointFrame(raw, this.now());
        if (!frame || !isLiveTennisFrame(frame)) continue;
        if (!matchTennisFrameToTitle(frame, entry.target.title)) continue;
        const fingerprint = tennisPointFrameFingerprint(frame);
        const previousAtMs = this.lastRecordedAtMs.get(entry.target.eventSlug) ?? -Infinity;
        if (this.lastFingerprint.get(entry.target.eventSlug) === fingerprint && this.now() - previousAtMs < this.heartbeatMs) continue;
        this.lastFingerprint.set(entry.target.eventSlug, fingerprint);
        this.lastRecordedAtMs.set(entry.target.eventSlug, this.now());
        results.push({ eventSlug: entry.target.eventSlug, frame, signal: tennisEntrySignal(frame) });
      }
    }));
    return results;
  }
}
