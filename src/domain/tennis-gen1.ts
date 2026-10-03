/**
 * The single Gen1 decision shared by the backtest and the live watcher.
 *
 * `scripts/research/tennis-gen1-backtest.mjs` imports this module, so the
 * archived backtest and the live order path can never drift on the entry
 * definition: one parser, one rule.
 *
 * Score strings come from Polymarket's own sports feed: `"6-2, 5-2"` or
 * `"6-4, 6-6(5-2)"`. Tiebreak points in parentheses are ignored, exactly like
 * the original backtest parser did.
 */

export interface TennisScoreSet {
  home: number;
  away: number;
}

/** Splits `"6-2, 5-2"` / `"6-4, 6-6(5-2)"` into per-set scores. */
export function parseTennisScoreSets(score: unknown): TennisScoreSet[] {
  if (typeof score !== "string") return [];
  const sets: TennisScoreSet[] = [];
  for (const part of score.split(",")) {
    const match = part.trim().match(/^(\d+)\s*-\s*(\d+)/);
    if (!match) continue;
    const home = Number(match[1]);
    const away = Number(match[2]);
    if (!Number.isSafeInteger(home) || !Number.isSafeInteger(away)) continue;
    sets.push({ home, away });
  }
  return sets;
}

/** Sets won in the completed sets (every set except the live one). */
export function tennisSetsWon(sets: readonly TennisScoreSet[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const set of sets.slice(0, -1)) {
    if (set.home > set.away) home += 1;
    else if (set.away > set.home) away += 1;
  }
  return { home, away };
}

export interface TennisGen1Decision {
  /** Favoured side in the feed's home/away coordinate. */
  side: "home" | "away";
  /** `game` for 5-x / 6-5, `tiebreak` for a 6-6 live set. */
  kind: "game" | "tiebreak";
  /** Sets won by the favoured side (always `setsToWin - 1`). */
  favoredSets: number;
  /** Sets won by each side over the completed sets. */
  setWins: { home: number; away: number };
  /** The live set's games. */
  currentSet: TennisScoreSet;
}

/**
 * Gen1: one side holds `setsToWin - 1` sets and the live set is decided by the
 * next games — the side leads 5-x (x<=4) or 6-5, or the set is at 6-6 and the
 * side holds a strict lead in sets.
 *
 * A 6-6 live set where both sides already hold `setsToWin - 1` sets (a deciding
 * set at 1-1 / 2-2) names no favourite: it returns null. The original research
 * script took the feed's home side there; the documented live universe excludes
 * those 12 matches / 9 fills (+1.22 on the 1-share scale).
 */
export function tennisGen1(score: unknown, setsToWin: number): TennisGen1Decision | null {
  if (!Number.isSafeInteger(setsToWin) || setsToWin < 2) return null;
  const sets = parseTennisScoreSets(score);
  if (sets.length === 0) return null;
  const currentSet = sets[sets.length - 1]!;
  const setWins = tennisSetsWon(sets);
  const candidates: Array<{ side: "home" | "away"; kind: "game" | "tiebreak" }> = [];
  for (const side of ["home", "away"] as const) {
    if ((side === "home" ? setWins.home : setWins.away) !== setsToWin - 1) continue;
    const own = side === "home" ? currentSet.home : currentSet.away;
    const other = side === "home" ? currentSet.away : currentSet.home;
    if ((own === 5 && other <= 4) || (own === 6 && other === 5)) candidates.push({ side, kind: "game" });
    else if (own === 6 && other === 6) candidates.push({ side, kind: "tiebreak" });
  }
  if (candidates.length > 1) return null; // 1-1 (or 2-2) at 6-6: no favourite.
  const chosen = candidates[0];
  if (!chosen) return null;
  return { ...chosen, favoredSets: setsToWin - 1, setWins, currentSet };
}
