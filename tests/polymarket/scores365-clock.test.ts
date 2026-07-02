import { describe, expect, test } from "vitest";
import {
  SCORES365_REMAINING_SECONDS_SOURCE,
  extract365ScoresClock,
  extract365ScoresGoalSignal,
  extract365ScoresScorePatch,
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

  test("extracts a separate score patch for fast locked-goal confirmation", () => {
    const score = extract365ScoresScorePatch({
      game: {
        id: 4627855,
        statusText: "2nd Half",
        homeCompetitor: { name: "Switzerland", score: "2" },
        awayCompetitor: { name: "Canada", score: 1 }
      }
    }, match);

    expect(score).toEqual({
      homeGoals: 2,
      awayGoals: 1,
      scores365GameId: 4627855
    });
  });

  test("extracts a normal 365Scores goal signal for a matching score increase", () => {
    const signal = extract365ScoresGoalSignal({
      game: {
        id: 4627855,
        homeCompetitor: { id: 10, name: "Switzerland", score: 3 },
        awayCompetitor: { id: 20, name: "Canada", score: 1 },
        events: [
          {
            competitorId: 10,
            gameTime: 74,
            isMajor: true,
            eventType: { id: 1, name: "Goal", subTypeName: "Field Goal" }
          }
        ]
      },
      playByPlay: {
        Messages: [
          {
            TypeName: "goal",
            Title: "Goal",
            Comment: "Goal! Switzerland 3, Canada 1."
          }
        ]
      }
    }, {
      ...match,
      homeGoals: 3,
      awayGoals: 1
    }, {
      ...match,
      homeGoals: 2,
      awayGoals: 1
    });

    expect(signal).toMatchObject({
      homeGoals: 3,
      awayGoals: 1,
      scores365GameId: 4627855,
      scoreMatchesSports: true,
      hasMatchingGoal: true,
      hasNoGoalSignal: false,
      hasVarReviewSignal: false
    });
    expect(signal?.details.join(" ")).toContain("normal goal");
  });

  test("flags a matching 365Scores goal after regular time", () => {
    const signal = extract365ScoresGoalSignal({
      game: {
        id: 4749272,
        homeCompetitor: { id: 2373, name: "Belgium", score: 3 },
        awayCompetitor: { id: 5102, name: "Senegal", score: 2 },
        events: [
          {
            competitorId: 2373,
            gameTime: 86,
            addedTime: 0,
            eventType: { id: 1, name: "Goal", subTypeName: "Field Goal" }
          },
          {
            competitorId: 2373,
            gameTime: 89,
            addedTime: 0,
            eventType: { id: 1, name: "Goal", subTypeName: "Field Goal" }
          },
          {
            competitorId: 2373,
            gameTime: 120,
            addedTime: 5,
            eventType: { id: 1, name: "Goal", subTypeName: "Penalty" }
          }
        ]
      }
    }, {
      ...match,
      eventSlug: "fifwc-bel-sen-2026-07-01",
      homeTeam: "Belgium",
      awayTeam: "Senegal",
      homeGoals: 3,
      awayGoals: 2
    }, {
      ...match,
      eventSlug: "fifwc-bel-sen-2026-07-01",
      homeTeam: "Belgium",
      awayTeam: "Senegal",
      homeGoals: 2,
      awayGoals: 2
    });

    expect(signal).toMatchObject({
      homeGoals: 3,
      awayGoals: 2,
      scoreMatchesSports: true,
      hasMatchingGoal: true,
      hasPostRegulationGoalSignal: true
    });
    expect(signal?.details.join(" ")).toContain("post-regulation");
  });

  test("detects 365Scores Goal Disallowed Var and PBP no-goal as a hard block", () => {
    const signal = extract365ScoresGoalSignal({
      game: {
        id: 4627855,
        homeCompetitor: { id: 10, name: "Switzerland", score: 3 },
        awayCompetitor: { id: 20, name: "Canada", score: 1 },
        events: [
          {
            competitorId: 10,
            gameTime: 74,
            isMajor: true,
            eventType: { id: 11, name: "Goal Disallowed", subTypeName: "Var" }
          }
        ]
      },
      playByPlay: {
        Messages: [
          {
            TypeName: "var",
            Title: "VAR Decision: No Goal",
            Comment: "GOAL OVERTURNED BY VAR: Switzerland 3-1 Canada."
          }
        ]
      }
    }, {
      ...match,
      homeGoals: 3,
      awayGoals: 1
    }, {
      ...match,
      homeGoals: 2,
      awayGoals: 1
    });

    expect(signal).toMatchObject({
      homeGoals: 3,
      awayGoals: 1,
      scores365GameId: 4627855,
      scoreMatchesSports: true,
      hasMatchingGoal: false,
      hasNoGoalSignal: true
    });
    expect(signal?.details.join(" ")).toMatch(/no goal|disallowed/i);
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
