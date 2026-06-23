import { inflateSync, unzipSync } from "node:zlib";
import type { MatchPeriod, MatchState, SpreadMarket, StrategyMarket, StrategyMarketType } from "../domain/types.js";
import { fetchJson, fetchText } from "./http.js";

export async function fetchEventSpreadMarkets(eventSlug: string): Promise<SpreadMarket[]> {
  const html = await fetchText(`https://polymarket.com/sports/world-cup/${encodeURIComponent(eventSlug)}`);
  const payload = extractNextInitialState(html);
  const state = decodeInitialStatePayload(payload);
  return findSpreadMarkets(state, eventSlug);
}

export async function fetchEventStrategyMarkets(eventSlug: string): Promise<StrategyMarket[]> {
  let primaryError: unknown;
  try {
    const html = await fetchText(`https://polymarket.com/sports/world-cup/${encodeURIComponent(eventSlug)}`);
    const payload = extractNextInitialState(html);
    const state = decodeInitialStatePayload(payload);
    const markets = findStrategyMarkets(state, eventSlug);
    if (markets.length > 0) return markets;
  } catch (error) {
    primaryError = error;
  }

  const fallbackMarkets = await fetchGammaEventStrategyMarkets(eventSlug);
  if (fallbackMarkets.length > 0 || !primaryError) return fallbackMarkets;
  throw primaryError;
}

export async function fetchEventMatchState(eventSlug: string): Promise<MatchState> {
  const html = await fetchText(`https://polymarket.com/sports/world-cup/${encodeURIComponent(eventSlug)}`);
  const payload = extractNextInitialState(html);
  const state = decodeInitialStatePayload(payload);
  const match = findMatchState(state, eventSlug);
  if (!match) throw new Error(`MATCH_STATE_NOT_FOUND: ${eventSlug}`);
  return match;
}

async function fetchGammaEventStrategyMarkets(eventSlug: string): Promise<StrategyMarket[]> {
  const event = await fetchJson<unknown>(`https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(eventSlug)}`);
  return findStrategyMarkets(event, eventSlug);
}

export function extractNextInitialState(html: string): string {
  const scriptMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!scriptMatch?.[1]) {
    throw new Error("NEXT_DATA_SCRIPT_NOT_FOUND");
  }

  const nextData = JSON.parse(scriptMatch[1]) as unknown;
  const initialState = getPath(nextData, ["props", "pageProps", "initialState"]);
  if (typeof initialState !== "string" || initialState.length === 0) {
    throw new Error("INITIAL_STATE_NOT_FOUND");
  }
  return initialState;
}

export function decodeInitialStatePayload(payload: string): unknown {
  const compressed = Buffer.from(payload, "base64");
  const inflated = inflateOrUnzip(compressed).toString("utf8");
  return JSON.parse(inflated) as unknown;
}

export function findSpreadMarkets(state: unknown, eventSlug?: string): SpreadMarket[] {
  const markets: SpreadMarket[] = [];

  walk(state, (value) => {
    const market = normalizeSpreadMarket(value, eventSlug);
    if (market) markets.push(market);
  });

  return dedupeMarkets(markets);
}

export function findStrategyMarkets(state: unknown, eventSlug?: string): StrategyMarket[] {
  const markets: StrategyMarket[] = [];

  walk(state, (value) => {
    const market = normalizeStrategyMarket(value, eventSlug);
    if (market) markets.push(market);
  });

  return dedupeMarkets(markets);
}

export function findMatchState(state: unknown, eventSlug: string): MatchState | null {
  const game = findGameRecord(state, eventSlug);
  if (!game) return null;

  const score = parseScore(stringValue(game.score));
  if (!score) return null;

  const title = findEventTitle(state, eventSlug);
  const teams = parseTitleTeams(title) ?? findTeamsFromMarkets(state, eventSlug);
  if (!teams) return null;

  const period = parsePeriod(stringValue(game.period));
  const minute = parseElapsedMinute(game.elapsed ?? game.minute);
  const stoppageMinutes = parseStoppageMinutes(game.stoppageTime ?? game.stoppage_time ?? game.addedTime ?? game.added_time ?? game.injuryTime ?? game.injury_time);
  const expectedEndMinute = parseExpectedEndMinute(game.expectedEndMinute ?? game.expected_end_minute ?? game.endMinute ?? game.end_minute, period, stoppageMinutes);
  const remainingMinutes = parseRemainingMinutes(game.remainingMinutes ?? game.remaining_minutes ?? game.remainingTime ?? game.remaining_time, minute, expectedEndMinute);
  const live = typeof game.live === "boolean" ? game.live : game.gameState === "live" || game.gameState === "in-progress";
  const ended = game.ended === true || period === "FT";

  const matchState: MatchState = {
    eventSlug,
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    homeGoals: score.homeGoals,
    awayGoals: score.awayGoals,
    minute,
    period,
    isLive: live && !ended
  };
  if (stoppageMinutes !== undefined) matchState.stoppageMinutes = stoppageMinutes;
  if (expectedEndMinute !== undefined) matchState.expectedEndMinute = expectedEndMinute;
  if (remainingMinutes !== undefined) matchState.remainingMinutes = remainingMinutes;
  return matchState;
}

export function normalizeStrategyMarket(value: unknown, eventSlug?: string): StrategyMarket | null {
  if (!isRecord(value)) return null;

  const question = stringValue(value.question ?? value.title ?? value.name);
  const marketSlug = stringValue(value.marketSlug ?? value.slug);
  const conditionId = stringValue(value.conditionId ?? value.condition_id);
  const outcomes = stringArray(value.outcomes);
  const clobTokenIds = stringArray(value.clobTokenIds ?? value.clob_token_ids ?? value.tokenIds);
  const resolvedEventSlug = stringValue(value.eventSlug ?? value.event_slug ?? value.gameSlug) ?? eventSlug;

  if (!question || !marketSlug || !conditionId || !resolvedEventSlug) return null;
  if (eventSlug && resolvedEventSlug !== eventSlug) return null;
  if (outcomes.length < 2 || clobTokenIds.length < 2) return null;

  const marketType = inferMarketType(value, question);
  if (marketType === "unknown") return null;

  const line = numberValue(value.line ?? value.spreadLine ?? value.spread ?? value.total) ?? parseLine(question, marketType);
  const market: StrategyMarket = {
    eventSlug: resolvedEventSlug,
    marketSlug,
    question,
    conditionId,
    clobTokenIds,
    outcomes,
    marketType
  };

  if (line !== null) market.line = line;
  const team = marketType === "team_total" ? parseTeamTotalTeam(question) : undefined;
  if (team) market.team = team;
  const tickSize = tickSizeValue(value.tickSize ?? value.tick_size ?? value.orderPriceMinTickSize ?? value.order_price_min_tick_size);
  if (tickSize) market.tickSize = tickSize;
  if (typeof value.negRisk === "boolean") market.negRisk = value.negRisk;
  if (typeof value.neg_risk === "boolean") market.negRisk = value.neg_risk;

  return market;
}

export function normalizeSpreadMarket(value: unknown, eventSlug?: string): SpreadMarket | null {
  if (!isRecord(value)) return null;

  const type = stringValue(value.sportsMarketType ?? value.sports_market_type ?? value.marketType);
  if (type && type.toLowerCase() !== "spreads") return null;
  if (!type && !String(value.question ?? "").toLowerCase().includes("spread")) return null;

  const question = stringValue(value.question ?? value.title ?? value.name);
  const marketSlug = stringValue(value.marketSlug ?? value.slug);
  const conditionId = stringValue(value.conditionId ?? value.condition_id);
  const outcomes = stringArray(value.outcomes);
  const clobTokenIds = stringArray(value.clobTokenIds ?? value.clob_token_ids ?? value.tokenIds);
  const resolvedEventSlug = stringValue(value.eventSlug ?? value.event_slug ?? value.gameSlug) ?? eventSlug;
  const parsedLine = numberValue(value.line ?? value.spreadLine ?? value.spread) ?? (question ? parseSpreadLine(question) : null);

  if (!question || !marketSlug || !conditionId || !resolvedEventSlug || parsedLine === null) return null;
  if (eventSlug && resolvedEventSlug !== eventSlug) return null;
  if (outcomes.length < 2 || clobTokenIds.length < 2) return null;

  const market: SpreadMarket = {
    eventSlug: resolvedEventSlug,
    marketSlug,
    question,
    conditionId,
    clobTokenIds,
    outcomes,
    line: parsedLine
  };

  const tickSize = tickSizeValue(value.tickSize ?? value.tick_size ?? value.orderPriceMinTickSize ?? value.order_price_min_tick_size);
  if (tickSize) market.tickSize = tickSize;
  if (typeof value.negRisk === "boolean") market.negRisk = value.negRisk;
  if (typeof value.neg_risk === "boolean") market.negRisk = value.neg_risk;

  return market;
}

export function parseSpreadLine(text: string): number | null {
  const match = text.match(/\(([+-]?\d+(?:\.\d+)?)\)/);
  return match?.[1] ? Number(match[1]) : null;
}

function inferMarketType(value: Record<string, unknown>, question: string): StrategyMarketType {
  if (isUnsupportedStrategyQuestion(question)) return "unknown";

  const rawType = stringValue(value.sportsMarketType ?? value.sports_market_type ?? value.marketType)?.toLowerCase();
  if (rawType === "spreads") return "spread";
  if (rawType === "totals") return parseTeamTotalTeam(question) ? "team_total" : "total";
  if (rawType === "moneyline") return "moneyline";

  if (/^spread:/i.test(question)) return "spread";
  if (/both teams to score/i.test(question)) return "btts";
  if (/\bend in a draw\b/i.test(question)) return "draw";
  if (/\bo\/u\b/i.test(question)) return parseTeamTotalTeam(question) ? "team_total" : "total";
  if (/^will .+ win\b/i.test(question)) return "moneyline";
  return "unknown";
}

function isUnsupportedStrategyQuestion(question: string): boolean {
  return /\b(corners?|cards?|bookings?|offsides?|shots?|saves?|passes?|tackles?|fouls?)\b/i.test(question)
    || /\b(1st|first|2nd|second)\s+half\b/i.test(question)
    || /\b(first-half|second-half|halftime|half-time)\b/i.test(question);
}

function parseLine(question: string, marketType: StrategyMarketType): number | null {
  if (marketType === "spread") return parseSpreadLine(question);
  if (marketType === "total" || marketType === "team_total") {
    const match = question.match(/\bO\/U\s+([+-]?\d+(?:\.\d+)?)/i);
    return match?.[1] ? Number(match[1]) : null;
  }
  return null;
}

function parseTeamTotalTeam(question: string): string | undefined {
  const afterColon = question.split(":").slice(1).join(":").trim();
  if (!afterColon) return undefined;
  const match = afterColon.match(/^(.+?)\s+O\/U\b/i);
  return match?.[1]?.trim();
}

function findGameRecord(state: unknown, eventSlug: string): Record<string, unknown> | null {
  const direct = findGamesMapRecord(state, eventSlug);
  if (direct) return direct;

  let match: Record<string, unknown> | null = null;
  walk(state, (value) => {
    if (match || !isRecord(value)) return;
    if (value.event === eventSlug && (typeof value.score === "string" || value.score !== undefined)) {
      match = value;
    }
  });
  return match;
}

function findGamesMapRecord(state: unknown, eventSlug: string): Record<string, unknown> | null {
  let match: Record<string, unknown> | null = null;
  walk(state, (value) => {
    if (match || !isRecord(value)) return;
    const games = value.games;
    if (!isRecord(games)) return;
    const game = games[eventSlug];
    if (isRecord(game)) match = game;
  });
  return match;
}

function findEventTitle(state: unknown, eventSlug: string): string | null {
  let title: string | null = null;
  walk(state, (value) => {
    if (title || !isRecord(value)) return;
    const events = value.events;
    if (isRecord(events) && isRecord(events[eventSlug])) {
      title = stringValue(events[eventSlug].title ?? events[eventSlug].name) ?? null;
      return;
    }
    if (value.slug === eventSlug || value.ticker === eventSlug) {
      title = stringValue(value.title ?? value.name) ?? null;
    }
  });
  return title;
}

function findTeamsFromMarkets(state: unknown, eventSlug: string): { homeTeam: string; awayTeam: string } | null {
  let teams: { homeTeam: string; awayTeam: string } | null = null;
  walk(state, (value) => {
    if (teams || !isRecord(value)) return;
    const marketEventSlug = stringValue(value.eventSlug ?? value.event_slug ?? value.gameSlug);
    const events = Array.isArray(value.events) ? value.events : [];
    const belongsToEvent = marketEventSlug === eventSlug || events.some((event) => isRecord(event) && event.slug === eventSlug);
    if (!belongsToEvent || !Array.isArray(value.teams)) return;

    const home = value.teams.find((team) => isRecord(team) && team.hostStatus === "home");
    const away = value.teams.find((team) => isRecord(team) && team.hostStatus === "away");
    const homeTeam = isRecord(home) ? stringValue(home.name) : undefined;
    const awayTeam = isRecord(away) ? stringValue(away.name) : undefined;
    if (homeTeam && awayTeam) teams = { homeTeam, awayTeam };
  });
  return teams;
}

function parseTitleTeams(title: string | null): { homeTeam: string; awayTeam: string } | null {
  if (!title) return null;
  const match = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+-\s+.+)?$/i);
  if (!match?.[1] || !match[2]) return null;
  return { homeTeam: match[1].trim(), awayTeam: match[2].trim() };
}

function parseScore(score: string | undefined): { homeGoals: number; awayGoals: number } | null {
  if (!score) return null;
  const match = score.match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
  if (!match?.[1] || !match[2]) return null;
  return { homeGoals: Number(match[1]), awayGoals: Number(match[2]) };
}

function parsePeriod(period: string | undefined): MatchPeriod {
  const normalized = period?.trim().toUpperCase();
  if (normalized === "1H" || normalized === "2H" || normalized === "ET" || normalized === "FT") return normalized;
  return "UNKNOWN";
}

function parseElapsedMinute(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string") return 0;
  const match = value.trim().match(/^(\d+)(?:\s*\+\s*(\d+))?/);
  if (!match?.[1]) return 0;
  return Number(match[1]) + (match[2] ? Number(match[2]) : 0);
}

function parseStoppageMinutes(value: unknown): number | undefined {
  const parsed = parseLooseMinute(value);
  return parsed !== null ? parsed : undefined;
}

function parseExpectedEndMinute(value: unknown, period: MatchPeriod, stoppageMinutes: number | undefined): number | undefined {
  const parsed = parseAbsoluteMinute(value);
  if (parsed !== null) return parsed;
  if (period === "2H" && stoppageMinutes !== undefined) return 90 + stoppageMinutes;
  if (period === "ET" && stoppageMinutes !== undefined) return 120 + stoppageMinutes;
  return undefined;
}

function parseRemainingMinutes(value: unknown, minute: number, expectedEndMinute: number | undefined): number | undefined {
  const parsed = parseLooseMinute(value);
  if (parsed !== null) return Math.max(0, parsed);
  if (expectedEndMinute !== undefined) return Math.max(0, expectedEndMinute - minute);
  return undefined;
}

function parseLooseMinute(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string") return null;
  const plus = value.match(/\+\s*(\d+)/);
  if (plus?.[1]) return Number(plus[1]);
  const match = value.match(/(\d+)/);
  return match?.[1] ? Number(match[1]) : null;
}

function parseAbsoluteMinute(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)(?:\s*\+\s*(\d+))?/);
  if (!match?.[1]) return null;
  return Number(match[1]) + (match[2] ? Number(match[2]) : 0);
}

function inflateOrUnzip(buffer: Buffer): Buffer {
  try {
    return inflateSync(buffer);
  } catch {
    return unzipSync(buffer);
  }
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) walk(item, visit);
  }
}

function dedupeMarkets<T extends Pick<StrategyMarket, "conditionId" | "marketSlug">>(markets: T[]): T[] {
  const seen = new Set<string>();
  return markets.filter((market) => {
    const key = `${market.conditionId}:${market.marketSlug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseJsonMaybe(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function tickSizeValue(value: unknown): SpreadMarket["tickSize"] | undefined {
  const parsed = typeof value === "number" ? value.toString() : value;
  return parsed === "0.1" || parsed === "0.01" || parsed === "0.001" || parsed === "0.0001" ? parsed : undefined;
}

function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
