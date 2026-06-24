import { fetchJson } from "./http.js";

interface GammaEventRecord {
  slug?: unknown;
  closed?: unknown;
  archived?: unknown;
  active?: unknown;
  title?: unknown;
  name?: unknown;
  startTime?: unknown;
  startDate?: unknown;
  gameId?: unknown;
  sportradarGameId?: unknown;
  eventMetadata?: unknown;
}

export interface WorldCupEventRef {
  eventSlug: string;
  gameId?: number;
  sportradarGameId?: string;
  homeTeam?: string;
  awayTeam?: string;
  startTime?: string;
}

export async function fetchOpenWorldCupEventRefs(): Promise<WorldCupEventRef[]> {
  const url = "https://gamma-api.polymarket.com/events?series_slug=soccer-fifwc&closed=false&limit=100&order=startDate&ascending=true";
  const response = await fetchJson<unknown>(url);
  return normalizeWorldCupEventRefs(normalizeGammaEvents(response));
}

export async function fetchOpenWorldCupEventSlugs(): Promise<string[]> {
  return (await fetchOpenWorldCupEventRefs()).map((event) => event.eventSlug);
}

export function normalizeWorldCupEventRefs(records: readonly GammaEventRecord[]): WorldCupEventRef[] {
  const seen = new Set<string>();
  const refs: WorldCupEventRef[] = [];

  for (const event of records) {
    if (!isOpenSingleMatchWorldCupEvent(event)) continue;
    const eventSlug = event.slug as string;
    if (seen.has(eventSlug)) continue;
    seen.add(eventSlug);

    const ref: WorldCupEventRef = { eventSlug };
    const gameId = numberValue(event.gameId ?? getNested(event, ["eventMetadata", "gameId"]));
    if (gameId !== undefined) ref.gameId = gameId;
    const sportradarGameId = stringValue(getNested(event, ["eventMetadata", "sportradarGameId"]) ?? event.sportradarGameId);
    if (sportradarGameId) ref.sportradarGameId = sportradarGameId;
    const title = stringValue(event.title ?? event.name);
    const teams = parseTitleTeams(title);
    if (teams) {
      ref.homeTeam = teams.homeTeam;
      ref.awayTeam = teams.awayTeam;
    }
    const startTime = stringValue(event.startTime ?? event.startDate);
    if (startTime) ref.startTime = startTime;
    refs.push(ref);
  }

  return refs;
}

function normalizeGammaEvents(response: unknown): GammaEventRecord[] {
  if (Array.isArray(response)) return response.filter(isRecord);
  if (isObjectRecord(response) && Array.isArray(response.events)) return response.events.filter(isRecord);
  return [];
}

function isOpenSingleMatchWorldCupEvent(event: GammaEventRecord): boolean {
  const slug = typeof event.slug === "string" ? event.slug : "";
  return /^fifwc-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/i.test(slug)
    && !slug.toLowerCase().includes("more")
    && event.closed !== true
    && event.archived !== true
    && event.active !== false;
}

function isRecord(value: unknown): value is GammaEventRecord {
  return typeof value === "object" && value !== null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function getNested(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObjectRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function parseTitleTeams(title: string | undefined): { homeTeam: string; awayTeam: string } | null {
  if (!title) return null;
  const match = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+-\s+.+)?$/i);
  if (!match?.[1] || !match[2]) return null;
  return { homeTeam: match[1].trim(), awayTeam: match[2].trim() };
}
