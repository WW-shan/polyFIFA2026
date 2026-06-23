import { fetchJson } from "./http.js";

interface GammaEventRecord {
  slug?: unknown;
  closed?: unknown;
  archived?: unknown;
  active?: unknown;
}

export async function fetchOpenWorldCupEventSlugs(): Promise<string[]> {
  const url = "https://gamma-api.polymarket.com/events?series_slug=soccer-fifwc&closed=false&limit=100&order=startDate&ascending=true";
  const response = await fetchJson<unknown>(url);
  const records = normalizeGammaEvents(response);
  return [...new Set(records.filter(isOpenSingleMatchWorldCupEvent).map((event) => event.slug as string))];
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
