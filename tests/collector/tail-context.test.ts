import { describe, expect, test } from "vitest";
import { normalizeCollectorEvent } from "../../src/collector/catalog.js";
import { changesBetween, metadataFromRecord, observationsFromRecord } from "../../src/collector/tail-context.js";
import type { TailObservation } from "../../src/collector/tail-types.js";
import type { JournalRecord } from "../../src/collector/types.js";

const receivedAtMs = Date.parse("2026-09-11T11:27:00.000Z");
const finishedTimestamp = "2026-09-11T11:26:03.63953Z";
const tokenA = "8944870794724982616739737855931128457392338556453357131507170402314088626403";
const tokenB = "88669986253050959394429898768455959663720039095515426056968574192793109008117";

function record(source: JournalRecord["source"], kind: string, data: unknown, overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    schemaVersion: 1, runId: "tail-context", sequence: 17, receivedAtMs,
    receivedAt: new Date(receivedAtMs).toISOString(), monotonicNs: "17000000000",
    source, kind, data, ...overrides
  };
}

function market(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "winner", slug: "a-v-b-winner", conditionId: "0xcondition", question: "A vs B",
    sportsMarketType: "moneyline", outcomes: '["A","B"]', clobTokenIds: JSON.stringify([tokenA, tokenB]),
    closed: false, acceptingOrders: true, description: "Retirement and walkover rules",
    ...overrides
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-1", slug: "a-v-b-more-markets", title: "A vs B: More Markets", gameId: 123,
    parentEventId: "parent-1", tags: [{ slug: "tennis" }, { slug: "atp" }],
    startDate: "2026-09-01T00:00:00Z", startTime: "2026-09-11T10:00:00Z",
    endDate: "2026-09-18T10:00:00Z", finishedTimestamp, markets: [market()],
    ...overrides
  };
}

function gamma(raw = event(), overrides: Partial<JournalRecord> = {}): JournalRecord {
  return record("gamma", "event_metadata", { event: raw, normalized: normalizeCollectorEvent(raw), status: "reconciled" }, overrides);
}

function sports(frame: unknown, overrides: Partial<JournalRecord> = {}): JournalRecord {
  return record("sports", "ws_message", typeof frame === "string" ? frame : JSON.stringify(frame), {
    connectionId: "sports-0-e1", ...overrides
  });
}

function state(overrides: Partial<TailObservation> = {}): TailObservation {
  return {
    eventSlug: "a-v-b", gameId: "123", sport: "soccer", source: "sports-ws", sourceAtMs: null,
    observedAtMs: receivedAtMs, sequence: 17, frameIndex: 0, connectionId: "sports-0-e1",
    score: "0-0", period: "2H", clock: "89:00", live: true, ended: false,
    finishAtMs: null, finishSource: null, raw: {}, ...overrides
  };
}

describe("tail metadata", () => {
  test("retains every outcome, exact string IDs, match identity and original rules", () => {
    const rawMarket = market();
    const raw = event({ markets: [rawMarket] });
    const metadata = metadataFromRecord(gamma(raw));

    expect(metadata).toMatchObject({
      eventId: "event-1", eventSlug: "a-v-b-more-markets", title: "A vs B: More Markets",
      gameId: "123", parentEventId: "parent-1", sport: "tennis", tags: ["tennis", "atp"],
      finishAtMs: Date.parse(finishedTimestamp), finishSource: "gamma.finishedTimestamp",
      observedAtMs: receivedAtMs, sequence: 17
    });
    expect(metadata?.markets).toEqual([
      { eventId: "event-1", eventSlug: "a-v-b-more-markets", gameId: "123", marketId: "winner",
        marketSlug: "a-v-b-winner", conditionId: "0xcondition", tokenId: tokenA, outcome: "A", question: "A vs B",
        marketType: "moneyline", closed: false, acceptingOrders: true, raw: rawMarket },
      { eventId: "event-1", eventSlug: "a-v-b-more-markets", gameId: "123", marketId: "winner",
        marketSlug: "a-v-b-winner", conditionId: "0xcondition", tokenId: tokenB, outcome: "B", question: "A vs B",
        marketType: "moneyline", closed: false, acceptingOrders: true, raw: rawMarket }
    ]);
    expect(metadata?.raw).toBe(raw);
    expect(metadata?.markets[0]?.raw).toBe(rawMarket);
    expect(metadata?.markets[1]?.raw).toBe(rawMarket);
    expect(metadata?.markets[0]?.raw.description).toBe("Retirement and walkover rules");
  });

  test("keeps closed, paused, archived, subperiod and unknown markets in source order", () => {
    const rawMarkets = [
      market({ id: "set", sportsMarketType: "tennis_first_set_winner", closed: true }),
      market({ id: "paused", sportsMarketType: "future_type", acceptingOrders: false, active: false, enableOrderBook: false }),
      market({ id: "archived", sportsMarketType: undefined, archived: true, acceptingOrders: undefined })
    ];
    const metadata = metadataFromRecord(gamma(event({ closed: true, markets: rawMarkets })));

    expect(metadata?.markets.map(m => [m.marketId, m.outcome, m.marketType, m.closed, m.acceptingOrders])).toEqual([
      ["set", "A", "tennis_first_set_winner", true, true], ["set", "B", "tennis_first_set_winner", true, true],
      ["paused", "A", "future_type", false, false], ["paused", "B", "future_type", false, false],
      ["archived", "A", "unknown", false, null], ["archived", "B", "unknown", false, null]
    ]);
    expect(metadata?.markets[4]?.raw).toBe(rawMarkets[2]);
  });

  test("keeps non-binary outcomes and leading zeros without coercing token IDs", () => {
    const raw = event({ markets: [market({ outcomes: ["Home", "Draw", "Away"], clobTokenIds: ["0001", "0002", "0003"] })] });
    expect(metadataFromRecord(gamma(raw))?.markets.map(m => [m.tokenId, m.outcome])).toEqual([
      ["0001", "Home"], ["0002", "Draw"], ["0003", "Away"]
    ]);
  });

  test.each([
    [Number(tokenA), Number(tokenB)], [123, 456], [tokenA, ""], [tokenA], "not JSON"
  ].map(value => [value]))("rejects an invalid token mapping %j without losing valid markets", clobTokenIds => {
    const raw = event({ markets: [market({ id: "invalid", clobTokenIds }), market()] });
    expect(metadataFromRecord(gamma(raw))?.markets.map(m => m.tokenId)).toEqual([tokenA, tokenB]);
  });

  test("does not trust a cached normalized token mapping over unsafe raw IDs", () => {
    const raw = event({ markets: [market({ clobTokenIds: [Number(tokenA), Number(tokenB)] })] });
    const cached = normalizeCollectorEvent(event())!;
    const input = record("gamma", "event_metadata", { event: raw, normalized: cached, status: "discovered" });
    expect(metadataFromRecord(input)?.markets).toEqual([]);
    expect(metadataFromRecord(input)?.raw).toBe(raw);
  });

  test("uses the collector's identity and label fallbacks", () => {
    const raw = event({ id: 0, title: "", gameId: undefined, eventMetadata: { gameId: "000123" }, parentEventId: 0,
      markets: [market({ id: 0, slug: "", question: "", acceptingOrders: "false" })] });
    expect(metadataFromRecord(gamma(raw))).toMatchObject({ eventId: "0", title: "a-v-b-more-markets", gameId: "000123", parentEventId: "0" });
    expect(metadataFromRecord(gamma(raw))?.markets[0]).toMatchObject({ marketId: "0", marketSlug: "0", question: "0", acceptingOrders: null });
  });

  test.each([
    { gameId: "123", game_id: "other" },
    { gameId: "123", eventMetadata: { gameId: "other" } },
    { gameId: "123", eventState: { gameId: "other" } },
    { game_id: "123", eventMetadata: { gameId: "other" } },
    { game_id: "123", eventState: { gameId: "other" } },
    { eventMetadata: { gameId: "123" }, eventState: { gameId: "other" } },
    { gameId: 123, game_id: "00123" },
    { eventSlug: "another-event" }
  ])("rejects contradictory raw identities consistently in metadata and observations %j", fields => {
    const raw = event({ gameId: undefined, ...fields });
    expect(() => metadataFromRecord(gamma(raw))).toThrow("TAIL_IDENTITY_CONFLICT");
    expect(() => observationsFromRecord(gamma(raw))).toThrow("TAIL_IDENTITY_CONFLICT");
    expect(() => observationsFromRecord(sports({ ...raw, finishedAt: finishedTimestamp })))
      .toThrow("TAIL_IDENTITY_CONFLICT");
  });

  test.each([
    { game_id: "000123" },
    { eventState: { gameId: "000123" } },
    { eventMetadata: { gameId: "000123" } },
    { gameId: 123, game_id: "123", eventMetadata: { gameId: 123 }, eventState: { gameId: "123" } }
  ])("metadata, markets and observations share the same compatible game identity %j", fields => {
    const raw = event({ gameId: undefined, ...fields });
    const input = gamma(raw);
    const expected = "gameId" in fields ? "123" : "000123";
    const metadata = metadataFromRecord(input);
    expect(metadata?.gameId).toBe(expected);
    expect(metadata?.markets.map(market => market.gameId)).toEqual([expected, expected]);
    expect(observationsFromRecord(input)[0]?.gameId).toBe(expected);
    expect(metadata?.raw).toBe(raw);
  });

  test("can recover the original raw event from a normalized collector envelope", () => {
    const raw = event();
    const input = record("gamma", "event_metadata", { normalized: normalizeCollectorEvent(raw), status: "discovered" });
    expect(metadataFromRecord(input)?.raw).toBe(raw);
    expect(metadataFromRecord(input)?.markets).toHaveLength(2);
  });

  test.each([
    undefined, null, "", "not a timestamp", "2026-09-11", "2026-09-11T11:26:03",
    1789125963639, "1789125963639", "2026-02-30T11:26:03Z", "2026-09-11T25:00:00Z"
  ])("requires a valid explicit finish timestamp, received %j", invalidFinish => {
    const raw = event({ finishedTimestamp: invalidFinish, finishedAt: finishedTimestamp,
      closedTime: finishedTimestamp, closed: true, ended: true, period: "FT", score: "2-0",
      eventState: { finishedTimestamp }, markets: [market({ finishedTimestamp })] });
    expect(metadataFromRecord(gamma(raw))).toMatchObject({ finishAtMs: null, finishSource: null });
  });

  test("parses an explicit timezone offset without substituting receipt time", () => {
    expect(metadataFromRecord(gamma(event({ finishedTimestamp: "2026-09-11T19:26:03.639+08:00" }))))
      .toMatchObject({ finishAtMs: Date.parse(finishedTimestamp), observedAtMs: receivedAtMs });
  });

  test.each([
    [{ sport: "ATP", tags: [] }, "tennis"],
    [{ sport: { sport: "WTA" }, tags: [] }, "tennis"],
    [{ eventState: { type: "tennis" }, tags: [] }, "tennis"],
    [{ tags: [{ slug: "wta" }] }, "tennis"],
    [{ tags: [{ slug: "atp" }] }, "tennis"],
    [{ sport: "soccer", tags: [] }, "soccer"],
    [{ eventState: { type: "football" }, tags: [] }, "soccer"],
    [{ tags: [{ slug: "soccer" }] }, "soccer"],
    [{ sport: "NBA", tags: [{ slug: "soccer" }] }, "nba"],
    [{ score: "1-0", tags: [] }, null],
    [{ score: "1-0", tags: [{ slug: "sports" }] }, null]
  ])("recognizes sport from explicit fields %j", (fields, sport) => {
    expect(metadataFromRecord(gamma(event(fields as Record<string, unknown>)))?.sport).toBe(sport);
  });

  test("rejects unrelated records and malformed metadata without throwing", () => {
    for (const input of [
      record("sports", "event_metadata", { event: event() }),
      record("gamma", "http_response", { event: event() }),
      record("gamma", "event_metadata", null),
      record("gamma", "event_metadata", { event: [] }),
      gamma(event({ id: undefined })), gamma(event({ slug: "" }))
    ]) expect(metadataFromRecord(input)).toBeNull();
  });

  test("normalizes frozen raw metadata without mutating it", () => {
    const rawMarket = Object.freeze(market());
    const raw = Object.freeze(event({ markets: Object.freeze([rawMarket]) }));
    expect(metadataFromRecord(gamma(raw))?.markets).toHaveLength(2);
    expect(metadataFromRecord(gamma(raw))?.raw).toBe(raw);
  });
});

describe("tail state changes", () => {
  test("the first observed state is a baseline even if the match already has goals or ended", () => {
    expect(changesBetween(undefined, state({ score: "3-2", period: "FT", ended: true, sourceAtMs: receivedAtMs - 50 }))).toEqual([]);
  });

  test("emits score, period and ended changes at the next local receipt time", () => {
    const previous = state({ score: "1-0" });
    const next = state({ score: "2-0", period: "FT", ended: true, observedAtMs: receivedAtMs + 100,
      sourceAtMs: receivedAtMs - 500, sequence: 18, frameIndex: 3 });
    const provenance = { source: "sports-ws", eventSlug: "a-v-b", gameId: "123",
      observedAtMs: receivedAtMs + 100, sourceAtMs: receivedAtMs - 500, sequence: 18, frameIndex: 3,
      actualEventTimeKnown: false };

    expect(changesBetween(previous, next)).toEqual([
      { ...provenance, kind: "score_increase", before: "1-0", after: "2-0" },
      { ...provenance, kind: "period_change", before: "2H", after: "FT" },
      { ...provenance, kind: "ended_change", before: false, after: true }
    ]);
  });

  test("reports a score rollback without claiming a confirmed VAR incident or its time", () => {
    const next = state({ score: "1-1", sourceAtMs: receivedAtMs - 10, observedAtMs: receivedAtMs + 20 });
    expect(changesBetween(state({ score: "2-1" }), next)).toEqual([{
      source: "sports-ws", eventSlug: "a-v-b", gameId: "123", kind: "score_decrease",
      observedAtMs: receivedAtMs + 20, sourceAtMs: receivedAtMs - 10, sequence: 17, frameIndex: 0,
      before: "2-1", after: "1-1", actualEventTimeKnown: false
    }]);
  });

  test.each([
    ["0-0", "0-1", "score_increase"], ["1-0", "1-3", "score_increase"],
    ["2-2", "2-1", "score_decrease"], ["1-2", "2-1", "score_change"],
    ["1-2", "0-4", "score_change"], ["1-0", "2:0", "score_change"],
    ["1-0", "2.0-0", "score_change"], ["1-0", "2-0 (aggregate)", "score_change"],
    ["0-0", "0 - 1", "score_increase"], ["001-0", "1-0", "score_change"]
  ])("classifies only unambiguous integer soccer score movement %s -> %s", (before, after, kind) => {
    expect(changesBetween(state({ score: before }), state({ score: after }))).toMatchObject([
      { kind, before, after, actualEventTimeKnown: false }
    ]);
  });

  test.each(["tennis", "ATP", "WTA", "table-tennis", "nba", null])(
    "keeps A-B scores generic when the explicit sport is %j", sport => {
      expect(changesBetween(state({ sport, score: "1-0" }), state({ sport, score: "2-0" })))
        .toMatchObject([{ kind: "score_change", actualEventTimeKnown: false }]);
    }
  );

  test("keeps tennis sets and tiebreak score strings intact", () => {
    const before = "6-4, 6-6 (6-5)";
    const after = "6-4, 7-6 (7-5)";
    expect(changesBetween(state({ sport: "tennis", score: before }), state({ sport: "tennis", score: after })))
      .toMatchObject([{ kind: "score_change", before, after, actualEventTimeKnown: false }]);
  });

  test.each([
    ["football", "soccer", "score_increase"], [null, "soccer", "score_increase"],
    ["soccer", null, "score_increase"], ["tennis", "soccer", "score_change"]
  ])("uses compatible explicit sport evidence %j -> %j", (beforeSport, afterSport, kind) => {
    expect(changesBetween(state({ sport: beforeSport, score: "1-0" }), state({ sport: afterSport, score: "2-0" })))
      .toMatchObject([{ kind, actualEventTimeKnown: false }]);
  });

  test.each([null, undefined])("unknown fields (%j) becoming known are initialization, not observed changes", missing => {
    const previous = state({ score: missing, period: missing, ended: null });
    expect(changesBetween(previous, state({ score: "3-0", period: "FT", ended: true }))).toEqual([]);
  });

  test("an omitted field in a partial update is not a score rollback or state reset", () => {
    const next = state({ score: null, period: null, ended: null, clock: "89:01" });
    expect(changesBetween(state({ score: "3-0" }), next)).toEqual([]);
  });

  test("clock, live, finish and timestamp updates alone do not fabricate score/period/ended changes", () => {
    const next = state({ clock: "90:00", live: false, finishAtMs: receivedAtMs, finishSource: "sports.finishedAt",
      sourceAtMs: receivedAtMs, sequence: 18 });
    expect(changesBetween(state(), next)).toEqual([]);
  });

  test.each([
    { gameId: "different-game" }, { eventSlug: "different-event" },
    { eventSlug: "different-event", gameId: "different-game" }, { eventSlug: null, gameId: null }
  ])("rejects conflicting or absent next identity %j", identity => {
    expect(changesBetween(state(), state({ ...identity, score: "2-0", period: "FT", ended: true }))).toEqual([]);
  });

  test("requires a shared known identifier rather than guessing a slug-to-game mapping", () => {
    const previous = state({ eventSlug: "a-v-b", gameId: null });
    const next = state({ eventSlug: null, gameId: "123", score: "1-0" });
    expect(changesBetween(previous, next)).toEqual([]);
    expect(changesBetween(state({ eventSlug: null, gameId: null }), state({ eventSlug: null, gameId: null, score: "1-0" }))).toEqual([]);
  });

  test("allows an additional identifier when the existing one agrees", () => {
    expect(changesBetween(state({ gameId: null }), state({ score: "1-0" })))
      .toMatchObject([{ kind: "score_increase", eventSlug: "a-v-b", gameId: "123" }]);
    expect(changesBetween(state(), state({ eventSlug: null, score: "1-0" })))
      .toMatchObject([{ kind: "score_increase", eventSlug: null, gameId: "123" }]);
  });

  test("compares each source to its own prior state", () => {
    expect(changesBetween(state({ source: "gamma" }), state({ score: "2-0" }))).toEqual([]);
    expect(changesBetween(state(), state({ source: "gamma", score: "2-0" }))).toEqual([]);
    expect(changesBetween(state({ source: "gamma" }), state({ source: "gamma", score: "2-0" })))
      .toMatchObject([{ source: "gamma", kind: "score_increase" }]);
  });

  test("ignores object key order recursively while retaining array order", () => {
    const before = { sets: [{ home: 6, away: 4 }], points: { home: "40", away: "AD" } };
    const after = { points: { away: "AD", home: "40" }, sets: [{ away: 4, home: 6 }] };
    expect(changesBetween(state({ score: before }), state({ score: after }))).toEqual([]);
    expect(changesBetween(state({ score: ["6-4", "4-6"] }), state({ score: ["4-6", "6-4"] })))
      .toMatchObject([{ kind: "score_change" }]);
  });

  test("preserves changed raw score objects by reference and leaves frozen observations untouched", () => {
    const before = Object.freeze({ home: 1, away: 0 });
    const after = Object.freeze({ home: 2, away: 0 });
    const previous = Object.freeze(state({ score: before }));
    const next = Object.freeze(state({ score: after }));
    const changes = changesBetween(previous, next);
    expect(changes).toMatchObject([{ kind: "score_change", actualEventTimeKnown: false }]);
    expect(changes[0]?.before).toBe(before);
    expect(changes[0]?.after).toBe(after);
    expect(previous.score).toBe(before);
    expect(next.score).toBe(after);
  });

  test("keeps rise and rollback order within a received array despite source-clock reordering", () => {
    const observations = observationsFromRecord(sports([
      { gameId: 123, sport: "soccer", score: "1-0", timestamp: receivedAtMs - 300 },
      { gameId: 123, sport: "soccer", score: "2-0", timestamp: receivedAtMs - 100 },
      { gameId: 123, sport: "soccer", score: "1-0", timestamp: receivedAtMs - 200 }
    ]));
    const changes = observations.flatMap((next, index) => changesBetween(observations[index - 1], next));
    expect(changes.map(c => [c.kind, c.frameIndex, c.observedAtMs, c.sourceAtMs, c.actualEventTimeKnown])).toEqual([
      ["score_increase", 1, receivedAtMs, receivedAtMs - 100, false],
      ["score_decrease", 2, receivedAtMs, receivedAtMs - 200, false]
    ]);
  });
});

describe("tail observations", () => {
  test("reads last_update from the documented Sports result frame", () => {
    const raw = { slug: "mci-liv-2025-02-03", live: true, ended: false, score: "1-0", period: "1H", elapsed: "32:15",
      last_update: "2025-02-03T19:50:16.939Z" };
    expect(observationsFromRecord(sports(raw))[0]).toMatchObject({
      eventSlug: "mci-liv-2025-02-03", source: "sports-ws", sport: null,
      sourceAtMs: Date.parse(raw.last_update), observedAtMs: receivedAtMs,
      score: "1-0", period: "1H", clock: "32:15", live: true, ended: false, raw
    });
  });

  test("last_update labels the observed score update without confirming goal occurrence time", () => {
    const observations = observationsFromRecord(sports([
      { slug: "mci-liv-2025-02-03", sport: "soccer", score: "1-0", last_update: "2025-02-03T19:50:16.939Z" },
      { slug: "mci-liv-2025-02-03", sport: "soccer", score: "2-0", last_update: "2025-02-03T19:51:00.000Z" }
    ]));
    expect(changesBetween(observations[0], observations[1]!)).toMatchObject([{
      kind: "score_increase", sourceAtMs: Date.parse("2025-02-03T19:51:00.000Z"),
      observedAtMs: receivedAtMs, actualEventTimeKnown: false
    }]);
  });

  test("prefers the documented frame last_update over nested or metadata update timestamps", () => {
    const raw = { gameId: 123, score: "1-0", last_update: finishedTimestamp,
      updatedAt: "2026-09-11T11:26:59Z", eventState: { updatedAt: "2026-09-11T11:26:00Z" } };
    expect(observationsFromRecord(sports(raw))[0]?.sourceAtMs).toBe(Date.parse(finishedTimestamp));
  });

  test.each(["2025-02-03", "2025-02-03T19:50:16.939", "2025-02-30T19:50:16.939Z", 1738612216939])(
    "rejects non-ISO or invalid last_update %j", last_update => {
      expect(observationsFromRecord(sports({ gameId: 123, score: "1-0", last_update }))[0]?.sourceAtMs).toBeNull();
    }
  );

  test("reads the exact Sports JSON frame with separate source and receipt times", () => {
    const raw = {
      eventSlug: "a-v-b", gameId: 123, score: "1-0", period: "2H", elapsed: "89:15", live: true, ended: false,
      eventState: { type: "soccer", updatedAt: "2026-09-11T11:26:02.123456789Z" }
    };
    const input = sports(raw);
    expect(observationsFromRecord(input)).toEqual([{
      eventSlug: "a-v-b", gameId: "123", sport: "soccer", source: "sports-ws",
      sourceAtMs: Date.parse("2026-09-11T11:26:02.123Z"), observedAtMs: receivedAtMs,
      sequence: 17, frameIndex: 0, connectionId: "sports-0-e1",
      score: "1-0", period: "2H", clock: "89:15", live: true, ended: false,
      finishAtMs: null, finishSource: null, raw
    }]);
    expect(input.data).toBe(JSON.stringify(raw));
  });

  test("retains Gamma state values and raw references without inventing tennis points or server", () => {
    const score = Object.freeze({ sets: [["6", "7(7)"], ["2", "1"]] });
    const period = Object.freeze({ label: "unknown" });
    const clock = Object.freeze({ display: "--:--" });
    const raw = Object.freeze(event({ eventState: { type: "tennis", updatedAt: finishedTimestamp,
      score, period, clock, live: true, ended: false } }));
    const observation = observationsFromRecord(gamma(raw))[0];

    expect(observation).toEqual({
      eventSlug: "a-v-b-more-markets", gameId: "123", sport: "tennis", source: "gamma",
      sourceAtMs: Date.parse(finishedTimestamp), observedAtMs: receivedAtMs, sequence: 17, frameIndex: 0, connectionId: null,
      score, period, clock, live: true, ended: false,
      finishAtMs: Date.parse(finishedTimestamp), finishSource: "gamma.finishedTimestamp", raw
    });
    expect(observation?.raw).toBe(raw);
    expect(observation?.score).toBe(score);
    expect(observation?.period).toBe(period);
    expect(observation?.clock).toBe(clock);
    expect(observation).not.toHaveProperty("points");
    expect(observation).not.toHaveProperty("server");
  });

  test.each([
    { field: "score", value: "0-0", expected: { score: "0-0" } },
    { field: "period", value: "UNKNOWN", expected: { period: "UNKNOWN" } },
    { field: "clock", value: 0, expected: { clock: 0 } },
    { field: "elapsed", value: "", expected: { clock: "" } },
    { field: "gameTimeDisplay", value: "90+4'", expected: { clock: "90+4'" } },
    { field: "live", value: false, expected: { live: false } },
    { field: "ended", value: false, expected: { ended: false } },
    { field: "ended", value: true, expected: { ended: true } },
    { field: "finishedAt", value: finishedTimestamp,
      expected: { finishAtMs: Date.parse(finishedTimestamp), finishSource: "sports.finishedAt" } }
  ])("emits an observation for a $field-only update", ({ field, value, expected }) => {
    const observations = observationsFromRecord(sports({ eventSlug: "a-v-b", [field]: value }));
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ eventSlug: "a-v-b", gameId: null, sport: null,
      score: null, period: null, clock: null, live: null, ended: null, sourceAtMs: null,
      finishAtMs: null, finishSource: null, ...expected });
  });

  test("missing or invalid booleans stay unknown even for a final period or closed event", () => {
    const raw = event({ score: "0-0", period: "FT", status: "Ended", closed: true,
      gameState: "live", live: "false", ended: 0, finishedTimestamp: undefined });
    expect(observationsFromRecord(gamma(raw))[0]).toMatchObject({ score: "0-0", period: "FT", clock: null,
      live: null, ended: null, sourceAtMs: null, finishAtMs: null, finishSource: null });
  });

  test("preserves original array child indexes, receipt order and references while skipping noise", () => {
    const first = Object.freeze({ slug: "a-v-b", score: "0-0" });
    const second = Object.freeze({ gameId: 123, period: "NS" });
    const third = Object.freeze({ game_id: "00123", clock: 0 });
    const frames = Object.freeze([
      "PING", null, { type: "pong", gameId: 123, score: "9-9" }, first,
      [], second, { score: "unidentified" }, "not JSON", third
    ]);
    const observations = observationsFromRecord(record("sports", "ws_message", frames));

    expect(observations.map(o => [o.sequence, o.frameIndex, o.observedAtMs, o.eventSlug, o.gameId])).toEqual([
      [17, 3, receivedAtMs, "a-v-b", null], [17, 5, receivedAtMs, null, "123"], [17, 8, receivedAtMs, null, "00123"]
    ]);
    expect(observations[0]?.raw).toBe(first);
    expect(observations[1]?.raw).toBe(second);
    expect(observations[2]?.raw).toBe(third);
    expect(observationsFromRecord(sports(frames)).map(o => o.frameIndex)).toEqual([3, 5, 8]);
  });

  test.each([
    [{ eventSlug: "a-v-b" }, "a-v-b", null],
    [{ slug: "a-v-b" }, "a-v-b", null],
    [{ gameId: 0 }, null, "0"],
    [{ game_id: "000123" }, null, "000123"],
    [{ eventState: { gameId: "123" } }, null, "123"],
    [{ eventMetadata: { gameId: "123" } }, null, "123"],
    [{ eventSlug: "a-v-b", gameId: Number.MAX_SAFE_INTEGER + 1 }, "a-v-b", null]
  ])("accepts an explicit match identity %j", (identity, eventSlug, gameId) => {
    expect(observationsFromRecord(sports({ ...identity as Record<string, unknown>, score: "1-0" }))[0])
      .toMatchObject({ eventSlug, gameId });
  });

  test.each([
    "PING", '"PONG"', "not JSON", "null", "[]", "42", "true", "{}",
    { type: "heartbeat", gameId: 123, score: "1-0" },
    { event_type: "ping", gameId: 123, score: "1-0" },
    { gameId: 123, updatedAt: finishedTimestamp },
    { eventSlug: "a-v-b", live: "true", ended: "false", score: null },
    { score: "1-0", eventSlug: "  ", gameId: Number.MAX_SAFE_INTEGER + 1 },
    { id: "not-a-game-id", score: "1-0" }
  ])("skips heartbeat, unparseable, empty or unidentified frame %j", frame => {
    expect(observationsFromRecord(sports(frame))).toEqual([]);
  });

  test("ignores source and kind combinations that are not context records", () => {
    for (const input of [
      record("clob", "ws_message", JSON.stringify({ eventSlug: "a-v-b", score: "1-0" })),
      record("sports", "ws_open", { gameId: 123, live: true }),
      record("gamma", "http_response", { event: event({ score: "1-0" }) })
    ]) expect(observationsFromRecord(input)).toEqual([]);
  });

  test.each([
    { updatedAt: finishedTimestamp },
    { timestamp: "2026-09-11T19:26:03.639+08:00" },
    { timestamp: Date.parse(finishedTimestamp) },
    { timestamp: String(Date.parse(finishedTimestamp)) },
    { timestampMs: Date.parse(finishedTimestamp) },
    { updatedAt: "invalid", timestamp: finishedTimestamp },
    { eventState: { updatedAt: finishedTimestamp }, updatedAt: "2026-09-11T11:26:59Z" },
    { eventState: { timestamp: finishedTimestamp } }
  ])("retains the explicit source update timestamp %j", fields => {
    expect(observationsFromRecord(sports({ gameId: 123, score: "1-0", ...fields }))[0])
      .toMatchObject({ sourceAtMs: Date.parse(finishedTimestamp), observedAtMs: receivedAtMs });
  });

  test.each([
    {}, { updatedAt: "2026-09-11" }, { updatedAt: "2026-09-11T11:26:03" },
    { updatedAt: "2026-02-30T11:26:03Z" }, { updatedAt: Date.parse(finishedTimestamp) },
    { timestamp: false }, { timestamp: "" }, { timestamp: "1e12" },
    { timestamp: -1 }, { timestamp: 1.5 }, { timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { timestamp: 8_640_000_000_000_001 }, { startDate: finishedTimestamp, createdAt: finishedTimestamp },
    { receivedAt: finishedTimestamp, finishedAt: finishedTimestamp }
  ])("does not fabricate a source timestamp from %j", fields => {
    expect(observationsFromRecord(sports({ gameId: 123, score: "1-0", ...fields }))[0])
      .toMatchObject({ sourceAtMs: null, observedAtMs: receivedAtMs });
  });

  test("keeps an explicit zero millisecond source timestamp", () => {
    expect(observationsFromRecord(sports({ gameId: 123, score: "0-0", timestampMs: 0 }))[0]?.sourceAtMs).toBe(0);
  });

  test.each([undefined, null, "2026-09-11", "2026-09-11T11:26:03", "2026-02-30T11:26:03Z", 1789125963639])(
    "Sports finish ignores unrelated date fields, received %j", finishedAt => {
      const raw = { gameId: 123, ended: true, finishedAt,
        endDate: finishedTimestamp, closedTime: finishedTimestamp, startDate: finishedTimestamp, receivedAt: finishedTimestamp };
      expect(observationsFromRecord(sports(raw))[0]).toMatchObject({ ended: true, finishAtMs: null, finishSource: null });
    }
  );

  test("Sports accepts the finishedTimestamp clock its terminal frame carries", () => {
    // Captured live: the terminal frame names the same clock Gamma republishes
    // later, so a Gamma round trip is not required to anchor the final window.
    const raw = { gameId: 90116334, homeTeam: "A", awayTeam: "B", status: "Final", score: "1-0",
      period: "FT", live: false, ended: true, finishedTimestamp: "2026-09-20T13:00:48.897485Z" };
    expect(observationsFromRecord(sports(raw))[0]).toMatchObject({ gameId: "90116334", ended: true, live: false,
      finishAtMs: Date.parse("2026-09-20T13:00:48.897Z"), finishSource: "sports.finishedAt" });
  });

  test("Gamma finish-only observations use finishedTimestamp and leave unknown ended state alone", () => {
    const raw = event();
    expect(observationsFromRecord(gamma(raw))[0]).toMatchObject({ source: "gamma", sourceAtMs: null,
      score: null, period: null, clock: null, live: null, ended: null,
      finishAtMs: Date.parse(finishedTimestamp), finishSource: "gamma.finishedTimestamp" });
    expect(observationsFromRecord(gamma(event({ finishedTimestamp: undefined, finishedAt: finishedTimestamp })))).toEqual([]);
  });

  test("keeps state-only Gamma snapshots and the collector's raw fallback", () => {
    const raw = event({ score: "0-0", updatedAt: finishedTimestamp, finishedTimestamp: undefined });
    const input = record("gamma", "event_metadata", { normalized: normalizeCollectorEvent(raw) });
    expect(observationsFromRecord(input)[0]).toMatchObject({ source: "gamma", score: "0-0", sourceAtMs: Date.parse(finishedTimestamp) });
    expect(observationsFromRecord(input)[0]?.raw).toBe(raw);
  });

  test("uses raw sport, state type or tag slugs without guessing from a score", () => {
    const frames = [
      { gameId: 1, score: "1-0", sport: "ATP" },
      { gameId: 2, score: "1-0", eventState: { type: "WTA" } },
      { gameId: 3, score: "1-0", tags: [{ slug: "tennis" }] },
      { gameId: 4, score: "1-0", sport: "Football" },
      { gameId: 5, score: "1-0" },
      { gameId: 6, score: "1-0", sport: "table-tennis" }
    ];
    expect(observationsFromRecord(sports(frames)).map(o => o.sport)).toEqual(["tennis", "tennis", "tennis", "soccer", null, "table-tennis"]);
  });
});
