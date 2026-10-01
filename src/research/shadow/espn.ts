import { parseClockSeconds } from "./model.js";

export type EspnGameState = "pre" | "in" | "post" | "unknown";

export interface EspnTeamRef {
  id: string | null;
  homeAway: "home" | "away";
  displayName: string;
  names: string[];
}

export interface EspnStatus {
  state: EspnGameState;
  completed: boolean;
  period: number | null;
  clock: string | null;
  clockSeconds: number | null;
  detail: string | null;
}

export interface EspnGame {
  espnId: string;
  startMs: number | null;
  name: string;
  status: EspnStatus;
  home: EspnTeamRef;
  away: EspnTeamRef;
  homeScore: number | null;
  awayScore: number | null;
  winner: "home" | "away" | null;
}

export interface EspnLiveState {
  period: number;
  clockSeconds: number;
  clock: string;
  homeScore: number;
  awayScore: number;
}

export interface EspnLastPlay extends EspnLiveState {
  wallclockMs: number;
}

export interface EspnSummary {
  status: EspnStatus;
  homeScore: number | null;
  awayScore: number | null;
  winner: "home" | "away" | null;
  lastPlay: EspnLastPlay | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTeamName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const TEAM_NAME_KEYS = ["displayName", "shortDisplayName", "name", "nickname", "location", "abbreviation"] as const;
export const MIN_MATCH_NAME_LENGTH = 3;

function teamNames(team: Record<string, unknown> | null): string[] {
  if (!team) return [];
  const names = new Set<string>();
  for (const key of TEAM_NAME_KEYS) {
    const value = text(team[key]);
    const normalized = value === null ? "" : normalizeTeamName(value);
    if (normalized) names.add(normalized);
  }
  return [...names];
}

function teamRef(raw: unknown, homeAway: "home" | "away"): EspnTeamRef | null {
  const competitor = record(raw);
  if (!competitor) return null;
  const team = record(competitor.team);
  const names = teamNames(team);
  if (names.length === 0) return null;
  const displayName = text(team?.displayName) ?? text(team?.name) ?? names[0]!;
  return { id: text(competitor.id), homeAway, displayName, names };
}

function parseStatus(raw: unknown): EspnStatus {
  const status = record(raw);
  const type = record(status?.type);
  const state = text(type?.state);
  const clock = text(status?.displayClock);
  return {
    state: state === "pre" || state === "in" || state === "post" ? state : "unknown",
    completed: type?.completed === true,
    period: finiteNumber(status?.period),
    clock,
    clockSeconds: clock === null ? null : parseClockSeconds(clock),
    detail: text(type?.detail) ?? text(type?.shortDetail)
  };
}

function scoresOf(competitors: Array<Record<string, unknown>>): { homeScore: number | null; awayScore: number | null; winner: "home" | "away" | null } {
  let homeScore: number | null = null;
  let awayScore: number | null = null;
  let winner: "home" | "away" | null = null;
  for (const competitor of competitors) {
    const side = competitor.homeAway === "home" ? "home" : competitor.homeAway === "away" ? "away" : null;
    if (!side) continue;
    const score = finiteNumber(competitor.score);
    if (side === "home") homeScore = score; else awayScore = score;
    if (competitor.winner === true) winner = side;
  }
  return { homeScore, awayScore, winner };
}

function parseGame(raw: unknown): EspnGame | null {
  const event = record(raw);
  if (!event) return null;
  const espnId = text(event.id);
  const competition = record((Array.isArray(event.competitions) ? event.competitions[0] : null));
  if (!espnId || !competition) return null;
  const competitors = (Array.isArray(competition.competitors) ? competition.competitors : [])
    .map(record).filter((value): value is Record<string, unknown> => value !== null);
  const home = teamRef(competitors.find(value => value.homeAway === "home"), "home");
  const away = teamRef(competitors.find(value => value.homeAway === "away"), "away");
  if (!home || !away) return null;
  const { homeScore, awayScore, winner } = scoresOf(competitors);
  return {
    espnId,
    startMs: isoMs(event.date),
    name: text(event.name) ?? `${away.displayName} at ${home.displayName}`,
    status: parseStatus(competition.status),
    home, away, homeScore, awayScore, winner
  };
}

export function parseScoreboard(value: unknown): EspnGame[] {
  const events = record(value)?.events;
  if (!Array.isArray(events)) return [];
  return events.map(parseGame).filter((game): game is EspnGame => game !== null);
}

export function findGame(games: readonly EspnGame[], espnId: string): EspnGame | null {
  return games.find(game => game.espnId === espnId) ?? null;
}

export function liveStateOf(game: EspnGame): EspnLiveState | null {
  if (game.status.state !== "in" || game.status.period === null || game.status.period < 1) return null;
  const clock = game.status.clock;
  const clockSeconds = game.status.clockSeconds;
  if (clock === null || clockSeconds === null) return null;
  if (game.homeScore === null || game.awayScore === null) return null;
  return { period: game.status.period, clockSeconds, clock, homeScore: game.homeScore, awayScore: game.awayScore };
}

export function teamsMatch(espnNames: readonly string[], polymarketName: string): boolean {
  const candidate = normalizeTeamName(polymarketName);
  if (candidate.length < MIN_MATCH_NAME_LENGTH) return false;
  return espnNames.some(name => name.length >= MIN_MATCH_NAME_LENGTH && (name.includes(candidate) || candidate.includes(name)));
}

export interface EspnMatchQuery {
  names: readonly string[];
  startMs: number | null;
  toleranceMs?: number;
}

export function matchEspnGame(games: readonly EspnGame[], query: EspnMatchQuery): EspnGame | null {
  const tolerance = query.toleranceMs ?? 12 * 60 * 60 * 1000;
  const [first, second] = query.names;
  if (first === undefined || second === undefined) return null;
  const candidates = games.filter(game => {
    const direct = teamsMatch(game.home.names, first) && teamsMatch(game.away.names, second);
    const swapped = teamsMatch(game.home.names, second) && teamsMatch(game.away.names, first);
    if (!direct && !swapped) return false;
    if (query.startMs === null || game.startMs === null) return true;
    return Math.abs(game.startMs - query.startMs) <= tolerance;
  });
  if (candidates.length === 0) return null;
  if (query.startMs === null) return candidates[0]!;
  return candidates.reduce((best, game) =>
    Math.abs((game.startMs ?? query.startMs!) - query.startMs!) < Math.abs((best.startMs ?? query.startMs!) - query.startMs!) ? game : best);
}

function playsOf(summary: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = summary.plays;
  if (Array.isArray(direct) && direct.length > 0) {
    return direct.map(record).filter((value): value is Record<string, unknown> => value !== null);
  }
  const drives = record(summary.drives);
  const previous = drives?.previous;
  if (!Array.isArray(previous)) return [];
  const plays: Array<Record<string, unknown>> = [];
  for (const drive of previous) {
    const list = record(drive)?.plays;
    if (!Array.isArray(list)) continue;
    for (const play of list) {
      const parsed = record(play);
      if (parsed) plays.push(parsed);
    }
  }
  return plays;
}

export function parseSummary(value: unknown): EspnSummary {
  const summary = record(value);
  const header = record(summary?.header);
  const competitions = Array.isArray(header?.competitions) ? header.competitions : [];
  const competition = record(competitions[0]);
  const competitors = (Array.isArray(competition?.competitors) ? competition.competitors : [])
    .map(record).filter((item): item is Record<string, unknown> => item !== null);
  const { homeScore, awayScore, winner } = scoresOf(competitors);
  let lastPlay: EspnLastPlay | null = null;
  if (summary) {
    for (const play of playsOf(summary)) {
      const wallclockMs = isoMs(play.wallclock);
      const period = finiteNumber(record(play.period)?.number);
      const clock = text(record(play.clock)?.displayValue);
      const clockSeconds = clock === null ? null : parseClockSeconds(clock);
      const home = finiteNumber(play.homeScore);
      const away = finiteNumber(play.awayScore);
      if (wallclockMs === null || period === null || clockSeconds === null || home === null || away === null) continue;
      lastPlay = { wallclockMs, period, clock: clock!, clockSeconds, homeScore: home, awayScore: away };
    }
  }
  return {
    status: parseStatus(competition?.status),
    homeScore, awayScore, winner, lastPlay
  };
}
