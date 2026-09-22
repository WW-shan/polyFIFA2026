import { discoverSportsEvents, normalizeCollectorEvent, type CatalogDependencies, type CatalogOptions } from "./catalog.js";
import type { SportProfile } from "./continuous-config.js";
import { classifyMatchScope } from "./match-scope.js";
import { expandRelatedEvents } from "./related-catalog.js";
import type { CollectorEvent } from "./types.js";

export interface DiscoveryIssue {
  scope: "profile" | "related" | "match-scope";
  /** Profile name, related gameId, or ambiguous eventId, respectively. */
  key: string;
  message: string;
}

const RELATED_DISCOVERY_CONCURRENCY = 8;

async function settleInOrder<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<CollectorEvent[]>
): Promise<PromiseSettledResult<CollectorEvent[]>[]> {
  const results = new Array<PromiseSettledResult<CollectorEvent[]>>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      try {
        results[index] = { status: "fulfilled", value: await operation(values[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function fail(code: string, message: string): never {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  throw error;
}

/** A batch is accepted in full only after checking both identity indexes. */
class EventIndex {
  readonly events: CollectorEvent[] = [];
  private readonly byId = new Map<string, CollectorEvent>();
  private readonly bySlug = new Map<string, CollectorEvent>();

  merge(events: readonly CollectorEvent[]): void {
    const pendingIds = new Map<string, CollectorEvent>();
    const pendingSlugs = new Map<string, CollectorEvent>();
    for (const event of events) {
      const idMatch = this.byId.get(event.eventId) ?? pendingIds.get(event.eventId);
      const slugMatch = this.bySlug.get(event.eventSlug) ?? pendingSlugs.get(event.eventSlug);
      for (const existing of [idMatch, slugMatch]) {
        if (existing && (existing.eventId !== event.eventId || existing.eventSlug !== event.eventSlug || existing.gameId !== event.gameId)) {
          fail("CONTINUOUS_DISCOVERY_IDENTITY_CONFLICT", `conflicting ID, slug, or gameId for event ${event.eventId} (${event.eventSlug})`);
        }
      }
      if (idMatch || slugMatch) continue;
      pendingIds.set(event.eventId, event);
      pendingSlugs.set(event.eventSlug, event);
    }
    for (const event of pendingIds.values()) {
      this.byId.set(event.eventId, event);
      this.bySlug.set(event.eventSlug, event);
      this.events.push(event);
    }
  }
}

function profileDependencies(deps: CatalogDependencies): CatalogDependencies {
  const seen = new EventIndex();
  return {
    ...deps,
    async onPage(page) {
      await deps.onPage?.(page);
      const response = page.response;
      const values = Array.isArray(response) ? response
        : typeof response === "object" && response !== null && "events" in response && Array.isArray(response.events)
          ? response.events : [response];
      // Check raw pages before the base catalog silently deduplicates IDs/slugs.
      seen.merge(values.map(normalizeCollectorEvent).filter((event): event is CollectorEvent => event !== null));
    }
  };
}

function issueMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "Error";
  const parts = [message.trim() || (name && name !== "Error" ? name : "request failed")];
  const seen = new Set<unknown>([error]);
  let cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  for (let depth = 0; cause !== undefined && depth < 4 && !seen.has(cause); depth += 1) {
    seen.add(cause);
    if (cause instanceof Error) {
      const causeMessage = cause.message.trim();
      const code = typeof (cause as NodeJS.ErrnoException).code === "string" ? (cause as NodeJS.ErrnoException).code : undefined;
      if (causeMessage || code) parts.push(`${causeMessage || cause.name}${code ? ` (${code})` : ""}`);
      cause = (cause as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(cause));
      cause = undefined;
    }
  }
  return parts.join(": ").replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@").slice(0, 2000);
}

function singleMatchEvents(events: readonly CollectorEvent[], onIssue: (issue: DiscoveryIssue) => void): CollectorEvent[] {
  const scopes = new Map(events.map(event => [event.eventId, classifyMatchScope(event)]));
  const admitted = new Set<string>();
  const pending: string[] = [];
  const children = new Map<string, string[]>();
  for (const event of events) {
    const scope = scopes.get(event.eventId)!;
    if (scope.kind === "single-match") {
      admitted.add(event.eventId);
      pending.push(event.eventId);
    } else if (scope.kind === "ambiguous" && event.parentEventId !== null) {
      const siblings = children.get(event.parentEventId) ?? [];
      siblings.push(event.eventId);
      children.set(event.parentEventId, siblings);
    }
  }
  // Explicit parent links preserve side markets without inventing game IDs.
  // An unanchored cycle or an unknown parent does not establish match scope.
  for (const parentId of pending) {
    for (const childId of children.get(parentId) ?? []) {
      if (admitted.has(childId)) continue;
      admitted.add(childId);
      pending.push(childId);
    }
  }
  return events.filter(event => {
    if (admitted.has(event.eventId)) return true;
    const scope = scopes.get(event.eventId)!;
    if (scope.kind === "ambiguous") {
      onIssue({ scope: "match-scope", key: event.eventId, message: `AMBIGUOUS_MATCH_SCOPE: ${scope.reason}` });
    }
    return false;
  });
}

export async function discoverContinuousEvents(
  options: CatalogOptions,
  deps: CatalogDependencies,
  profiles: readonly SportProfile[],
  onIssue: (issue: DiscoveryIssue) => void = () => {}
): Promise<CollectorEvent[]> {
  // Every invocation contains only this sweep's completed, fresh responses.
  const fresh = new EventIndex();
  let successfulProfiles = 0;
  for (const profile of profiles) {
    const profileOptions = { ...options, tagId: profile.tagId, sports: [], dateWindow: "game-start" as const };
    if (!options.liveDiscovery) {
      try {
        const roots = await discoverSportsEvents(profileOptions, profileDependencies(deps));
        fresh.merge(roots);
        successfulProfiles += 1;
      } catch (error) {
        onIssue({ scope: "profile", key: profile.name, message: issueMessage(error) });
      }
      continue;
    }

    // Gamma can return megabytes per page for a busy tag. Fetch the bounded
    // scheduled window and live events as separate small pages instead of
    // downloading every open event; a failure in one half must not discard the
    // other half when it succeeded.
    // Ongoing games are covered by the live query; the scheduled half only
    // needs a short catch-up window for games whose live flag has not flipped
    // yet. Keeping this at one hour avoids downloading the whole open catalog.
    const scheduledOptions = { ...profileOptions,
      lookbackHours: Math.min(profileOptions.lookbackHours ?? 6, 1) };
    const halves = await Promise.allSettled([
      discoverSportsEvents({ ...scheduledOptions, serverStartTimeWindow: true }, profileDependencies(deps)),
      discoverSportsEvents({ ...profileOptions, liveOnly: true }, profileDependencies(deps))
    ]);
    let profileSucceeded = false;
    for (const half of halves) {
      if (half.status === "fulfilled") {
        fresh.merge(half.value);
        profileSucceeded = true;
      } else {
        onIssue({ scope: "profile", key: profile.name, message: issueMessage(half.reason) });
      }
    }
    if (profileSucceeded) successfulProfiles += 1;
  }
  if (successfulProfiles === 0) fail("CONTINUOUS_DISCOVERY_FAILED", "no sport profile completed discovery");

  const games = new Map<string, CollectorEvent[]>();
  for (const event of fresh.events) {
    if (event.gameId === null) continue;
    if (options.singleMatchOnly && classifyMatchScope(event).kind !== "single-match") continue;
    const roots = games.get(event.gameId);
    if (roots) roots.push(event);
    else games.set(event.gameId, [event]);
  }
  const gameEntries = [...games.entries()];
  const relatedResults = await settleInOrder(gameEntries, RELATED_DISCOVERY_CONCURRENCY,
    ([, roots]) => expandRelatedEvents(roots, {
      ...options, maxPages: Math.min(options.maxPages ?? 20, 20)
    }, deps));
  for (let index = 0; index < relatedResults.length; index += 1) {
    const result = relatedResults[index]!;
    if (result.status === "fulfilled") {
      try {
        fresh.merge(result.value);
      } catch (error) {
        onIssue({ scope: "related", key: gameEntries[index]![0], message: issueMessage(error) });
      }
    } else {
      onIssue({ scope: "related", key: gameEntries[index]![0], message: issueMessage(result.reason) });
    }
  }
  return options.singleMatchOnly ? singleMatchEvents(fresh.events, onIssue) : fresh.events;
}
