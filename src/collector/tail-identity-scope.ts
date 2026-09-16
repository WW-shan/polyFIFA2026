import type { TailEventIdentity, TailMetadata, TailWindowIdentity } from "./tail-types.js";
import type { JournalRecord } from "./types.js";
import { arrayValue, identifier, objectValue, textValue } from "./replay-values.js";

interface IdentityDrift {
  eventId: string; eventSlug: string | null; sourceRunId: string;
  before: { gameId: string | null; sequence: number; observedAtMs: number };
  after: { gameId: string | null; sequence: number; observedAtMs: number };
}
interface Component { eventIds: string[]; eventSlugs: string[]; gameIds: string[]; witnesses: IdentityDrift[] }
interface EventEvidence {
  eventSlugs: Set<string>; gameIds: Set<string>;
  lastGame?: { gameId: string; sequence: number; observedAtMs: number };
}

/** Retain all historical links, including IDs no longer present in the latest metadata. */
export class TailIdentityScope {
  private readonly parents = new Map<string, string>();
  private readonly ranks = new Map<string, number>();
  private readonly drifts = new Map<string, IdentityDrift>();
  private readonly events = new Map<string, EventEvidence>();

  private event(id: string): EventEvidence {
    const info = this.events.get(id) ?? { eventSlugs: new Set<string>(), gameIds: new Set<string>() };
    this.events.set(id, info); return info;
  }

  private root(node: string): string {
    if (!this.parents.has(node)) this.parents.set(node, node);
    let root = node;
    while (this.parents.get(root)! !== root) root = this.parents.get(root)!;
    while (node !== root) {
      const next = this.parents.get(node)!; this.parents.set(node, root); node = next;
    }
    return root;
  }
  private link(left: string, right: string): void {
    let a = this.root(left), b = this.root(right);
    if (a === b) return;
    const rankA = this.ranks.get(a) ?? 0, rankB = this.ranks.get(b) ?? 0;
    if (rankA < rankB) [a, b] = [b, a];
    this.parents.set(b, a);
    if (rankA === rankB) this.ranks.set(a, rankA + 1);
  }
  /** Normalization may omit incomplete markets/events, but identifiable raw links still count. */
  observeRaw(raw: Record<string, unknown>, record: Pick<JournalRecord, "runId" | "sequence" | "receivedAtMs">): void {
    const eventId = identifier(raw.id);
    const slugs = [textValue(raw.slug), textValue(raw.eventSlug)].filter((value): value is string => value !== undefined);
    const games = [raw.gameId, raw.game_id, objectValue(raw.eventMetadata)?.gameId, objectValue(raw.eventState)?.gameId]
      .map(identifier).filter((value): value is string => value !== undefined);
    const anchor = eventId !== undefined ? "e:" + eventId : slugs.length ? "s:" + slugs[0]! : games.length ? "g:" + games[0]! : undefined;
    if (anchor === undefined) return;
    this.root(anchor);
    if (eventId !== undefined) {
      const info = this.event(eventId);
      if (new Set(slugs).size > 1) throw new Error("TAIL_IDENTITY_CONFLICT: eventSlug fields disagree");
      const previousSlug = info.eventSlugs.values().next().value;
      if (previousSlug !== undefined && slugs.some(slug => slug !== previousSlug)) throw new Error("TAIL_METADATA_IDENTITY_CONFLICT: raw event slug changed for " + eventId);
      for (const slug of slugs) info.eventSlugs.add(slug);
      for (const game of games) info.gameIds.add(game);
      const gameId = games[0];
      if (gameId !== undefined) {
        const current = { gameId, sequence: record.sequence, observedAtMs: record.receivedAtMs };
        if (info.lastGame && info.lastGame.gameId !== gameId && !this.drifts.has(eventId)) this.drifts.set(eventId, {
          eventId, eventSlug: slugs[0] ?? info.eventSlugs.values().next().value ?? null, sourceRunId: record.runId,
          before: info.lastGame, after: current
        });
        info.lastGame = current;
      }
    }
    for (const slug of slugs) this.link(anchor, "s:" + slug);
    for (const game of games) this.link(anchor, "g:" + game);
    for (const value of arrayValue(raw.markets)) {
      const market = objectValue(value); if (!market) continue;
      const marketId = identifier(market.id), conditionId = textValue(market.conditionId);
      if (marketId !== undefined) this.link(anchor, "m:" + marketId);
      if (conditionId !== undefined) this.link(anchor, "c:" + conditionId);
      for (const rawToken of arrayValue(market.clobTokenIds)) {
        const tokenId = textValue(rawToken);
        if (tokenId !== undefined) this.link(anchor, "t:" + tokenId);
      }
    }
  }
  observe(meta: TailMetadata, prior: TailMetadata | undefined, sourceRunId: string): void {
    const info = this.event(meta.eventId);
    info.eventSlugs.add(meta.eventSlug); if (meta.gameId !== null) info.gameIds.add(meta.gameId);
    const event = "e:" + meta.eventId;
    this.link(event, "s:" + meta.eventSlug);
    if (meta.gameId !== null) this.link(event, "g:" + meta.gameId);
    for (const market of meta.markets) {
      this.link(event, "t:" + market.tokenId);
      this.link(event, "c:" + market.conditionId);
      this.link(event, "m:" + market.marketId);
    }
    if (prior && prior.gameId !== meta.gameId && !this.drifts.has(meta.eventId)) this.drifts.set(meta.eventId, {
      eventId: meta.eventId, eventSlug: meta.eventSlug, sourceRunId,
      before: { gameId: prior.gameId, sequence: prior.sequence, observedAtMs: prior.observedAtMs },
      after: { gameId: meta.gameId, sequence: meta.sequence, observedAtMs: meta.observedAtMs }
    });
  }
  resolve(selectedSlugs: readonly string[] | undefined): {
    eventIds: Set<string>; identities: TailWindowIdentity[]; warnings: string[];
    eventIdentities: ReadonlyMap<string, TailEventIdentity>;
  } {
    const groups = new Map<string, Component>();
    for (const drift of this.drifts.values()) {
      const root = this.root("e:" + drift.eventId);
      const group = groups.get(root) ?? { eventIds: [], eventSlugs: [], gameIds: [], witnesses: [] };
      group.witnesses.push(drift); groups.set(root, group);
    }
    const involved = selectedSlugs?.map(slug => this.parents.has("s:" + slug) ? groups.get(this.root("s:" + slug)) : undefined).find(Boolean);
    if (groups.size && (!selectedSlugs?.length || involved)) {
      const group = involved ?? groups.values().next().value!;
      throw new Error("TAIL_METADATA_IDENTITY_CONFLICT: " + JSON.stringify(group.witnesses[0]));
    }
    // Reserve every disputed ID. Dropping a bad slug would let it masquerade
    // as an unknown companion when a later score also names a healthy game.
    const componentGames = new Map<string, string[]>();
    for (const node of this.parents.keys()) {
      const root = this.root(node);
      if (node.startsWith("g:")) { const games = componentGames.get(root) ?? []; games.push(node.slice(2)); componentGames.set(root, games); }
      const group = groups.get(root); if (!group) continue;
      if (node.startsWith("e:")) group.eventIds.push(node.slice(2));
      else if (node.startsWith("s:")) group.eventSlugs.push(node.slice(2));
      else if (node.startsWith("g:")) group.gameIds.push(node.slice(2));
    }
    const components = [...groups.values()];
    const eventIdentities = new Map<string, TailEventIdentity>();
    for (const [eventId, info] of this.events) {
      const root = this.root("e:" + eventId), group = groups.get(root);
      const gameIds = info.gameIds.size ? [...info.gameIds] : componentGames.get(root) ?? [];
      eventIdentities.set(eventId, { eventSlugs: [...info.eventSlugs], gameIds,
        ...(group ? { quarantineKey: "quarantine:event:" + group.eventIds[0]! } : {}),
        ...(!group && !info.gameIds.size && gameIds.length > 1 ? { ambiguousGameIds: true } : {}) });
    }
    return {
      eventIdentities,
      eventIds: new Set(components.flatMap(group => group.eventIds)),
      identities: components.map(group => ({ key: "quarantine:event:" + group.eventIds[0]!, gameId: null,
        eventSlugs: group.eventSlugs, gameIdAliases: group.gameIds })),
      warnings: components.map(group => "quarantined-metadata-identity: " + JSON.stringify(group))
    };
  }
}
