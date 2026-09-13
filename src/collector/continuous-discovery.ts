import { discoverSportsEvents, normalizeCollectorEvent, type CatalogDependencies, type CatalogOptions } from "./catalog.js";
import type { SportProfile } from "./continuous-config.js";
import { expandRelatedEvents } from "./related-catalog.js";
import type { CollectorEvent } from "./types.js";

export interface DiscoveryIssue {
  scope: "profile" | "related";
  /** Profile name for profile issues; gameId for related issues. */
  key: string;
  message: string;
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
  return message.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@");
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
    try {
      const roots = await discoverSportsEvents({
        ...options, tagId: profile.tagId, sports: [], dateWindow: "game-start"
      }, profileDependencies(deps));
      fresh.merge(roots);
      successfulProfiles += 1;
    } catch (error) {
      onIssue({ scope: "profile", key: profile.name, message: issueMessage(error) });
    }
  }
  if (successfulProfiles === 0) fail("CONTINUOUS_DISCOVERY_FAILED", "no sport profile completed discovery");

  const games = new Map<string, CollectorEvent[]>();
  for (const event of fresh.events) {
    if (event.gameId === null) continue;
    const roots = games.get(event.gameId);
    if (roots) roots.push(event);
    else games.set(event.gameId, [event]);
  }
  for (const [gameId, roots] of games) {
    try {
      const related = await expandRelatedEvents(roots, {
        ...options, maxPages: Math.min(options.maxPages ?? 20, 20)
      }, deps);
      fresh.merge(related);
    } catch (error) {
      onIssue({ scope: "related", key: gameId, message: issueMessage(error) });
    }
  }
  return fresh.events;
}
