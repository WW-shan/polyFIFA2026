import type { MatchState, TailWindowSource } from "./types.js";

export interface TailWindowOptions {
  entryWindowMinutes?: number;
}

export interface TailWindowDecision {
  eligible: boolean;
  source: TailWindowSource;
  details: string;
}

export function classifyTailWindow(match: MatchState, options: TailWindowOptions = {}): TailWindowDecision {
  const entryWindowMinutes = options.entryWindowMinutes ?? 3;
  const entryWindowSeconds = entryWindowMinutes * 60;

  if (match.period !== "2H" || !match.isLive || match.ended === true) {
    return {
      eligible: false,
      source: "not_live_second_half",
      details: `period=${match.period} isLive=${match.isLive} ended=${match.ended === true}`
    };
  }

  if (match.remainingSeconds !== undefined) {
    if (match.remainingSecondsSource !== "365scores_added_time_precise_game_time") {
      return {
        eligible: false,
        source: "not_enough_time_data",
        details: `remainingSeconds=${match.remainingSeconds} is unverified; source=${match.remainingSecondsSource ?? "missing"}`
      };
    }
    const eligible = Number.isFinite(match.remainingSeconds) && match.remainingSeconds >= 0 && match.remainingSeconds <= entryWindowSeconds;
    return {
      eligible,
      source: "remaining_seconds",
      details: `remainingSeconds=${match.remainingSeconds} threshold=${entryWindowSeconds} source=${match.remainingSecondsSource}`
    };
  }

  return {
    eligible: false,
    source: "not_enough_time_data",
    details: "No verified remainingSeconds from 365Scores addedTime + preciseGameTime was available"
  };
}

export function isTailWindowEligible(match: MatchState, options: TailWindowOptions = {}): boolean {
  return classifyTailWindow(match, options).eligible;
}
