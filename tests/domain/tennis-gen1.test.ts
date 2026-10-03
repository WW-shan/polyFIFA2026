import { describe, expect, test } from "vitest";
import { parseTennisScoreSets, tennisGen1, tennisSetsWon } from "../../src/domain/tennis-gen1.js";

describe("parseTennisScoreSets", () => {
  test("parses the sports-feed score string", () => {
    expect(parseTennisScoreSets("6-2, 5-2")).toEqual([{ home: 6, away: 2 }, { home: 5, away: 2 }]);
  });

  test("ignores tiebreak points in parentheses", () => {
    expect(parseTennisScoreSets("6-4, 6-6(5-2)")).toEqual([{ home: 6, away: 4 }, { home: 6, away: 6 }]);
  });

  test("returns nothing for a non-score value", () => {
    expect(parseTennisScoreSets(null)).toEqual([]);
    expect(parseTennisScoreSets(7)).toEqual([]);
    expect(parseTennisScoreSets("")).toEqual([]);
    expect(parseTennisScoreSets("in progress")).toEqual([]);
  });
});

describe("tennisSetsWon", () => {
  test("counts completed sets only", () => {
    expect(tennisSetsWon([{ home: 6, away: 2 }, { home: 5, away: 2 }])).toEqual({ home: 1, away: 0 });
    expect(tennisSetsWon([{ home: 2, away: 6 }, { home: 6, away: 3 }, { home: 5, away: 3 }]))
      .toEqual({ home: 1, away: 1 });
  });
});

describe("tennisGen1", () => {
  test("qualifies the side one set from the match at 5-x", () => {
    expect(tennisGen1("6-2, 5-2", 2)).toMatchObject({
      side: "home", kind: "game", favoredSets: 1, setWins: { home: 1, away: 0 }, currentSet: { home: 5, away: 2 }
    });
  });

  test("qualifies the side at 5-4 and 6-5", () => {
    expect(tennisGen1("6-2, 5-4", 2)).toMatchObject({ side: "home", kind: "game" });
    expect(tennisGen1("6-2, 6-5", 2)).toMatchObject({ side: "home", kind: "game" });
    expect(tennisGen1("2-6, 5-6", 2)).toMatchObject({ side: "away", kind: "game" });
  });

  test("names the set leader, not the feed's home side", () => {
    expect(tennisGen1("2-6, 2-5", 2)).toMatchObject({ side: "away", kind: "game", setWins: { home: 0, away: 1 } });
  });

  test("qualifies a 6-6 tiebreak when the side already leads in sets", () => {
    expect(tennisGen1("6-2, 6-6", 2)).toMatchObject({ side: "home", kind: "tiebreak" });
    expect(tennisGen1("6-2, 6-6(5-2)", 2)).toMatchObject({ side: "home", kind: "tiebreak" });
    expect(tennisGen1("2-6, 6-6", 2)).toMatchObject({ side: "away", kind: "tiebreak" });
  });

  test("refuses the deciding-set tiebreak at 1-1 / 2-2", () => {
    // The old research script took the feed's home side here; the live
    // universe excludes these matches instead of guessing a favourite.
    expect(tennisGen1("6-2, 2-6, 6-6", 2)).toBeNull();
    expect(tennisGen1("6-2, 2-6, 6-6(7-5)", 2)).toBeNull();
    expect(tennisGen1("6-2, 4-6, 6-4, 3-6, 6-6", 3)).toBeNull();
  });

  test("supports a best-of-five match when it is two sets from the match", () => {
    expect(tennisGen1("6-2, 4-6, 6-4, 5-3", 3)).toMatchObject({
      side: "home", kind: "game", favoredSets: 2, setWins: { home: 2, away: 1 }
    });
    // Two sets up but behind in the live set: no entry, the set leader is not
    // the side one set from the match.
    expect(tennisGen1("6-2, 6-4, 2-5", 3)).toBeNull();
    expect(tennisGen1("6-2, 6-4, 3-2", 3)).toBeNull();
  });

  test("does not fire before the favourite is one set from the match", () => {
    expect(tennisGen1("5-3", 2)).toBeNull();
    expect(tennisGen1("6-2, 4-3", 2)).toBeNull();
    expect(tennisGen1("6-2, 5-5", 2)).toBeNull();
    expect(tennisGen1("6-2, 7-5", 2)).toBeNull();
  });

  test("returns nothing for a malformed score or draw", () => {
    expect(tennisGen1("", 2)).toBeNull();
    expect(tennisGen1("6-2, 5-2", 1)).toBeNull();
    expect(tennisGen1("6-2, 5-2", 2.5)).toBeNull();
  });
});
