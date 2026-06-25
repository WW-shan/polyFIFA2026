import { describe, expect, test } from "vitest";
import { classifyTailWindow, isTailWindowEligible } from "../../src/domain/time-window.js";
import type { MatchState } from "../../src/domain/types.js";

const baseMatch: MatchState = {
  eventSlug: "fifwc-strong-weak-2026-06-23",
  homeTeam: "Strong",
  awayTeam: "Weak",
  homeGoals: 2,
  awayGoals: 0,
  minute: 90,
  period: "2H",
  isLive: true
};

describe("tail-window classifier", () => {
  test("uses only verified 365Scores remainingSeconds", () => {
    expect(classifyTailWindow({
      ...baseMatch,
      remainingSeconds: 180,
      remainingSecondsSource: "365scores_added_time_precise_game_time"
    })).toMatchObject({
      eligible: true,
      source: "remaining_seconds"
    });
    expect(classifyTailWindow({
      ...baseMatch,
      remainingSeconds: 181,
      remainingSecondsSource: "365scores_added_time_precise_game_time"
    })).toMatchObject({
      eligible: false,
      source: "remaining_seconds"
    });
  });

  test("refuses unverified remainingSeconds", () => {
    expect(classifyTailWindow({ ...baseMatch, remainingSeconds: 120 })).toMatchObject({
      eligible: false,
      source: "not_enough_time_data",
      details: expect.stringContaining("unverified")
    });
  });

  test("refuses remainingMinutes because minute-level data is not exact enough", () => {
    const minuteLevelMatch = { ...baseMatch, remainingMinutes: 2 } as MatchState;
    expect(classifyTailWindow(minuteLevelMatch)).toMatchObject({
      eligible: false,
      source: "not_enough_time_data"
    });
  });

  test("does not use 90-plus elapsed time as a fallback", () => {
    expect(classifyTailWindow({ ...baseMatch, elapsedSeconds: 95 * 60 })).toMatchObject({
      eligible: false,
      source: "not_enough_time_data"
    });
  });

  test("never enters for non-live or non-second-half states", () => {
    expect(isTailWindowEligible({ ...baseMatch, period: "HT", elapsedSeconds: 90 * 60 })).toBe(false);
    expect(isTailWindowEligible({ ...baseMatch, period: "FT", elapsedSeconds: 90 * 60 })).toBe(false);
    expect(isTailWindowEligible({ ...baseMatch, isLive: false, elapsedSeconds: 90 * 60 })).toBe(false);
    expect(isTailWindowEligible({ ...baseMatch, ended: true, elapsedSeconds: 90 * 60 })).toBe(false);
  });
});
