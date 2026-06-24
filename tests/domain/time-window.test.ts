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
  test("uses strict remainingSeconds when available", () => {
    expect(classifyTailWindow({ ...baseMatch, remainingSeconds: 180 })).toMatchObject({
      eligible: true,
      source: "remaining_seconds"
    });
    expect(classifyTailWindow({ ...baseMatch, remainingSeconds: 181 })).toMatchObject({
      eligible: false,
      source: "remaining_seconds"
    });
  });

  test("uses strict remainingMinutes when available", () => {
    expect(classifyTailWindow({ ...baseMatch, remainingMinutes: 3 })).toMatchObject({
      eligible: true,
      source: "remaining_minutes"
    });
    expect(classifyTailWindow({ ...baseMatch, remainingMinutes: 4 })).toMatchObject({
      eligible: false,
      source: "remaining_minutes"
    });
  });

  test("conservative mode enters only at 90:00 or later without remaining time", () => {
    expect(classifyTailWindow({ ...baseMatch, elapsedSeconds: 89 * 60 + 30 })).toMatchObject({
      eligible: false,
      source: "conservative_90_plus"
    });
    expect(classifyTailWindow({ ...baseMatch, elapsedSeconds: 90 * 60 })).toMatchObject({
      eligible: true,
      source: "conservative_90_plus"
    });
  });

  test("remaining-only mode refuses matches without remaining time", () => {
    expect(classifyTailWindow({ ...baseMatch, elapsedSeconds: 91 * 60 }, { mode: "remaining" })).toMatchObject({
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
