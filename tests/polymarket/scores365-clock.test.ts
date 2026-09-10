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

const runningGame = {
  id: 4627855,
  statusText: "2nd Half",
  gameTimeDisplay: "90+4'",
  addedTime: 6,
  preciseGameTime: { minutes: 93, seconds: 9, autoProgress: true, clockDirection: 1 },
  homeCompetitor: { id: 10, name: "Switzerland", score: 3 },
  awayCompetitor: { id: 20, name: "Canada", score: 1 }
};

describe("regulation-only verified clock (O4)", () => {
  test.each(["2nd Extra Time", "Extra Time", "ET", "OT", "FT", "Full Time", "2nd Half ET", "1st Half"])
    ("rejects %s even when a stale display says 90+", (statusText) => {
      expect(extract365ScoresClock({ ...runningGame, statusText }, match)).toBeNull();
    });

  test("rejects the audited 117:10 extra-time clock against lagging Sports 2H", () => {
    expect(extract365ScoresClock({
      ...runningGame,
      statusText: "2nd Extra Time",
      gameTimeDisplay: "117'",
      addedTime: 1,
      preciseGameTime: { minutes: 117, seconds: 10, autoProgress: true, clockDirection: 1 }
    }, { ...match, minute: 91 })).toBeNull();
  });

  test.each([
    { statusText: "2nd Extra" },
    { shortStatusText: "2nd Extra" },
    { periodName: "1st Extra" }
  ])("rejects abbreviated extra-time phases despite a stale regulation display: %j", (phase) => {
    expect(extract365ScoresClock({
      ...runningGame,
      ...phase,
      addedTime: 1,
      preciseGameTime: { minutes: 117, seconds: 10, autoProgress: true, clockDirection: 1 }
    }, match)).toBeNull();
  });

  test.each([
    { shortStatusText: "ET" },
    { shortStatusText: "FT" },
    { period: "OT" },
    { periodName: "1st Extra Time" },
    { period: "1H" },
    { gameTimeDisplay: "105+2'" },
    { gameTimeDisplay: "FT" }
  ])("rejects contradictory phase fields %j", (fields) => {
    expect(extract365ScoresClock({ ...runningGame, ...fields }, match)).toBeNull();
  });

  test.each(["ET", "FT", "1H"] as const)("rejects a Sports %s phase", (period) => {
    expect(extract365ScoresClock(runningGame, { ...match, period })).toBeNull();
  });

  test.each([-1, 1.5, "1.5", "", Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid added time %s", (addedTime) => {
    expect(extract365ScoresClock({ ...runningGame, addedTime }, match)).toBeNull();
  });

  test.each([
    { minutes: -1, seconds: 9 },
    { minutes: 93.5, seconds: 9 },
    { minutes: "93.5", seconds: 9 },
    { minutes: 93, seconds: -1 },
    { minutes: 93, seconds: 9.5 },
    { minutes: 93, seconds: "9.5" },
    { minutes: 93, seconds: 60 }
  ])("rejects invalid precise clock %j", (clock) => {
    expect(extract365ScoresClock({
      ...runningGame,
      preciseGameTime: { ...runningGame.preciseGameTime, ...clock }
    }, match)).toBeNull();
  });

  test.each(["2nd Half", "Second Half", "2H"])("accepts an explicit %s regulation phase", (statusText) => {
    expect(extract365ScoresClock({ ...runningGame, statusText, gameTimeDisplay: "93'" }, match))
      .toMatchObject({ remainingSeconds: 171 });
  });
});

describe("current goal incident correlation (O5)", () => {
  const current = { ...match, homeGoals: 3, minute: 90 };
  const previous = { ...match, homeGoals: 2, minute: 89 };
  const goal = { id: "current-goal", competitorId: 10, gameTime: 90, eventType: { id: 1, name: "Goal" } };

  test.each([
    { id: 11, name: "Goal Disallowed", subTypeName: "VAR" },
    { id: 99, name: "VAR Review" }
  ])("ignores historical $name at minute 10 before the current valid goal", (eventType) => {
    const signal = extract365ScoresGoalSignal({
      ...runningGame,
      events: [{ id: "old-incident", competitorId: 20, gameTime: 10, eventType }, goal]
    }, current, previous);
    expect(signal).toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false, hasVarReviewSignal: false });
  });

  test("ignores a historical disallowed goal even on the current scoring side", () => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [{ competitorId: 10, gameTime: 10, eventType: { id: 11, name: "No Goal" } }, goal]
    }, current, previous)).toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false });
  });

  test.each(["No Goal", "VAR Review"])("ignores timestamped historical PBP %s", (Title) => {
    expect(extract365ScoresGoalSignal({
      game: { ...runningGame, events: [goal] },
      playByPlay: { Messages: [{ GameTime: 10, CompetitorId: 20, Title }] }
    }, current, previous)).toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false, hasVarReviewSignal: false });
  });

  test("does not confirm a score increase using only an old goal", () => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [{ ...goal, gameTime: 10 }]
    }, current, previous)).toMatchObject({ hasMatchingGoal: false });
  });

  test("does not confirm the current increase using an old PBP goal or a conflicting score", () => {
    expect(extract365ScoresGoalSignal({
      game: runningGame,
      playByPlay: { Messages: [
        { GameTime: 10, Comment: "Goal! Switzerland 1-0 Canada." },
        { GameTime: 90, Comment: "Goal! Switzerland 2-1 Canada." }
      ] }
    }, current, previous)).toMatchObject({ hasMatchingGoal: false });
  });

  test("identifies an untimed current PBP goal through the existing country aliases", () => {
    expect(extract365ScoresGoalSignal({
      game: { ...runningGame, homeCompetitor: { id: 10, name: "USA", score: 3 } },
      playByPlay: { Messages: [{ Comment: "Goal! USA 3, Canada 1." }] }
    }, { ...current, homeTeam: "United States" }, { ...previous, homeTeam: "United States" }))
      .toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false });
  });

  test("keeps an unknown current-goal reference blocking despite an old timestamp", () => {
    expect(extract365ScoresGoalSignal({
      game: { ...runningGame, events: [goal] },
      playByPlay: { Messages: [{ RelatedEventId: "not-yet-in-events", GameTime: 10, Title: "No Goal" }] }
    }, current, previous)).toMatchObject({ hasMatchingGoal: false, hasNoGoalSignal: true });
  });

  test("ignores historical negatives when no previous Sports snapshot is available", () => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [{ competitorId: 20, gameTime: 10, eventType: { id: 11, name: "No Goal" } }, goal]
    }, current)).toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false });
  });

  test.each([
    { name: "No Goal", expected: { hasNoGoalSignal: true, hasMatchingGoal: false } },
    { name: "VAR Review", expected: { hasVarReviewSignal: true } }
  ])("keeps an ambiguous current $name blocking without timestamps", ({ name, expected }) => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [goal, { eventType: { id: 99, name } }]
    }, current, previous)).toMatchObject(expected);
    expect(extract365ScoresGoalSignal({
      game: { ...runningGame, events: [goal] },
      playByPlay: { Messages: [{ Title: name }] }
    }, current, previous)).toMatchObject(expected);
  });

  test("keeps a current no-goal signal blocking when the side is unknown", () => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [goal, { gameTime: 90, eventType: { id: 11, name: "No Goal" } }]
    }, current, previous)).toMatchObject({ hasMatchingGoal: false, hasNoGoalSignal: true });
  });

  test("uses an explicit goal reference before a contradictory negative timestamp", () => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [goal, { relatedEventId: "current-goal", gameTime: 10, eventType: { id: 11, name: "No Goal" } }]
    }, current, previous)).toMatchObject({ hasMatchingGoal: false, hasNoGoalSignal: true });
  });

  test("correlates an untimed negative reference to a known historical goal", () => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [
        { ...goal, id: "old-goal", gameTime: 10 },
        { relatedEventId: "old-goal", eventType: { id: 11, name: "No Goal" } },
        goal
      ]
    }, current, previous)).toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false });
  });

  test("ignores a goal for the opposite scoring side even at the current time", () => {
    expect(extract365ScoresGoalSignal({ ...runningGame, events: [{ ...goal, competitorId: 20 }] }, current, previous))
      .toMatchObject({ hasMatchingGoal: false });
  });
});

describe("stoppage-time and stale-snapshot incident regressions (O5)", () => {
  const current = { ...match, homeGoals: 3, minute: 94 };
  const previous = { ...match, homeGoals: 2, minute: 93 };
  const goal = { id: "current-goal", competitorId: 10, gameTime: 94, eventType: { id: 1, name: "Goal" } };
  const negativeKinds = [
    { name: "No Goal", id: 11, expected: { hasMatchingGoal: false, hasNoGoalSignal: true, hasVarReviewSignal: false } },
    { name: "VAR Review", id: 99, expected: { hasMatchingGoal: true, hasNoGoalSignal: false, hasVarReviewSignal: true } }
  ];
  const timeFormats = [
    { name: "numeric minute and display", fields: { gameTime: 90, gameTimeDisplay: "90+4'" } },
    { name: "uppercase minute and display", fields: { GameTime: 90, GameTimeDisplay: "90+4'" } },
    { name: "quoted minute and added time", fields: { gameTime: "90'", addedTime: 4 } },
    { name: "uppercase quoted minute and added time", fields: { GameTime: "90'", AddedTime: 4 } },
    { name: "mixed-case display aliases", fields: { gameTime: 90, GameTimeDisplay: "90+4'" } },
    { name: "numeric added-time control", fields: { gameTime: 90, addedTime: 4 } },
    { name: "already expanded minute control", fields: { gameTime: "90+4'", addedTime: 4 } },
    { name: "absolute minute control", fields: { gameTime: 94, gameTimeDisplay: "90+4'", addedTime: 4 } },
    { name: "conflicting numeric aliases", fields: { gameTime: 10, GameTime: 94 } },
    { name: "conflicting minute and display", fields: { gameTime: 10, gameTimeDisplay: "90+4'" } },
    { name: "conflicting expanded minute and added time", fields: { gameTime: "90+1'", addedTime: 4 } },
    { name: "conflicting uppercase expanded minute and added time", fields: { GameTime: "90+1'", AddedTime: 4 } },
    { name: "conflicting expanded display and added time", fields: { gameTimeDisplay: "90+1'", addedTime: 4 } },
    { name: "unspecified stoppage minutes", fields: { gameTime: 90 } }
  ];

  test.each(negativeKinds.flatMap((kind) => timeFormats.map((time) => ({ kind, time }))))
    ("keeps current $kind.name blocking with $time.name in events and PBP", ({ kind, time }) => {
      expect(extract365ScoresGoalSignal({
        ...runningGame,
        events: [goal, { ...time.fields, competitorId: 10, eventType: { id: kind.id, name: kind.name } }]
      }, current, previous)).toMatchObject(kind.expected);
      expect(extract365ScoresGoalSignal({
        game: { ...runningGame, events: [goal] },
        playByPlay: { Messages: [{ ...time.fields, CompetitorId: 10, Title: kind.name }] }
      }, current, previous)).toMatchObject(kind.expected);
    });

  test.each(negativeKinds)("does not revive an opponent's historical $name with a stale previous snapshot", (kind) => {
    const stalePrevious = { ...previous, minute: 9 };
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [goal, { id: "old-negative", competitorId: 20, gameTime: 10, eventType: { id: kind.id, name: kind.name } }]
    }, current, stalePrevious)).toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false, hasVarReviewSignal: false });
    expect(extract365ScoresGoalSignal({
      game: { ...runningGame, events: [goal] },
      playByPlay: { Messages: [{ GameTime: 10, CompetitorId: 20, Title: kind.name }] }
    }, current, stalePrevious)).toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false, hasVarReviewSignal: false });
  });

  test.each(negativeKinds)("retains an untimed current $name with a stale previous snapshot", (kind) => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [goal, { eventType: { id: kind.id, name: kind.name } }]
    }, current, { ...previous, minute: 9 })).toMatchObject(kind.expected);
  });

  test("does not use an ambiguous stoppage-time goal alone as current confirmation", () => {
    expect(extract365ScoresGoalSignal({ ...runningGame, events: [{ ...goal, gameTime: 90 }] }, current, previous))
      .toMatchObject({ hasMatchingGoal: false });
  });
});

describe("goal identity survives clock progression (O5)", () => {
  const current = { ...match, homeGoals: 3, minute: 93 };
  const previous = { ...match, homeGoals: 2, minute: 89 };
  const goal = {
    id: "latest-score-goal", competitorId: 10, gameTime: 90, addedTime: 0,
    description: "Goal! Switzerland 3-1 Canada.", eventType: { id: 1, name: "Goal" }
  };
  const negatives = [
    { name: "No Goal", id: 11, expected: { hasMatchingGoal: false, hasNoGoalSignal: true, hasVarReviewSignal: false } },
    { name: "VAR Review", id: 99, expected: { hasMatchingGoal: true, hasNoGoalSignal: false, hasVarReviewSignal: true } }
  ];

  test.each(negatives.flatMap((kind) => [92, 93, 97].map((minute) => ({ kind, minute }))))
    ("keeps $kind.name for the current goal blocking at minute $minute in events and PBP", ({ kind, minute }) => {
      const snapshot = { ...current, minute };
      expect(extract365ScoresGoalSignal({
        ...runningGame,
        events: [goal, { gameTime: minute, relatedEventId: goal.id, eventType: { id: kind.id, name: kind.name } }]
      }, snapshot, previous)).toMatchObject(kind.expected);
      expect(extract365ScoresGoalSignal({
        game: { ...runningGame, events: [goal] },
        playByPlay: { Messages: [{ GameTime: minute, RelatedEventId: goal.id, Title: kind.name }] }
      }, snapshot, previous)).toMatchObject(kind.expected);
    });

  test.each(negatives)("identifies the latest scoring-side goal without needing score text for $name", (kind) => {
    const { description: _description, ...withoutScoreText } = goal;
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [
        { ...withoutScoreText, id: "previous-home-goal", gameTime: 10 },
        withoutScoreText,
        { ...withoutScoreText, id: "other-side", gameTime: 94, competitorId: 20 },
        { gameTime: 94, relatedEventId: goal.id, eventType: { id: kind.id, name: kind.name } }
      ]
    }, { ...current, minute: 94 }, previous)).toMatchObject(kind.expected);
  });

  test.each(negatives)("can prove a referenced $name belongs to an older goal before the current one", (kind) => {
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [
        { ...goal, id: "old-goal", gameTime: 10, description: "Goal! Switzerland 2-1 Canada." },
        goal,
        { gameTime: 93, relatedEventId: "old-goal", eventType: { id: kind.id, name: kind.name } }
      ]
    }, current, previous)).toMatchObject({ hasMatchingGoal: true, hasNoGoalSignal: false, hasVarReviewSignal: false });
  });

  test("does not call a referenced goal historical solely from elapsed time without incident evidence", () => {
    const { description: _description, ...withoutScoreText } = goal;
    expect(extract365ScoresGoalSignal({
      ...runningGame,
      events: [withoutScoreText, { gameTime: 93, relatedEventId: goal.id, eventType: { id: 11, name: "No Goal" } }]
    }, current)).toMatchObject({ hasMatchingGoal: false, hasNoGoalSignal: true });
  });
});

describe("current score transition keeps every contributing goal protected", () => {
  test.each(["events", "PBP"].flatMap(source => ["No Goal", "VAR Review"].flatMap(name => [false, true].map(batch => ({ source, name, batch })))))(
    "preserves $source $name for an earlier newly observed goal (batch=$batch)", ({ source, name, batch }) => {
      const current: MatchState = { ...match, homeTeam: "Switzerland", awayTeam: "Canada", homeGoals: batch ? 4 : 3, awayGoals: 1, minute: 94 };
      const previous = { ...current, homeGoals: 2, minute: 88 };
      const first = { id: "first", competitorId: 10, gameTime: 89, description: "Goal! Switzerland 3-1 Canada.", eventType: { id: 1, name: "Goal" } };
      const goals = batch ? [first, { ...first, id: "second", gameTime: 93, description: "Goal! Switzerland 4-1 Canada." }] : [first];
      const game = { id: 123, homeCompetitor: { id: 10, name: "Switzerland", score: current.homeGoals }, awayCompetitor: { id: 20, name: "Canada", score: 1 }, events: goals };
      const negative = { competitorId: 10, gameTime: batch ? 94 : 89, ...(batch ? { relatedEventId: "first" } : {}), eventType: { id: name === "No Goal" ? 11 : 99, name } };
      const raw = source === "events" ? { ...game, events: [...goals, negative] } : {
        game, playByPlay: { Messages: [{ CompetitorId: 10, GameTime: batch ? 94 : 89, ...(batch ? { RelatedEventId: "first" } : {}), Title: name }] }
      };
      expect(extract365ScoresGoalSignal(raw, current, previous)).toMatchObject(name === "No Goal"
        ? { hasNoGoalSignal: true, hasMatchingGoal: false }
        : { hasVarReviewSignal: true });
    }
  );
});

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

  test("does not flag a normal stoppage-time goal as post-regulation", () => {
    const signal = extract365ScoresGoalSignal({
      game: {
        id: 4749272,
        statusText: "2nd Half",
        gameTimeDisplay: "90+2'",
        homeCompetitor: { id: 2373, name: "Belgium", score: 3 },
        awayCompetitor: { id: 5102, name: "Senegal", score: 2 },
        events: [
          {
            competitorId: 2373,
            gameTime: 92,
            addedTime: 2,
            eventType: { id: 1, name: "Goal", subTypeName: "Field Goal" }
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
      hasPostRegulationGoalSignal: false
    });
    expect(signal?.details.join(" ")).not.toContain("post-regulation");
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
