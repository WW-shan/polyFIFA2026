import { describe, expect, test } from "vitest";
import { normalizeCollectorEvent } from "../../src/collector/catalog.js";
import { EventLifecycle } from "../../src/collector/lifecycle.js";

function game(id: string, raw: Record<string, unknown> = {}) {
  return normalizeCollectorEvent({ id, slug: id, gameId: `game-${id}`, live: true,
    markets: [{ id: id + "-market", conditionId: id + "-condition", outcomes: ["Yes", "No"], clobTokenIds: [id + "-yes", id + "-no"] }],
    ...raw })!;
}

function matchEvent(id: string, marketType: string, raw: Record<string, unknown> = {}) {
  return game(id, { gameId: "same-match", markets: [{ ...game(id).markets[0]!.raw, sportsMarketType: marketType }], ...raw });
}

describe("primary Gamma match finish", () => {
  test.each([
    { companionFirst: false, closed: false }, { companionFirst: true, closed: false },
    { companionFirst: false, closed: true }, { companionFirst: true, closed: true }
  ])("an explicit moneyline finish retires companions without finish timestamps after grace: %j", ({ companionFirst, closed }) => {
    const lifecycle = new EventLifecycle(1000);
    const parent = matchEvent("parent", "moneyline");
    const companion = matchEvent("companion", "tennis_exact_score", { parentEventId: "parent" });
    const other = game("other");
    const order = (primary: typeof parent, companionClosed = false) => {
      const child = companionClosed ? matchEvent("companion", "tennis_exact_score", { parentEventId: "parent", closed: true }) : companion;
      return companionFirst ? [child, primary, other] : [primary, child, other];
    };
    lifecycle.select(order(parent), 1000);
    const finished = matchEvent("parent", "moneyline", { live: false, finishedTimestamp: new Date(1900).toISOString() });
    lifecycle.select(order(finished, closed), 2000);
    expect(lifecycle.states.filter(state => state.gameId === "same-match")).toEqual([
      expect.objectContaining({ phase: "postmatch", terminalObservedAtMs: 2000, retireAtMs: 3000, finishedAtMs: 1900, finishSource: "gamma.finishedTimestamp" }),
      expect.objectContaining({ phase: "postmatch", terminalObservedAtMs: 2000, retireAtMs: 3000, finishedAtMs: 1900, finishSource: "gamma.finishedTimestamp" })
    ]);
    lifecycle.select(order(finished, closed), 2800);
    expect(lifecycle.tick(2999).tokenIds).toContain("companion-yes");
    const retired = lifecycle.tick(3000);
    expect(retired.retired.map(state => state.eventId).sort()).toEqual(["companion", "parent"]);
    expect(retired.tokenIds).toEqual(["other-yes", "other-no"]);
    expect(lifecycle.tick(4000).retired).toEqual([]);
  });

  test("a companion discovered after the primary retires inherits its original finish and deadline", () => {
    const lifecycle = new EventLifecycle(1000);
    lifecycle.select([matchEvent("parent", "moneyline")], 1000);
    lifecycle.select([matchEvent("parent", "moneyline", { finishedTimestamp: new Date(1900).toISOString() })], 2000);
    lifecycle.tick(3000);
    const selection = lifecycle.select([matchEvent("late", "tennis_exact_score", { parentEventId: "parent" })], 4000);
    expect(selection.tokenIds).toEqual([]);
    expect(selection.retired).toEqual([expect.objectContaining({ eventId: "late", finishedAtMs: 1900,
      terminalObservedAtMs: 2000, retireAtMs: 3000, finishSource: "gamma.finishedTimestamp" })]);
  });

  test("already old primary finishes do not grant a fresh grace period to open companions", () => {
    const lifecycle = new EventLifecycle(1000);
    const selection = lifecycle.select([
      matchEvent("parent", "moneyline", { finishedTimestamp: new Date(1000).toISOString() }),
      matchEvent("companion", "tennis_exact_score", { parentEventId: "parent" })
    ], 4000);
    expect(selection.tokenIds).toEqual([]);
    expect(selection.retired.map(state => state.eventId)).toEqual(["parent", "companion"]);
  });

  test.each([{}, { finishedTimestamp: new Date(1900).toISOString() }])("an early set closure never ends the live parent or another companion: %j", finish => {
    const lifecycle = new EventLifecycle(1000);
    const parent = matchEvent("parent", "moneyline");
    const side = matchEvent("set-one", "tennis_set_handicap", { parentEventId: "parent" });
    const companion = matchEvent("companion", "tennis_exact_score", { parentEventId: "parent" });
    lifecycle.select([parent, side, companion], 1000);
    lifecycle.select([parent, matchEvent("set-one", "tennis_set_handicap", { parentEventId: "parent", closed: true, ...finish }), companion], 2000);
    const selection = lifecycle.tick(3000);
    expect(selection.retired.map(state => state.eventId)).toEqual(["set-one"]);
    expect(selection.tokenIds).toEqual(["parent-yes", "parent-no", "companion-yes", "companion-no"]);
    expect(lifecycle.states.filter(state => state.eventId !== "set-one").every(state => state.phase === "watching" && state.finishedAtMs === null)).toBe(true);
  });

  test("a primary closed flag without an explicit finish remains local to that event", () => {
    const lifecycle = new EventLifecycle(1000);
    const companion = matchEvent("companion", "tennis_exact_score", { parentEventId: "parent" });
    lifecycle.select([matchEvent("parent", "moneyline"), companion], 1000);
    lifecycle.select([matchEvent("parent", "moneyline", { closed: true }), companion], 2000);
    const selection = lifecycle.tick(3000);
    expect(selection.tokenIds).toEqual(["companion-yes", "companion-no"]);
    expect(selection.retired.map(state => state.eventId)).toEqual(["parent"]);
  });

  test("a moneyline child is not promoted into a primary game-finish authority", () => {
    const lifecycle = new EventLifecycle(1000);
    const parent = matchEvent("parent", "moneyline");
    lifecycle.select([parent, matchEvent("set-one", "moneyline", { parentEventId: "parent" })], 1000);
    lifecycle.select([parent, matchEvent("set-one", "moneyline", { parentEventId: "parent", finishedTimestamp: new Date(1900).toISOString() })], 2000);
    expect(lifecycle.tick(3000).tokenIds).toEqual(["parent-yes", "parent-no"]);
    expect(lifecycle.states.find(state => state.eventId === "parent")?.phase).toBe("watching");
  });
});

describe("sports lifecycle evidence", () => {
  test("ended without a finish clock starts grace for all known aliases without inventing a finish", () => {
    const lifecycle = new EventLifecycle(1000);
    const events = [game("A"), game("A-child", { gameId: "game-A" }), game("B")];
    lifecycle.select(events, 1000);
    lifecycle.observeSports?.(JSON.stringify({ slug: "A-child", gameId: "game-A", ended: true }), 2000);
    expect(lifecycle.states.filter(state => state.gameId === "game-A")).toEqual([
      expect.objectContaining({ phase: "postmatch", terminalObservedAtMs: 2000, retireAtMs: 3000, finishedAtMs: null }),
      expect.objectContaining({ phase: "postmatch", terminalObservedAtMs: 2000, retireAtMs: 3000, finishedAtMs: null })
    ]);
    expect(lifecycle.tick?.(2999)?.tokenIds).toEqual(["A-yes", "A-no", "A-child-yes", "A-child-no", "B-yes", "B-no"]);
    const expired = lifecycle.tick?.(3000);
    expect(expired?.tokenIds).toEqual(["B-yes", "B-no"]);
    expect(expired?.retired).toHaveLength(2);
    expect(lifecycle.tick?.(4000)?.retired).toHaveLength(0);
  });

  test("an explicit sports finish keeps its source and repeated ends never restart grace", () => {
    const lifecycle = new EventLifecycle(1000);
    lifecycle.select([game("A")], 1000);
    const frame = JSON.stringify({ game_id: "game-A", finishedAt: new Date(1900).toISOString(), timestampMs: 2000 });
    lifecycle.observeSports?.(frame, 2000);
    lifecycle.observeSports?.(frame, 2800);
    expect(lifecycle.states[0]).toMatchObject({ terminalObservedAtMs: 2000, retireAtMs: 3000, finishedAtMs: 1900, finishSource: "sports.finishedAt" });
    lifecycle.select([game("A")], 2900);
    expect(lifecycle.tick?.(3001)?.tokenIds).toEqual([]);
  });

  test.each([
    { eventSlug: "A", gameId: "game-B", ended: true },
    { eventSlug: "A", slug: "B", ended: true },
    { slug: "A", gameId: "game-A", game_id: "game-B", ended: true },
    { slug: "A", eventState: { gameId: "game-B", ended: true } }
  ])("conflicting identity cannot end either known game: %j", frame => {
    const lifecycle = new EventLifecycle(1000);
    lifecycle.select([game("A"), game("B")], 1000);
    expect(() => lifecycle.observeSports?.(JSON.stringify(frame), 2000)).toThrow("IDENTITY_CONFLICT");
    expect(lifecycle.states.every(state => state.phase === "watching" && state.finishedAtMs === null)).toBe(true);
  });

  test("a stale terminal source clock cannot roll back a newer live observation through another alias", () => {
    const lifecycle = new EventLifecycle(1000);
    lifecycle.select([game("A"), game("child", { gameId: "game-A" })], 1000);
    lifecycle.observeSports?.(JSON.stringify({ slug: "child", live: true, ended: false, last_update: new Date(3000).toISOString() }), 4000);
    lifecycle.observeSports?.(JSON.stringify({ gameId: "game-A", ended: true, finishedAt: new Date(1900).toISOString(), last_update: new Date(2000).toISOString() }), 4500);
    expect(lifecycle.states.every(state => state.phase === "watching" && state.finishedAtMs === null)).toBe(true);
    lifecycle.observeSports?.(JSON.stringify({ gameId: "game-A", ended: true, last_update: new Date(5000).toISOString() }), 5000);
    expect(lifecycle.states.every(state => state.phase === "postmatch" && state.retireAtMs === 6000)).toBe(true);
  });

  test.each([{ last_update: new Date(3000).toISOString() }, { eventState: { live: true, updatedAt: new Date(3000).toISOString() } }])(
    "an actual Gamma game-state source clock rejects an older Sports last_update: %j", sourceClock => {
    const lifecycle = new EventLifecycle(1000);
    lifecycle.select([game("A", sourceClock)], 4000);
    lifecycle.observeSports?.(JSON.stringify({ gameId: "game-A", ended: true, last_update: new Date(2000).toISOString() }), 4500);
    expect(lifecycle.states[0]?.phase).toBe("watching");
    lifecycle.observeSports?.(JSON.stringify({ gameId: "game-A", ended: true, last_update: new Date(5000).toISOString() }), 5000);
    expect(lifecycle.states[0]?.phase).toBe("postmatch");
  });

  test.each([{ updatedAt: new Date(10_000).toISOString() }, { timestamp: new Date(10_000).toISOString() }, { timestampMs: 10_000 }])(
    "catalog timestamps cannot suppress a valid Sports terminal source clock: %j", catalogClock => {
      const lifecycle = new EventLifecycle(1000);
      lifecycle.select([game("A", catalogClock)], 1000);
      lifecycle.observeSports(JSON.stringify({ gameId: "game-A", ended: true, finishedAt: new Date(1900).toISOString(),
        last_update: new Date(2000).toISOString() }), 2000);
      expect(lifecycle.states[0]).toMatchObject({ phase: "postmatch", finishedAtMs: 1900, retireAtMs: 3000, finishSource: "sports.finishedAt" });
      expect(lifecycle.tick(3000).tokenIds).toEqual([]);
    });

  test("catalog updatedAt cannot block a Sports live correction or make an old Sports end current again", () => {
    const lifecycle = new EventLifecycle(2000);
    lifecycle.select([game("A")], 1000);
    lifecycle.observeSports(JSON.stringify({ gameId: "game-A", ended: true, last_update: new Date(2000).toISOString() }), 2000);
    lifecycle.select([game("A", { updatedAt: new Date(10_000).toISOString() })], 2500);
    lifecycle.observeSports(JSON.stringify({ gameId: "game-A", live: true, ended: false, last_update: new Date(3000).toISOString() }), 3000);
    lifecycle.observeSports(JSON.stringify({ gameId: "game-A", ended: true, last_update: new Date(2000).toISOString() }), 3500);
    expect(lifecycle.states[0]).toMatchObject({ phase: "watching", finishedAtMs: null, retireAtMs: null });
    lifecycle.observeSports(JSON.stringify({ gameId: "game-A", ended: true, last_update: new Date(4000).toISOString() }), 4000);
    expect(lifecycle.states[0]).toMatchObject({ phase: "postmatch", retireAtMs: 6000 });
  });

  test("a newer live correction clears sports-only grace and old terminal repeats cannot restore it", () => {
    const lifecycle = new EventLifecycle(2000);
    lifecycle.select([game("A"), game("child", { gameId: "game-A" })], 1000);
    const ended = JSON.stringify({ gameId: "game-A", ended: true, timestampMs: 2000, finishedAt: new Date(1900).toISOString() });
    lifecycle.observeSports(ended, 2000);
    // Closed metadata remains authoritative for this individual event.
    lifecycle.select([game("A", { closed: true }), game("child", { gameId: "game-A" })], 2200);
    lifecycle.observeSports(JSON.stringify({ gameId: "game-A", live: true, ended: false, timestampMs: 3000 }), 3000);
    lifecycle.observeSports(ended, 3100);
    expect(lifecycle.states.find(state => state.eventId === "child")).toMatchObject({
      phase: "watching", terminalObservedAtMs: null, retireAtMs: null, finishedAtMs: null
    });
    expect(lifecycle.states.find(state => state.eventId === "A")?.phase).toBe("postmatch");
    expect(lifecycle.tick(5000).tokenIds).toEqual(["child-yes", "child-no"]);
  });

  test.each(["ping", "not JSON", JSON.stringify({ gameId: "unknown", ended: true }),
    JSON.stringify({ gameId: "game-A", ended: "true", finishedAt: "2026-02-30T12:00:00Z" }),
    JSON.stringify({ gameId: "game-A", finishedAt: 12345 }),
    JSON.stringify({ gameId: "game-A", endDate: "2026-01-01T12:00:00Z" })
  ])("unknown or invalid terminal evidence is ignored: %s", frame => {
    const lifecycle = new EventLifecycle(1000);
    lifecycle.select([game("A")], 1000);
    lifecycle.observeSports?.(frame, 2000);
    expect(lifecycle.states[0]).toMatchObject({ phase: "watching", finishedAtMs: null, retireAtMs: null });
  });

  test("closed metadata without markets retains WS grace but never polls its previously open books", () => {
    const lifecycle = new EventLifecycle(1000);
    const original = game("A");
    lifecycle.select([original], 1000);
    lifecycle.select([{ ...original, raw: { ...original.raw, closed: true, markets: [] } }], 2000);
    const selection = lifecycle.tick?.(2500);
    expect(selection?.tokenIds).toEqual(["A-yes", "A-no"]);
    expect(selection?.snapshotTokenIds).toEqual([]);
    expect(lifecycle.tick?.(3000)?.retired[0]).toMatchObject({ eventId: "A", finishedAtMs: null });
  });

  test("a related alias discovered during grace shares the original sports end clock", () => {
    const lifecycle = new EventLifecycle(1000);
    lifecycle.select([game("A")], 1000);
    lifecycle.observeSports?.(JSON.stringify({ gameId: "game-A", ended: true }), 2000);
    lifecycle.select([game("A"), game("child", { gameId: "game-A" })], 2900);
    expect(lifecycle.states.map(state => state.retireAtMs)).toEqual([3000, 3000]);
    expect(lifecycle.tick?.(3000)?.tokenIds).toEqual([]);
  });
});
