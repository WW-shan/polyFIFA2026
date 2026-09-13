import { isDeepStrictEqual } from "node:util";
import { timeValue } from "../research/history.js";
import { normalizeCollectorEvent } from "./catalog.js";
import { arrayValue, frameType, heartbeat, identifier, objectValue, parsedJson, textValue, timestamp } from "./replay-values.js";
import type { TailMetadata, TailObservation, TailStateChange, TailWindow } from "./tail-types.js";
import type { JournalRecord } from "./types.js";

function gammaEvent(record: JournalRecord): Record<string, unknown> | undefined {
  if (record.source !== "gamma" || record.kind !== "event_metadata") return undefined;
  const data = objectValue(record.data);
  return objectValue(data?.event) ?? objectValue(objectValue(data?.normalized)?.raw);
}

function explicitTime(value: unknown): number | null {
  const time = timeValue(value);
  if (time === null || typeof value !== "string") return null;
  // Date.parse otherwise silently normalizes impossible dates such as February 30.
  const date = value.slice(0, 10);
  const midnight = new Date(date + "T00:00:00Z");
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === date ? time : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sportName(value: string): string {
  const name = value.trim().toLowerCase();
  if (["tennis", "atp", "wta"].includes(name)) return "tennis";
  return name === "football" ? "soccer" : name;
}

function sportFromRaw(raw: Record<string, unknown>): string | null {
  const explicit = textValue(raw.sport) ?? textValue(objectValue(raw.sport)?.sport)
    ?? textValue(objectValue(raw.eventState)?.type);
  if (explicit !== undefined) return sportName(explicit);
  for (const tag of arrayValue(raw.tags)) {
    const slug = textValue(objectValue(tag)?.slug) ?? textValue(tag);
    if (slug === undefined) continue;
    const sport = sportName(slug);
    if (sport === "tennis" || sport === "soccer") return sport;
  }
  return null;
}

function consistentIdentity(field: string, values: Array<string | undefined>): string | null {
  const known = new Set(values.filter((value): value is string => value !== undefined));
  if (known.size > 1) throw new Error(`TAIL_IDENTITY_CONFLICT: ${field} fields disagree`);
  return known.values().next().value ?? null;
}

function identityFromRaw(raw: Record<string, unknown>): Pick<TailObservation, "eventSlug" | "gameId"> {
  return {
    eventSlug: consistentIdentity("eventSlug", [textValue(raw.eventSlug), textValue(raw.slug)]),
    gameId: consistentIdentity("gameId", [identifier(raw.gameId), identifier(raw.game_id),
      identifier(objectValue(raw.eventMetadata)?.gameId), identifier(objectValue(raw.eventState)?.gameId)])
  };
}

/** Resolve against all known windows, before selection filters. Contradictions and ambiguous matches throw. */
export function windowKeyForIdentity(
  identity: Pick<TailObservation, "eventSlug" | "gameId">,
  windows: readonly Pick<TailWindow, "key" | "gameId" | "eventSlugs">[]
): string | undefined {
  let key: string | undefined;
  for (const window of windows) {
    const sameSlug = identity.eventSlug !== null && window.eventSlugs.includes(identity.eventSlug);
    const sameGame = identity.gameId !== null && window.gameId === identity.gameId;
    if (sameSlug && identity.gameId !== null && window.gameId !== null && !sameGame) {
      throw new Error(`TAIL_IDENTITY_CONFLICT: ${identity.eventSlug} belongs to ${window.key}, not game:${identity.gameId}`);
    }
    if (!sameSlug && !sameGame) continue;
    if (key !== undefined && key !== window.key) throw new Error("TAIL_IDENTITY_CONFLICT: ambiguous window");
    key = window.key;
  }
  return key;
}

export function metadataFromRecord(record: JournalRecord): TailMetadata | null {
  const event = normalizeCollectorEvent(gammaEvent(record));
  if (!event) return null;
  const { gameId } = identityFromRaw(event.raw);
  const finishAtMs = explicitTime(event.raw.finishedTimestamp);
  return {
    eventId: event.eventId, eventSlug: event.eventSlug, title: event.title,
    gameId, parentEventId: event.parentEventId,
    sport: sportFromRaw(event.raw), tags: event.tags,
    markets: event.markets.flatMap(market => market.outcomes.map((outcome, index) => ({
      eventId: event.eventId, eventSlug: event.eventSlug, gameId,
      marketId: market.marketId, marketSlug: market.marketSlug, conditionId: market.conditionId,
      tokenId: market.tokenIds[index]!, outcome, question: market.question,
      marketType: textValue(market.raw.sportsMarketType) ?? "unknown",
      closed: market.closed, acceptingOrders: booleanValue(market.raw.acceptingOrders), raw: market.raw
    }))),
    finishAtMs, finishSource: finishAtMs === null ? null : "gamma.finishedTimestamp",
    observedAtMs: record.receivedAtMs, sequence: record.sequence, raw: event.raw
  };
}

function milliseconds(value: unknown): number | null {
  const parsed = timestamp(value);
  return parsed !== undefined && parsed <= 8_640_000_000_000_000n ? Number(parsed) : null;
}

function sourceTime(raw: Record<string, unknown>): number | null {
  const lastUpdate = explicitTime(raw.last_update);
  if (lastUpdate !== null) return lastUpdate;
  for (const state of [objectValue(raw.eventState), raw]) {
    if (!state) continue;
    // Numeric timestamp/timestampMs wire values are milliseconds; never guess seconds.
    const time = explicitTime(state.updatedAt) ?? explicitTime(state.timestamp)
      ?? milliseconds(state.timestampMs) ?? milliseconds(state.timestamp);
    if (time !== null) return time;
  }
  return null;
}

function observation(raw: Record<string, unknown>, record: JournalRecord, source: TailObservation["source"], frameIndex: number): TailObservation | null {
  const state = objectValue(raw.eventState);
  const { eventSlug, gameId } = identityFromRaw(raw);
  if (eventSlug === null && gameId === null) return null;

  const score = raw.score ?? state?.score ?? null;
  const period = raw.period ?? state?.period ?? null;
  const clock = raw.clock ?? raw.elapsed ?? raw.gameTimeDisplay ?? state?.clock ?? state?.elapsed ?? state?.gameTimeDisplay ?? null;
  const live = booleanValue(raw.live) ?? booleanValue(state?.live);
  const ended = booleanValue(raw.ended) ?? booleanValue(state?.ended);
  const finishAtMs = explicitTime(source === "gamma" ? raw.finishedTimestamp : raw.finishedAt);
  if ([score, period, clock, live, ended, finishAtMs].every(value => value === null)) return null;

  return {
    eventSlug, gameId, sport: sportFromRaw(raw), source, sourceAtMs: sourceTime(raw), observedAtMs: record.receivedAtMs,
    sequence: record.sequence, frameIndex, connectionId: record.connectionId ?? null,
    score, period, clock, live, ended, finishAtMs,
    finishSource: finishAtMs === null ? null : source === "gamma" ? "gamma.finishedTimestamp" : "sports.finishedAt",
    raw
  };
}

export function observationsFromRecord(record: JournalRecord): TailObservation[] {
  const gamma = gammaEvent(record);
  if (gamma) {
    const value = observation(gamma, record, "gamma", 0);
    return value ? [value] : [];
  }
  if (record.source !== "sports" || record.kind !== "ws_message") return [];
  const parsed = parsedJson(record.data);
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  const results: TailObservation[] = [];
  for (const [frameIndex, frame] of frames.entries()) {
    const raw = objectValue(frame);
    if (!raw || heartbeat(raw) || /^(ping|pong|heartbeat|keepalive)$/.test(frameType(raw))) continue;
    const value = observation(raw, record, "sports-ws", frameIndex);
    if (value) results.push(value);
  }
  return results;
}

function sameIdentity(previous: TailObservation, next: TailObservation): boolean {
  let shared = false;
  for (const field of ["eventSlug", "gameId"] as const) {
    const before = textValue(previous[field]);
    const after = textValue(next[field]);
    if (before === undefined || after === undefined) continue;
    if (before !== after) return false;
    shared = true;
  }
  return shared;
}

function integerScore(value: unknown): [number, number] | null {
  const match = typeof value === "string" ? /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(value) : null;
  if (!match) return null;
  const home = Number(match[1]);
  const away = Number(match[2]);
  return Number.isSafeInteger(home) && Number.isSafeInteger(away) ? [home, away] : null;
}

function scoreChangeKind(previous: TailObservation, next: TailObservation): TailStateChange["kind"] {
  const sports = [previous.sport, next.sport].filter((sport): sport is string => sport !== null).map(sportName);
  const before = integerScore(previous.score);
  const after = integerScore(next.score);
  if (sports.length === 0 || sports.some(sport => sport !== "soccer") || !before || !after) return "score_change";
  if (after[0] >= before[0] && after[1] >= before[1] && (after[0] > before[0] || after[1] > before[1])) return "score_increase";
  if (after[0] <= before[0] && after[1] <= before[1] && (after[0] < before[0] || after[1] < before[1])) return "score_decrease";
  return "score_change";
}

export function changesBetween(previous: TailObservation | undefined, next: TailObservation): TailStateChange[] {
  if (!previous || previous.source !== next.source || !sameIdentity(previous, next)) return [];
  const changes: TailStateChange[] = [];
  for (const [field, kind] of [["score", "score_change"], ["period", "period_change"], ["ended", "ended_change"]] as const) {
    const before = previous[field];
    const after = next[field];
    // Unknown fields are not a baseline or an observed reset. Raw objects compare without key-order noise.
    if (before == null || after == null || isDeepStrictEqual(before, after)) continue;
    changes.push({
      source: next.source, eventSlug: next.eventSlug, gameId: next.gameId,
      kind: field === "score" ? scoreChangeKind(previous, next) : kind,
      observedAtMs: next.observedAtMs, sourceAtMs: next.sourceAtMs, sequence: next.sequence, frameIndex: next.frameIndex,
      before, after, actualEventTimeKnown: false
    });
  }
  return changes;
}
