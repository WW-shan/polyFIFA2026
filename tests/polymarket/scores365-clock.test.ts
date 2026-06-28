import { describe, expect, test } from "vitest";
import {
  SCORES365_REMAINING_SECONDS_SOURCE,
  extract365ScoresClock,
  find365ScoresGameForMatch
} from "../../src/polymarket/scores365-clock.js";
import type { MatchState } from "../../src/domain/types.js";

const match: MatchState = {
  eventSlug: "fifwc-sui-can-2026-06-24",
  homeTeam: "Switzerland",
  awayTeam: "Canada",
  homeGoals: 2,
  awayGoals: 1,
  minute: 93,
  period: "2H",
  isLive: true,
  startTime: "2026-06-24T19:00:00Z"
};

describe("365Scores live clock", () => {
  test("computes strict remaining seconds from second-half addedTime and preciseGameTime", () => {
    const clock = extract365ScoresClock({
      game: {
        id: 4627855,
        statusText: "2nd Half",
        gameTime: 94,
        gameTimeDisplay: "90+4'",
        addedTime: 6,
        preciseGameTime: {
          minutes: 93,
          seconds: 9,
          autoProgress: true,
          clockDirection: 1
        },
        homeCompetitor: { name: "Switzerland", score: 2 },
        awayCompetitor: { name: "Canada", score: 1 }
      }
    }, match);

    expect(clock).toEqual({
      remainingSeconds: 171,
      remainingSecondsSource: SCORES365_REMAINING_SECONDS_SOURCE,
      elapsedSeconds: 5589,
      minute: 93,
      scores365GameId: 4627855
    });
  });

  test("does not let 365Scores overwrite the sports feed score", () => {
    const clock = extract365ScoresClock({
      game: {
        id: 4627855,
        statusText: "2nd Half",
        gameTimeDisplay: "90+4'",
        addedTime: 6,
        preciseGameTime: {
          minutes: 93,
          seconds: 9,
          autoProgress: true,
          clockDirection: 1
        },
        homeCompetitor: { name: "Switzerland", score: 9 },
        awayCompetitor: { name: "Canada", score: 8 }
      }
    }, match);

    expect(clock).toMatchObject({
      remainingSeconds: 171,
      remainingSecondsSource: SCORES365_REMAINING_SECONDS_SOURCE
    });
    expect(clock).not.toHaveProperty("homeGoals");
    expect(clock).not.toHaveProperty("awayGoals");
  });

  test("rejects game clocks whose teams do not match the current event", () => {
    expect(extract365ScoresClock({
      game: {
        id: 4627855,
        statusText: "2nd Half",
        gameTimeDisplay: "90+4'",
        addedTime: 6,
        preciseGameTime: {
          minutes: 93,
          seconds: 9,
          autoProgress: true,
          clockDirection: 1
        },
        homeCompetitor: { name: "DR Congo", score: 3 },
        awayCompetitor: { name: "Uzbekistan", score: 1 }
      }
    }, match)).toBeNull();
  });

  test("rejects 365Scores clocks before second-half added time is announced", () => {
    expect(extract365ScoresClock({
      game: {
        id: 4627855,
        statusText: "2nd Half",
        gameTimeDisplay: "89'",
        addedTime: undefined,
        preciseGameTime: { minutes: 88, seconds: 50, autoProgress: true, clockDirection: 1 }
      }
    }, match)).toBeNull();
  });

  test("rejects non-running precise clocks", () => {
    expect(extract365ScoresClock({
      game: {
        id: 4627855,
        statusText: "2nd Half",
        gameTimeDisplay: "90+4'",
        addedTime: 6,
        preciseGameTime: { minutes: 93, seconds: 9, autoProgress: false, clockDirection: 1 }
      }
    }, match)).toBeNull();
  });

  test("matches allscores target games by normalized team names", () => {
    const game = find365ScoresGameForMatch({
      games: [
        {
          id: 111,
          homeCompetitor: { name: "Other" },
          awayCompetitor: { name: "Teams" }
        },
        {
          id: 4627855,
          homeCompetitor: { name: "Switzerland" },
          awayCompetitor: { name: "Canada" }
        }
      ]
    }, match);

    expect(game).toMatchObject({ id: 4627855 });
  });

  test("matches ampersand and 'and' variants in team names", () => {
    const game = find365ScoresGameForMatch({
      games: [
        {
          id: 4697701,
          homeCompetitor: { name: "Bosnia & Herzegovina" },
          awayCompetitor: { name: "Qatar" }
        }
      ]
    }, {
      ...match,
      eventSlug: "fifwc-bih-qat-2026-06-24",
      homeTeam: "Bosnia and Herzegovina",
      awayTeam: "Qatar"
    });

    expect(game).toMatchObject({ id: 4697701 });
  });

  test("matches common country alias variants between Polymarket and 365Scores", () => {
    const aliases = [
      {
        id: 4697704,
        polyTeams: ["Türkiye", "United States"],
        scoreTeams: ["Turkiye", "USA"]
      },
      {
        id: 4627897,
        polyTeams: ["Curaçao", "Côte d'Ivoire"],
        scoreTeams: ["Curacao", "Ivory Coast"]
      },
      {
        id: 4627906,
        polyTeams: ["Cabo Verde", "Saudi Arabia"],
        scoreTeams: ["Cape Verde", "Saudi Arabia"]
      },
      {
        id: 4627875,
        polyTeams: ["Egypt", "IR Iran"],
        scoreTeams: ["Egypt", "Iran"]
      }
    ];

    for (const alias of aliases) {
      const game = find365ScoresGameForMatch({
        games: [
          {
            id: alias.id,
            homeCompetitor: { name: alias.scoreTeams[0]! },
            awayCompetitor: { name: alias.scoreTeams[1]! }
          }
        ]
      }, {
        ...match,
        eventSlug: `fifwc-alias-${alias.id}`,
        homeTeam: alias.polyTeams[0]!,
        awayTeam: alias.polyTeams[1]!
      });

      expect(game).toMatchObject({ id: alias.id });
    }
  });
});
