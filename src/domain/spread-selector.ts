import type { MatchState, SelectedSpread, SpreadMarket, SpreadSelection } from "./types.js";

export interface SpreadSelectorOptions {
  entryWindowMinutes?: number;
}

export function isWorldCupMatch(match: Pick<MatchState, "eventSlug">): boolean {
  return match.eventSlug.startsWith("fifwc-");
}

export function getLeader(match: MatchState): { team: string; margin: number } | null {
  const margin = Math.abs(match.homeGoals - match.awayGoals);
  if (margin === 0) return null;
  return {
    team: match.homeGoals > match.awayGoals ? match.homeTeam : match.awayTeam,
    margin
  };
}

export function selectCoveredSpread(
  match: MatchState,
  markets: readonly SpreadMarket[],
  options: SpreadSelectorOptions = {}
): SpreadSelection {
  const entryWindowMinutes = options.entryWindowMinutes ?? 3;

  if (!isWorldCupMatch(match)) {
    return { action: "NO_TRADE", reason: "NOT_WORLD_CUP" };
  }

  if (!isInEntryWindow(match, entryWindowMinutes)) {
    return { action: "NO_TRADE", reason: "MATCH_NOT_LATE_ENOUGH" };
  }

  const leader = getLeader(match);
  if (!leader || leader.margin < 2) {
    return { action: "NO_TRADE", reason: "LEAD_TOO_SMALL" };
  }

  const covered = markets
    .filter((market) => market.eventSlug === match.eventSlug)
    .map((market) => toSelectedSpread(market, leader.team, leader.margin))
    .filter((market): market is SelectedSpread => Boolean(market))
    .filter((market) => Math.abs(market.line) < leader.margin)
    .sort((a, b) => Math.abs(b.line) - Math.abs(a.line));

  if (!covered[0]) {
    return { action: "NO_TRADE", reason: "NO_COVERED_SPREAD" };
  }

  return { action: "SELECTED", market: covered[0] };
}

function isInEntryWindow(match: MatchState, entryWindowMinutes: number): boolean {
  return match.period === "2H"
    && match.isLive
    && match.remainingMinutes !== undefined
    && match.remainingMinutes >= 0
    && match.remainingMinutes <= entryWindowMinutes;
}

function toSelectedSpread(market: SpreadMarket, winner: string, margin: number): SelectedSpread | null {
  const outcomeIndex = market.outcomes.findIndex((outcome) => normalize(outcome) === normalize(winner));
  if (outcomeIndex !== 0) return null;

  const tokenId = market.clobTokenIds[outcomeIndex];
  if (!tokenId) return null;

  return {
    ...market,
    outcome: market.outcomes[outcomeIndex] ?? winner,
    tokenId,
    outcomeIndex,
    margin
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}
