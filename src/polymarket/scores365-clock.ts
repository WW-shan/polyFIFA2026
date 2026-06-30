import type { MatchState } from "../domain/types.js";
import { fetchJson, type HttpOptions } from "./http.js";

export const SCORES365_REMAINING_SECONDS_SOURCE = "365scores_added_time_precise_game_time" as const;

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const GOAL_SIGNAL_HTTP_TIMEOUT_MS = 700;
const GOAL_SIGNAL_PBP_TIMEOUT_MS = 350;
const SCORES365_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Origin": "https://www.365scores.com",
  "Referer": "https://www.365scores.com/"
};

export interface Scores365ClockOptions extends HttpOptions {
  timezoneName?: string;
}

export interface Scores365ClockPatch extends Partial<MatchState> {
  remainingSeconds: number;
  remainingSecondsSource: typeof SCORES365_REMAINING_SECONDS_SOURCE;
  scores365GameId: number;
}

export interface Scores365ScorePatch extends Partial<MatchState> {
  homeGoals: number;
  awayGoals: number;
  scores365GameId: number;
}

export interface Scores365GoalSignal extends Scores365ScorePatch {
  scoreMatchesSports: boolean;
  hasMatchingGoal: boolean;
  hasNoGoalSignal: boolean;
  hasVarReviewSignal: boolean;
  details: string[];
}

export function extract365ScoresClock(raw: unknown, match: MatchState): Scores365ClockPatch | null {
  const game = unwrapGame(raw);
  if (!game) return null;

  if (!gameTeamsMatch(game, match)) return null;

  const statusText = stringValue(game.statusText ?? game.shortStatusText).toLowerCase();
  const display = stringValue(game.gameTimeDisplay);
  if (!statusText.includes("2nd") && !display.startsWith("90+")) return null;

  const addedTime = numberValue(game.addedTime);
  const precise = isRecord(game.preciseGameTime) ? game.preciseGameTime : null;
  const minutes = numberValue(precise?.minutes);
  const seconds = numberValue(precise?.seconds);
  if (addedTime === undefined || minutes === undefined || seconds === undefined) return null;
  if (seconds < 0 || seconds >= 60) return null;
  if (precise?.autoProgress !== true || precise.clockDirection !== 1) return null;

  const remainingSeconds = Math.max(0, Math.round((90 + addedTime) * 60 - (minutes * 60 + seconds)));
  const patch: Scores365ClockPatch = {
    remainingSeconds,
    remainingSecondsSource: SCORES365_REMAINING_SECONDS_SOURCE,
    elapsedSeconds: minutes * 60 + seconds,
    minute: Math.floor(minutes),
    scores365GameId: numberValue(game.id) ?? match.scores365GameId ?? 0
  };
  if (patch.scores365GameId <= 0) return null;
  return patch;
}

export function extract365ScoresScorePatch(raw: unknown, match: MatchState): Scores365ScorePatch | null {
  const game = unwrapGame(raw);
  if (!game) return null;
  if (!gameTeamsMatch(game, match)) return null;

  const homeCompetitor = isRecord(game.homeCompetitor) ? game.homeCompetitor : null;
  const awayCompetitor = isRecord(game.awayCompetitor) ? game.awayCompetitor : null;
  const homeGoals = numberValue(homeCompetitor?.score);
  const awayGoals = numberValue(awayCompetitor?.score);
  const scores365GameId = numberValue(game.id) ?? match.scores365GameId ?? 0;
  if (homeGoals === undefined || awayGoals === undefined || scores365GameId <= 0) return null;
  if (homeGoals < 0 || awayGoals < 0) return null;

  return {
    homeGoals: Math.trunc(homeGoals),
    awayGoals: Math.trunc(awayGoals),
    scores365GameId
  };
}

export function extract365ScoresGoalSignal(raw: unknown, match: MatchState, previousMatch?: MatchState): Scores365GoalSignal | null {
  const game = unwrapGame(raw);
  if (!game) return null;
  if (!gameTeamsMatch(game, match)) return null;

  const scorePatch = extract365ScoresScorePatch(game, match);
  if (!scorePatch) return null;

  const details: string[] = [];
  const homeCompetitor = isRecord(game.homeCompetitor) ? game.homeCompetitor : null;
  const awayCompetitor = isRecord(game.awayCompetitor) ? game.awayCompetitor : null;
  const expectedCompetitors = expectedScoringCompetitorIds(match, previousMatch, homeCompetitor, awayCompetitor);
  const eventSignals = inspect365Events(game.events, expectedCompetitors);
  const pbpSignals = inspect365PlayByPlay(playByPlaySource(raw, game), match, previousMatch);
  details.push(...eventSignals.details, ...pbpSignals.details);

  const hasNoGoalSignal = eventSignals.hasNoGoalSignal || pbpSignals.hasNoGoalSignal;
  const hasVarReviewSignal = !hasNoGoalSignal && (eventSignals.hasVarReviewSignal || pbpSignals.hasVarReviewSignal);
  const hasMatchingGoal = !hasNoGoalSignal && (eventSignals.hasMatchingGoal || pbpSignals.hasMatchingGoal);

  return {
    ...scorePatch,
    scoreMatchesSports: scorePatch.homeGoals === match.homeGoals && scorePatch.awayGoals === match.awayGoals,
    hasMatchingGoal,
    hasNoGoalSignal,
    hasVarReviewSignal,
    details: details.length > 0 ? details : ["365 goal signal contained score only"]
  };
}

export function find365ScoresGameForMatch(raw: unknown, match: MatchState): Record<string, unknown> | null {
  const games = isRecord(raw) && Array.isArray(raw.games) ? raw.games : [];
  const normalizedHome = normalizeTeam(match.homeTeam);
  const normalizedAway = normalizeTeam(match.awayTeam);

  for (const item of games) {
    if (!isRecord(item)) continue;
    const home = isRecord(item.homeCompetitor) ? stringValue(item.homeCompetitor.name) : "";
    const away = isRecord(item.awayCompetitor) ? stringValue(item.awayCompetitor.name) : "";
    if (normalizeTeam(home) === normalizedHome && normalizeTeam(away) === normalizedAway) return item;
  }

  return null;
}

export class Scores365ClockProvider {
  private readonly gameIdByEventSlug = new Map<string, number>();

  constructor(private readonly options: Scores365ClockOptions = {}) {}

  async fetchClock(match: MatchState): Promise<Scores365ClockPatch | null> {
    const gameId = match.scores365GameId ?? this.gameIdByEventSlug.get(match.eventSlug) ?? await this.discoverGameId(match);
    if (gameId === undefined) return null;
    this.gameIdByEventSlug.set(match.eventSlug, gameId);
    const raw = await fetchJson<unknown>(this.gameUrl(gameId), this.httpOptions());
    return extract365ScoresClock(raw, { ...match, scores365GameId: gameId });
  }

  async fetchScore(match: MatchState): Promise<Scores365ScorePatch | null> {
    const cachedGameId = match.scores365GameId ?? this.gameIdByEventSlug.get(match.eventSlug);
    let discoveredGameId: number | undefined;
    if (cachedGameId === undefined) {
      const raw = await fetchJson<unknown>(this.allscoresUrl(match), this.httpOptions());
      const game = find365ScoresGameForMatch(raw, match);
      discoveredGameId = game ? numberValue(game.id) : undefined;
      const scorePatch = game ? extract365ScoresScorePatch(game, match) : null;
      if (discoveredGameId !== undefined) this.gameIdByEventSlug.set(match.eventSlug, discoveredGameId);
      if (scorePatch) return scorePatch;
    }

    const gameId = cachedGameId ?? discoveredGameId ?? await this.discoverGameId(match);
    if (gameId === undefined) return null;
    this.gameIdByEventSlug.set(match.eventSlug, gameId);
    const raw = await fetchJson<unknown>(this.gameUrl(gameId), this.httpOptions());
    return extract365ScoresScorePatch(raw, { ...match, scores365GameId: gameId });
  }

  async fetchGoalSignal(match: MatchState, previousMatch?: MatchState): Promise<Scores365GoalSignal | null> {
    const gameId = match.scores365GameId ?? this.gameIdByEventSlug.get(match.eventSlug) ?? await this.discoverGameId(match);
    if (gameId === undefined) return null;
    this.gameIdByEventSlug.set(match.eventSlug, gameId);

    const raw = await fetchJson<unknown>(this.gameUrl(gameId), this.httpOptions(GOAL_SIGNAL_HTTP_TIMEOUT_MS));
    const game = unwrapGame(raw);
    const feedUrl = game ? playByPlayFeedUrl(game) : undefined;
    const playByPlay = feedUrl ? await fetchJson<unknown>(feedUrl, this.httpOptions(GOAL_SIGNAL_PBP_TIMEOUT_MS)).catch(() => null) : null;
    return extract365ScoresGoalSignal(playByPlay ? { game: game ?? raw, playByPlay } : raw, { ...match, scores365GameId: gameId }, previousMatch);
  }

  private async discoverGameId(match: MatchState): Promise<number | undefined> {
    const raw = await fetchJson<unknown>(this.allscoresUrl(match), this.httpOptions());
    const game = find365ScoresGameForMatch(raw, match);
    return game ? numberValue(game.id) : undefined;
  }

  private allscoresUrl(match: MatchState): string {
    const { startDate, endDate } = dateRangeForMatch(match.startTime, this.options.timezoneName ?? DEFAULT_TIMEZONE);
    const params = new URLSearchParams({
      appTypeId: "5",
      langId: "1",
      timezoneName: this.options.timezoneName ?? DEFAULT_TIMEZONE,
      userCountryId: "2",
      sports: "1",
      startDate,
      endDate
    });
    return `https://webws.365scores.com/web/games/allscores/?${params.toString()}`;
  }

  private gameUrl(gameId: number): string {
    const params = new URLSearchParams({
      appTypeId: "5",
      langId: "1",
      timezoneName: this.options.timezoneName ?? DEFAULT_TIMEZONE,
      userCountryId: "2",
      gameId: String(gameId)
    });
    return `https://webws.365scores.com/web/game/?${params.toString()}`;
  }

  private httpOptions(timeoutMs?: number): HttpOptions {
    const options: HttpOptions = {
      ...this.options,
      headers: {
        ...SCORES365_HEADERS,
        ...this.options.headers
      }
    };
    if (timeoutMs !== undefined) options.timeoutMs = Math.min(this.options.timeoutMs ?? timeoutMs, timeoutMs);
    return options;
  }
}

interface GoalTextSignals {
  hasMatchingGoal: boolean;
  hasNoGoalSignal: boolean;
  hasVarReviewSignal: boolean;
  details: string[];
}

function inspect365Events(events: unknown, expectedCompetitors: Set<number>): GoalTextSignals {
  const signals: GoalTextSignals = {
    hasMatchingGoal: false,
    hasNoGoalSignal: false,
    hasVarReviewSignal: false,
    details: []
  };
  if (!Array.isArray(events)) return signals;

  for (const item of events) {
    if (!isRecord(item)) continue;
    const eventType = isRecord(item.eventType) ? item.eventType : {};
    const eventTypeId = numberValue(eventType.id);
    const competitorId = numberValue(item.competitorId);
    const text = [
      stringValue(eventType.name),
      stringValue(eventType.subTypeName),
      stringValue(item.name),
      stringValue(item.description)
    ].join(" ");
    const normalized = text.toLowerCase();
    if (isNoGoalText(normalized) || eventTypeId === 11) {
      signals.hasNoGoalSignal = true;
      signals.details.push(`365 event no goal/disallowed: ${compactText(text)}`);
      continue;
    }
    if (normalized.includes("var")) {
      signals.hasVarReviewSignal = true;
      signals.details.push(`365 event VAR signal: ${compactText(text)}`);
    }
    const expectedSide = competitorId === undefined || expectedCompetitors.size === 0 || expectedCompetitors.has(competitorId);
    if (eventTypeId === 1 && expectedSide && !isNoGoalText(normalized)) {
      signals.hasMatchingGoal = true;
      signals.details.push(`365 event normal goal: ${compactText(text)}`);
    }
  }
  return signals;
}

function inspect365PlayByPlay(playByPlay: unknown, match: MatchState, previousMatch?: MatchState): GoalTextSignals {
  const signals: GoalTextSignals = {
    hasMatchingGoal: false,
    hasNoGoalSignal: false,
    hasVarReviewSignal: false,
    details: []
  };
  for (const message of playByPlayMessages(playByPlay)) {
    const text = recordText(message).toLowerCase();
    if (!text) continue;
    if (isNoGoalText(text)) {
      signals.hasNoGoalSignal = true;
      signals.details.push(`365 PBP no goal: ${compactText(recordText(message))}`);
      continue;
    }
    if (text.includes("var")) {
      signals.hasVarReviewSignal = true;
      signals.details.push(`365 PBP VAR signal: ${compactText(recordText(message))}`);
    }
    if (isNormalGoalText(text) && scoreTextMatchesIncident(text, match, previousMatch)) {
      signals.hasMatchingGoal = true;
      signals.details.push(`365 PBP normal goal: ${compactText(recordText(message))}`);
    }
  }
  return signals;
}

function expectedScoringCompetitorIds(
  match: MatchState,
  previousMatch: MatchState | undefined,
  homeCompetitor: Record<string, unknown> | null,
  awayCompetitor: Record<string, unknown> | null
): Set<number> {
  const ids = new Set<number>();
  const homeId = numberValue(homeCompetitor?.id);
  const awayId = numberValue(awayCompetitor?.id);
  if (!previousMatch) {
    if (homeId !== undefined && match.homeGoals > 0) ids.add(homeId);
    if (awayId !== undefined && match.awayGoals > 0) ids.add(awayId);
    return ids;
  }
  if (homeId !== undefined && match.homeGoals > previousMatch.homeGoals) ids.add(homeId);
  if (awayId !== undefined && match.awayGoals > previousMatch.awayGoals) ids.add(awayId);
  return ids;
}

function playByPlaySource(raw: unknown, game: Record<string, unknown>): unknown {
  if (isRecord(raw) && raw.playByPlay !== undefined) return raw.playByPlay;
  return game.playByPlay;
}

function playByPlayFeedUrl(game: Record<string, unknown>): string | undefined {
  const playByPlay = isRecord(game.playByPlay) ? game.playByPlay : null;
  const feedUrl = stringValue(playByPlay?.feedURL ?? playByPlay?.feedUrl);
  return feedUrl || undefined;
}

function playByPlayMessages(playByPlay: unknown): Record<string, unknown>[] {
  if (!isRecord(playByPlay)) return [];
  const candidates = [
    playByPlay.Messages,
    playByPlay.messages,
    playByPlay.comments,
    playByPlay.Comments
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function recordText(record: Record<string, unknown>): string {
  const pieces: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && isTextKey(key)) pieces.push(value);
  }
  return pieces.join(" ");
}

function isTextKey(key: string): boolean {
  return /name|title|comment|description|text|type/i.test(key);
}

function isNoGoalText(text: string): boolean {
  return /goal\s+disallowed|disallowed\s+goal|no\s+goal|goal\s+overturned|overturned\s+by\s+var|cancel(?:led|ed)\s+goal|goal\s+cancel(?:led|ed)/i.test(text);
}

function isNormalGoalText(text: string): boolean {
  return /\bgoal\b/i.test(text) && !isNoGoalText(text);
}

function scoreTextMatchesIncident(text: string, match: MatchState, previousMatch?: MatchState): boolean {
  if (!previousMatch) return true;
  const targetScore = `${match.homeGoals}-${match.awayGoals}`;
  const altTargetScore = `${match.homeGoals}, ${match.awayGoals}`;
  if (text.includes(targetScore) || text.includes(altTargetScore)) return true;
  return goalsTotal(match) > goalsTotal(previousMatch);
}

function goalsTotal(match: Pick<MatchState, "homeGoals" | "awayGoals">): number {
  return match.homeGoals + match.awayGoals;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dateRangeForMatch(startTime: string | undefined, timezoneName: string): { startDate: string; endDate: string } {
  const base = startTime ? new Date(startTime) : new Date();
  const dates = [formatDate(base, "UTC"), formatDate(base, timezoneName)];
  const sorted = [...new Set(dates)].sort((a, b) => sortableDate(a).localeCompare(sortableDate(b)));
  return {
    startDate: sorted[0] ?? formatDate(base, timezoneName),
    endDate: sorted[sorted.length - 1] ?? formatDate(base, timezoneName)
  };
}

function formatDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  return `${day}/${month}/${year}`;
}

function sortableDate(value: string): string {
  const [day, month, year] = value.split("/");
  return `${year ?? ""}-${month ?? ""}-${day ?? ""}`;
}

function unwrapGame(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.game)) return raw.game;
  return raw;
}

function gameTeamsMatch(game: Record<string, unknown>, match: MatchState): boolean {
  const home = isRecord(game.homeCompetitor) ? stringValue(game.homeCompetitor.name) : "";
  const away = isRecord(game.awayCompetitor) ? stringValue(game.awayCompetitor.name) : "";
  if (!home || !away) return false;
  return normalizeTeam(home) === normalizeTeam(match.homeTeam)
    && normalizeTeam(away) === normalizeTeam(match.awayTeam);
}

function normalizeTeam(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((part) => part.length > 0 && part !== "and")
    .join(" ");
  return TEAM_ALIASES[normalized] ?? normalized;
}

const TEAM_ALIASES: Record<string, string> = {
  "cabo verde": "cape verde",
  "cote d ivoire": "ivory coast",
  "ir iran": "iran",
  "turkey": "turkiye",
  "united states": "usa"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}
