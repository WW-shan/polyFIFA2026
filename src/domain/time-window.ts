import type { MatchState, TailWindowSource } from "./types.js";

export type TailWindowMode = "remaining" | "conservative90";

export interface TailWindowOptions {
  entryWindowMinutes?: number;
  mode?: TailWindowMode;
}

export interface TailWindowDecision {
  eligible: boolean;
  source: TailWindowSource;
  details: string;
}

export function classifyTailWindow(match: MatchState, options: TailWindowOptions = {}): TailWindowDecision {
  const entryWindowMinutes = options.entryWindowMinutes ?? 3;
  const entryWindowSeconds = entryWindowMinutes * 60;
  const mode = options.mode ?? "conservative90";

  if (match.period !== "2H" || !match.isLive || match.ended === true) {
    return {
      eligible: false,
      source: "not_live_second_half",
      details: `period=${match.period} isLive=${match.isLive} ended=${match.ended === true}`
    };
  }

  if (match.remainingSeconds !== undefined) {
    const eligible = match.remainingSeconds >= 0 && match.remainingSeconds <= entryWindowSeconds;
    return {
      eligible,
      source: "remaining_seconds",
      details: `remainingSeconds=${match.remainingSeconds} threshold=${entryWindowSeconds}`
    };
  }

  if (match.remainingMinutes !== undefined) {
    const eligible = match.remainingMinutes >= 0 && match.remainingMinutes <= entryWindowMinutes;
    return {
      eligible,
      source: "remaining_minutes",
      details: `remainingMinutes=${match.remainingMinutes} threshold=${entryWindowMinutes}`
    };
  }

  if (mode === "conservative90" && match.elapsedSeconds !== undefined) {
    const eligible = match.elapsedSeconds >= 90 * 60;
    return {
      eligible,
      source: "conservative_90_plus",
      details: `elapsedSeconds=${match.elapsedSeconds} threshold=${90 * 60}`
    };
  }

  return {
    eligible: false,
    source: "not_enough_time_data",
    details: "No remainingSeconds, remainingMinutes, or conservative elapsedSeconds entry was available"
  };
}

export function isTailWindowEligible(match: MatchState, options: TailWindowOptions = {}): boolean {
  return classifyTailWindow(match, options).eligible;
}
