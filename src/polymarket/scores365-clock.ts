import type { MatchState } from "../domain/types.js";
import { fetchJson, type HttpOptions } from "./http.js";

export const SCORES365_REMAINING_SECONDS_SOURCE = "365scores_added_time_precise_game_time" as const;

const DEFAULT_TIMEZONE = "Asia/Shanghai";
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

  private httpOptions(): HttpOptions {
    const options: HttpOptions = {
      ...this.options,
      headers: {
        ...SCORES365_HEADERS,
        ...this.options.headers
      }
    };
    return options;
  }
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
