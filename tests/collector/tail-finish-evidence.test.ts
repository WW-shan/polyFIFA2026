import { describe, expect, test } from "vitest";
import { finishEvidenceConflict, newestFinishFacts, type TailFinishFact } from "../../src/collector/tail-types.js";

function fact(overrides: Partial<TailFinishFact> = {}): TailFinishFact {
  return { eventId: "event", eventSlug: "game", gameId: "123", atMs: 310_000, observedAtMs: 450_000,
    source: "sports.finishedAt", sourceRunId: "r1", sourceRunDirectory: null, sequence: 1, frameIndex: 0, ...overrides };
}

describe("finish evidence resolution", () => {
  test("a source's later value supersedes its own earlier one", () => {
    const facts = [fact({ atMs: 310_000, observedAtMs: 100 }), fact({ atMs: 310_006, observedAtMs: 200 })];
    expect(newestFinishFacts(facts).map(value => value.atMs)).toEqual([310_006]);
    expect(finishEvidenceConflict(facts)).toBe(false);
  });

  test("independent published clocks disagreeing is a conflict", () => {
    const facts = [fact({ atMs: 310_000 }), fact({ source: "gamma.finishedTimestamp", atMs: 310_001 })];
    expect(finishEvidenceConflict(facts)).toBe(true);
  });

  test("the collector's own book fallback is not an independent clock", () => {
    const facts = [fact({ source: "book-quiet", atMs: 300_000 }), fact({ atMs: 310_000 })];
    expect(newestFinishFacts(facts).map(value => value.source).sort()).toEqual(["book-quiet", "sports.finishedAt"]);
    expect(finishEvidenceConflict(facts)).toBe(false);
  });

  test("agreeing clocks are not a conflict even when older values were recorded", () => {
    const facts = [fact({ atMs: 310_068, observedAtMs: 100 }), fact({ atMs: 310_000, observedAtMs: 200 }),
      fact({ source: "gamma.finishedTimestamp", atMs: 310_000, observedAtMs: 300 })];
    expect(finishEvidenceConflict(facts)).toBe(false);
  });
});
