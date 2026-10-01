import { discoverSportsEvents } from "../../collector/catalog.js";
import type { CollectorEvent, JsonRequester } from "../../collector/types.js";
import type { OrderbookSnapshot } from "../../domain/types.js";
import { normalizeOrderbook, type RawOrderbook } from "../../polymarket/clob.js";
import { matchEspnGame, teamsMatch, type EspnGame } from "./espn.js";

export interface ShadowLeague {
  name: string;
  tagId: string;
  espnSport: string;
  finalPeriod: number;
  periodSeconds: number;
}

export const SHADOW_LEAGUES: Record<string, ShadowLeague> = {
  nfl: { name: "nfl", tagId: "450", espnSport: "football/nfl", finalPeriod: 4, periodSeconds: 900 },
  nba: { name: "nba", tagId: "745", espnSport: "basketball/nba", finalPeriod: 4, periodSeconds: 720 }
};

export interface ShadowMarketRef {
  league: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  startMs: number | null;
  marketId: string;
  marketSlug: string;
  conditionId: string;
  question: string;
  outcomes: [string, string];
  tokens: [string, string];
}

function timeValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function selectMoneyline(event: CollectorEvent, league: string): ShadowMarketRef | null {
  for (const market of event.markets) {
    if (market.raw.sportsMarketType !== "moneyline") continue;
    if (market.closed || !market.collectable) continue;
    if (market.outcomes.length !== 2 || market.tokenIds.length !== 2 || market.outcomes.some(name => !name.trim())) continue;
    const startMs = timeValue(event.raw.startTime) ?? timeValue(market.raw.gameStartTime);
    return {
      league,
      eventId: event.eventId,
      eventSlug: event.eventSlug,
      eventTitle: event.title,
      startMs,
      marketId: market.marketId,
      marketSlug: market.marketSlug,
      conditionId: market.conditionId,
      question: market.question,
      outcomes: [market.outcomes[0]!, market.outcomes[1]!],
      tokens: [market.tokenIds[0]!, market.tokenIds[1]!]
    };
  }
  return null;
}

export interface DiscoverDependencies {
  request: JsonRequester;
  now?: () => number;
  lookbackHours?: number;
  aheadHours?: number;
}

export async function discoverLeagueMarkets(league: ShadowLeague, deps: DiscoverDependencies): Promise<ShadowMarketRef[]> {
  const options = {
    tagId: league.tagId,
    sports: [] as string[],
    dateWindow: "game-start" as const,
    serverStartTimeWindow: true,
    lookbackHours: deps.lookbackHours ?? 6,
    aheadHours: deps.aheadHours ?? 2,
    pageSize: 20,
    maxPages: 10,
    ...(deps.now ? { now: deps.now } : {})
  };
  const events = await discoverSportsEvents(options, { request: deps.request });
  return events.map(event => selectMoneyline(event, league.name)).filter((market): market is ShadowMarketRef => market !== null);
}

export interface MarketLink {
  game: EspnGame;
  homeIndex: 0 | 1;
  awayIndex: 0 | 1;
}

export function linkMarketToGame(market: ShadowMarketRef, games: readonly EspnGame[]): MarketLink | null {
  const game = matchEspnGame(games, { names: market.outcomes, startMs: market.startMs });
  if (!game) return null;
  const firstHome = teamsMatch(game.home.names, market.outcomes[0]) && teamsMatch(game.away.names, market.outcomes[1]);
  const secondHome = teamsMatch(game.home.names, market.outcomes[1]) && teamsMatch(game.away.names, market.outcomes[0]);
  if (firstHome && !secondHome) return { game, homeIndex: 0, awayIndex: 1 };
  if (secondHome && !firstHome) return { game, homeIndex: 1, awayIndex: 0 };
  return null;
}

export function bookTokenIds(market: ShadowMarketRef, homeIndex: 0 | 1): { home: string; away: string } {
  return { home: market.tokens[homeIndex], away: market.tokens[homeIndex === 0 ? 1 : 0] };
}

export function assetIdOf(raw: RawOrderbook): string | null {
  return raw.asset_id ?? raw.assetId ?? raw.tokenId ?? null;
}

export interface MarketBook {
  tokenId: string;
  book: OrderbookSnapshot;
  requestStartedAtMs: number;
  receivedAtMs: number;
  bookTimestampMs: number | null;
}

export interface BookDependencies {
  request: (url: string) => Promise<unknown>;
  now: () => number;
  baseUrl?: string;
}

export async function fetchMarketBook(tokenId: string, deps: BookDependencies): Promise<MarketBook> {
  const base = (deps.baseUrl ?? "https://clob.polymarket.com").replace(/\/+$/, "");
  const url = `${base}/book?token_id=${encodeURIComponent(tokenId)}`;
  const requestStartedAtMs = deps.now();
  const raw = await deps.request(url) as RawOrderbook;
  const receivedAtMs = deps.now();
  const assetId = assetIdOf(raw);
  if (assetId !== null && assetId !== tokenId) {
    throw new Error(`SHADOW_BOOK_TOKEN_MISMATCH: requested ${tokenId} but received ${assetId}`);
  }
  const book = normalizeOrderbook(raw);
  const timestampMs = raw.timestamp === undefined ? null : Number(raw.timestamp);
  return {
    tokenId,
    book,
    requestStartedAtMs,
    receivedAtMs,
    bookTimestampMs: timestampMs !== null && Number.isFinite(timestampMs) ? timestampMs : null
  };
}
