import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ProxyAgent, WebSocket } from "undici";
import type { MatchPeriod, MatchState } from "../domain/types.js";
import type { WorldCupEventRef } from "./worldcup-events.js";

export interface SportsLiveUpdate extends MatchState {
  score: string;
  raw: unknown;
  receivedAt: string;
}

export interface SportsAuditRecord {
  receivedAt: string;
  raw: unknown;
  normalized: unknown;
}

export interface SportsLiveProviderOptions {
  events: readonly WorldCupEventRef[];
  url?: string;
  auditFile?: string;
  proxyUrl?: string;
  onError?: (error: unknown) => void;
}

export type SportsUpdateHandler = (update: SportsLiveUpdate) => Promise<void> | void;

export function normalizeSportsUpdate(
  raw: unknown,
  events: readonly WorldCupEventRef[],
  now = new Date()
): SportsLiveUpdate | null {
  if (!isRecord(raw)) return null;
  const event = matchSportsUpdateToEvent(raw, events);
  if (!event) return null;
  const score = stringValue(raw.score);
  const parsedScore = parseScore(score);
  if (!score || !parsedScore) return null;
  const period = parseSportsPeriod(stringValue(raw.period));
  const elapsed = stringValue(raw.elapsed) ?? "";
  const elapsedSeconds = parseElapsedSeconds(elapsed);
  const remainingSecondFields = [raw.remainingSeconds, raw.remaining_seconds, raw.secondsRemaining, raw.seconds_remaining];
  const remainingTimeFields = [raw.remainingTime, raw.remaining_time];
  const remainingSeconds = firstNumberValue(...remainingSecondFields) ?? firstClockDurationSeconds(...remainingSecondFields, ...remainingTimeFields);
  const remainingMinutes = firstNumberValue(raw.remainingMinutes, raw.remaining_minutes, raw.minutesRemaining, raw.minutes_remaining, ...remainingTimeFields);
  const live = typeof raw.live === "boolean" ? raw.live : raw.gameState === "live" || raw.gameState === "in-progress";
  const ended = raw.ended === true || period === "FT";

  const update: SportsLiveUpdate = {
    eventSlug: event.eventSlug,
    homeTeam: event.homeTeam ?? "UNKNOWN_HOME",
    awayTeam: event.awayTeam ?? "UNKNOWN_AWAY",
    homeGoals: parsedScore.homeGoals,
    awayGoals: parsedScore.awayGoals,
    minute: elapsedSeconds !== undefined ? Math.floor(elapsedSeconds / 60) : 0,
    period,
    isLive: live && !ended,
    ended,
    score,
    elapsed,
    raw,
    receivedAt: now.toISOString()
  };
  if (event.gameId !== undefined) update.gameId = event.gameId;
  if (event.sportradarGameId) update.sportradarGameId = event.sportradarGameId;
  if (elapsedSeconds !== undefined) update.elapsedSeconds = elapsedSeconds;
  if (remainingSeconds !== undefined) update.remainingSeconds = remainingSeconds;
  if (remainingMinutes !== undefined) update.remainingMinutes = remainingMinutes;
  return update;
}

export function matchSportsUpdateToEvent(raw: unknown, events: readonly WorldCupEventRef[]): WorldCupEventRef | null {
  if (!isRecord(raw)) return null;
  const slug = stringValue(raw.slug);
  if (slug) {
    const exact = events.find((event) => event.eventSlug === slug);
    if (exact) return exact;
  }
  const gameId = numberValue(raw.gameId ?? raw.game_id);
  if (gameId !== undefined) {
    const byGameId = events.find((event) => event.gameId === gameId);
    if (byGameId) return byGameId;
  }
  const sportradarGameId = stringValue(raw.sportradarGameId ?? raw.sportradar_game_id);
  if (sportradarGameId) {
    const bySportradar = events.find((event) => event.sportradarGameId === sportradarGameId);
    if (bySportradar) return bySportradar;
  }
  return null;
}

export function parseElapsedSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const clock = value.trim().match(/^(\d+):(\d{1,2})$/);
  if (clock?.[1] && clock[2]) return Number(clock[1]) * 60 + Number(clock[2]);
  const plus = value.trim().match(/^(\d+)\s*\+\s*(\d+)/);
  if (plus?.[1] && plus[2]) return (Number(plus[1]) + Number(plus[2])) * 60;
  const minute = value.trim().match(/^(\d+)'?$/);
  return minute?.[1] ? Number(minute[1]) * 60 : undefined;
}

export async function appendSportsAudit(file: string, record: SportsAuditRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export class SportsLiveProvider {
  constructor(private readonly options: SportsLiveProviderOptions) {}

  connect(onUpdate: SportsUpdateHandler): WebSocket {
    const url = this.options.url ?? "wss://sports-api.polymarket.com/ws";
    const dispatcher = this.options.proxyUrl ? new ProxyAgent(this.options.proxyUrl) : undefined;
    const socket = new WebSocket(url, dispatcher ? { dispatcher } : undefined);

    socket.addEventListener("message", (event) => {
      if (event.data === "ping") {
        socket.send("pong");
        return;
      }
      void this.handleMessage(event.data, onUpdate).catch((error: unknown) => this.reportError(error));
    });

    return socket;
  }

  private async handleMessage(data: unknown, onUpdate: SportsUpdateHandler): Promise<void> {
    try {
      const raw = parseJsonMessage(data);
      if (raw === null) return;
      const normalized = normalizeSportsUpdate(raw, this.options.events);
      if (this.options.auditFile) {
        await appendSportsAudit(this.options.auditFile, {
          receivedAt: new Date().toISOString(),
          raw,
          normalized
        });
      }
      if (normalized) await onUpdate(normalized);
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    try {
      if (this.options.onError) {
        this.options.onError(error);
        return;
      }
      console.error("Sports live provider message handling failed", error);
    } catch {
      // Keep WebSocket event callbacks from surfacing process-level failures.
    }
  }
}

function parseJsonMessage(data: unknown): unknown | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function parseScore(score: string | undefined): { homeGoals: number; awayGoals: number } | null {
  const match = score?.match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
  if (!match?.[1] || !match[2]) return null;
  return { homeGoals: Number(match[1]), awayGoals: Number(match[2]) };
}

function parseSportsPeriod(period: string | undefined): MatchPeriod {
  const normalized = period?.trim().toUpperCase();
  if (normalized === "NS" || normalized === "1H" || normalized === "HT" || normalized === "2H" || normalized === "ET" || normalized === "FT") return normalized;
  return "UNKNOWN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function firstClockDurationSeconds(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = parseClockDurationSeconds(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseClockDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const hms = trimmed.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (hms?.[1] && hms[2] && hms[3]) {
    const hours = Number(hms[1]);
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    if (minutes >= 60 || seconds >= 60) return undefined;
    return hours * 3600 + minutes * 60 + seconds;
  }

  const ms = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (ms?.[1] && ms[2]) {
    const minutes = Number(ms[1]);
    const seconds = Number(ms[2]);
    if (seconds >= 60) return undefined;
    return minutes * 60 + seconds;
  }

  return undefined;
}
