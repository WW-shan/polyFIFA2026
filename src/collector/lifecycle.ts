import { collectableTokenIds } from "./catalog.js";
import { observationsFromRecord, windowKeyForIdentity } from "./tail-context.js";
import type { TailObservation } from "./tail-types.js";
import type { CollectorEvent, JournalRecord } from "./types.js";

export interface EventLifecycleState {
  eventId: string; eventSlug: string; gameId: string | null;
  firstSeenAtMs: number; lastSeenAtMs: number;
  terminalObservedAtMs: number | null; finishedAtMs: number | null; retireAtMs: number | null;
  finishSource?: "gamma.finishedTimestamp" | "sports.finishedAt" | null;
  phase: "watching" | "postmatch" | "retired";
  tokenIds: string[];
}

export interface EventLifecycleSelection {
  events: CollectorEvent[];
  tokenIds: string[];
  snapshotTokenIds: string[];
  retired: EventLifecycleState[];
}

function gameKey(state: Pick<EventLifecycleState, "eventId" | "gameId">): string {
  return state.gameId === null ? `event:${state.eventId}` : `game:${state.gameId}`;
}

function openTokens(event: CollectorEvent): string[] {
  // Reconciliation may retain old market mappings when closed metadata omits them.
  return event.raw.closed === true || event.raw.archived === true ? [] : collectableTokenIds([event]);
}

function primaryMoneyline(event: CollectorEvent): boolean {
  return event.gameId !== null && event.parentEventId === null
    && event.markets.some(market => market.raw.sportsMarketType === "moneyline");
}

function observationRecord(source: "gamma" | "sports", data: unknown, nowMs: number): JournalRecord {
  // Adapter to the shared wire validator, never written as journal evidence.
  return { schemaVersion: 1, runId: "", sequence: 0, monotonicNs: "0", receivedAt: new Date(nowMs).toISOString(),
    receivedAtMs: nowMs, source, kind: source === "gamma" ? "event_metadata" : "ws_message", data };
}

/** Subscription retention, not a declaration of complete historical coverage. */
export class EventLifecycle {
  private readonly entries = new Map<string, EventLifecycleState>();
  private currentEvents = new Map<string, CollectorEvent>();
  private readonly sourceClocks = new Map<string, number>();
  private readonly sportsEnds = new Map<string, Pick<TailObservation, "observedAtMs" | "sourceAtMs" | "finishAtMs" | "finishSource">>();
  private readonly gammaGameEnds = new Map<string, { observedAtMs: number; finishAtMs: number; retireAtMs: number }>();
  private readonly metadataTerminals = new Set<string>();
  constructor(private readonly graceMs: number) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new RangeError("postFinishRetentionMs must be a nonnegative integer");
  }
  get states(): EventLifecycleState[] { return [...this.entries.values()].map(state => ({ ...state, tokenIds: [...state.tokenIds] })); }

  select(input: readonly CollectorEvent[], nowMs: number): EventLifecycleSelection {
    for (const event of input) {
      const known = this.entries.get(event.eventId);
      if (known && (known.eventSlug !== event.eventSlug || known.gameId !== event.gameId)) throw new Error("COLLECTOR_EVENT_IDENTITY_CONFLICT");
      const state: EventLifecycleState = known ?? { eventId: event.eventId, eventSlug: event.eventSlug, gameId: event.gameId,
        firstSeenAtMs: nowMs, lastSeenAtMs: nowMs, terminalObservedAtMs: null, finishedAtMs: null, retireAtMs: null,
        phase: "watching", tokenIds: [] };
      state.lastSeenAtMs = nowMs;
      if (state.phase !== "retired") state.tokenIds = [...new Set([...state.tokenIds, ...openTokens(event)])];
      const key = gameKey(state);
      // Gamma catalog edit/start clocks are not Sports game-state clocks. Keep
      // last_update and nested eventState clocks; raw journal evidence is unchanged.
      const { updatedAt: _catalogUpdatedAt, timestamp: _catalogTimestamp, timestampMs: _catalogTimestampMs, ...gameState } = event.raw;
      const observation = observationsFromRecord(observationRecord("gamma", { event: gameState }, nowMs))[0];
      const fresh = !observation || this.acceptClock(key, observation.sourceAtMs);
      const finish = fresh ? observation?.finishAtMs ?? null : null;
      if (event.raw.closed === true || event.raw.archived === true || (fresh && (observation?.ended === true || finish !== null))) {
        this.metadataTerminals.add(event.eventId);
        this.end(state, nowMs, finish, finish === null ? null : "gamma.finishedTimestamp", !known);
      }
      // Only an explicit full-match finish establishes game-wide Gamma evidence.
      // Set/side-market closure (and a bare primary closed flag) remains local.
      if (finish !== null && primaryMoneyline(event) && !this.gammaGameEnds.has(key)) {
        this.gammaGameEnds.set(key, { observedAtMs: nowMs, finishAtMs: finish,
          retireAtMs: this.retirementAt(nowMs, finish, !known) });
      }
      const sportsEnd = this.sportsEnds.get(key);
      if (sportsEnd) this.end(state, sportsEnd.observedAtMs, sportsEnd.finishAtMs, sportsEnd.finishSource);
      this.entries.set(event.eventId, state);
    }
    // Apply after registering the whole sweep, so companion order does not matter.
    // Persist the original deadline for companions discovered after the primary retires.
    for (const state of this.entries.values()) {
      const finish = this.gammaGameEnds.get(gameKey(state));
      if (!finish) continue;
      this.metadataTerminals.add(state.eventId);
      this.end(state, finish.observedAtMs, finish.finishAtMs, "gamma.finishedTimestamp");
      if (state.phase !== "retired") {
        state.terminalObservedAtMs = Math.min(state.terminalObservedAtMs!, finish.observedAtMs);
        state.retireAtMs = Math.min(state.retireAtMs!, finish.retireAtMs);
      }
    }
    this.currentEvents = new Map(input.map(event => [event.eventId, event]));
    return this.tick(nowMs);
  }

  /** Validate identities against all known aliases before applying any sports observation. */
  observeSports(frame: string, receivedAtMs: number): void {
    const windows = new Map<string, { key: string; gameId: string | null; eventSlugs: string[] }>();
    for (const state of this.entries.values()) {
      const key = gameKey(state);
      const window = windows.get(key) ?? { key, gameId: state.gameId, eventSlugs: [] };
      window.eventSlugs.push(state.eventSlug);
      windows.set(key, window);
    }
    const observations = observationsFromRecord(observationRecord("sports", frame, receivedAtMs));
    const matches = observations.map(observation => ({ observation, key: windowKeyForIdentity(observation, [...windows.values()]) }));
    for (const { observation, key } of matches) {
      if (key === undefined || !this.acceptClock(key, observation.sourceAtMs)) continue;
      const previous = this.sportsEnds.get(key);
      if (observation.ended !== true && observation.finishAtMs === null) {
        if (previous && observation.live === true && observation.sourceAtMs !== null && previous.sourceAtMs !== null
          && observation.sourceAtMs > previous.sourceAtMs) {
          this.sportsEnds.delete(key);
          for (const state of this.entries.values()) {
            if (gameKey(state) !== key || state.phase === "retired" || this.metadataTerminals.has(state.eventId)) continue;
            state.phase = "watching";
            state.terminalObservedAtMs = state.retireAtMs = null;
            if (state.finishSource === "sports.finishedAt") { state.finishedAtMs = null; state.finishSource = null; }
          }
        }
        continue;
      }
      // Repeated terminal frames can add an explicit clock, but not extend grace.
      const end = { observedAtMs: previous?.observedAtMs ?? observation.observedAtMs,
        sourceAtMs: observation.sourceAtMs ?? previous?.sourceAtMs ?? null,
        finishAtMs: previous?.finishAtMs ?? observation.finishAtMs, finishSource: previous?.finishSource ?? observation.finishSource };
      this.sportsEnds.set(key, end);
      for (const state of this.entries.values()) {
        if (gameKey(state) === key) this.end(state, end.observedAtMs, end.finishAtMs, end.finishSource);
      }
    }
  }

  /** Advance retention without fetching or reinterpreting metadata. */
  tick(nowMs: number): EventLifecycleSelection {
    const events: CollectorEvent[] = [], tokens = new Set<string>(), snapshots = new Set<string>();
    const retired: EventLifecycleState[] = [];
    for (const state of this.entries.values()) {
      if (state.retireAtMs !== null && nowMs >= state.retireAtMs && state.phase !== "retired") {
        state.phase = "retired";
        retired.push({ ...state, tokenIds: [...state.tokenIds] });
        state.tokenIds = [];
      }
      if (state.phase === "retired") this.currentEvents.delete(state.eventId);
    }
    for (const event of this.currentEvents.values()) {
      const state = this.entries.get(event.eventId)!;
      events.push(event);
      for (const token of state.tokenIds) tokens.add(token);
      for (const token of openTokens(event)) snapshots.add(token);
    }
    // Raw journals retain history; the live retention policy only needs recent tombstones.
    const completed = [...this.entries.values()].filter(state => state.phase === "retired").sort((a, b) => a.lastSeenAtMs - b.lastSeenAtMs);
    for (const state of completed.slice(0, Math.max(0, completed.length - 2048))) this.entries.delete(state.eventId);
    const keys = new Set([...this.entries.values()].map(gameKey));
    for (const key of this.sourceClocks.keys()) if (!keys.has(key)) this.sourceClocks.delete(key);
    for (const key of this.sportsEnds.keys()) if (!keys.has(key)) this.sportsEnds.delete(key);
    for (const key of this.gammaGameEnds.keys()) if (!keys.has(key)) this.gammaGameEnds.delete(key);
    for (const eventId of this.metadataTerminals) if (!this.entries.has(eventId)) this.metadataTerminals.delete(eventId);
    return { events, tokenIds: [...tokens], snapshotTokenIds: [...snapshots], retired };
  }

  private acceptClock(key: string, sourceAtMs: number | null): boolean {
    if (sourceAtMs === null) return true;
    if (sourceAtMs < (this.sourceClocks.get(key) ?? -Infinity)) return false;
    this.sourceClocks.set(key, sourceAtMs);
    return true;
  }

  private end(state: EventLifecycleState, observedAtMs: number, finishAtMs: number | null,
    finishSource: NonNullable<EventLifecycleState["finishSource"]> | null, firstDiscovery = false): void {
    if (finishAtMs !== null && state.finishedAtMs === null) {
      state.finishedAtMs = finishAtMs;
      state.finishSource = finishSource;
    }
    if (state.terminalObservedAtMs !== null || state.phase === "retired") return;
    state.terminalObservedAtMs = observedAtMs;
    state.retireAtMs = this.retirementAt(observedAtMs, finishAtMs, firstDiscovery);
    state.phase = "postmatch";
  }

  private retirementAt(observedAtMs: number, finishAtMs: number | null, firstDiscovery: boolean): number {
    // Already old at first discovery is not a newly recorded full match.
    return firstDiscovery && finishAtMs !== null && finishAtMs + this.graceMs <= observedAtMs
      ? observedAtMs : Math.max(observedAtMs, finishAtMs ?? observedAtMs) + this.graceMs;
  }
}
