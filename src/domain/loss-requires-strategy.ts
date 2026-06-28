import { getLeader, isWorldCupMatch } from "./spread-selector.js";
import { classifyTailWindow } from "./time-window.js";
import { DEFAULT_ENTRY_WINDOW_MINUTES, MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS } from "./risk-thresholds.js";
import type { MatchState, SelectedStrategyMarket, StrategyMarket, TailStrategy } from "./types.js";

export interface LossRequiresStrategyOptions {
  entryWindowMinutes?: number;
  includeLocked?: boolean;
  allowLockedOutsideEntryWindow?: boolean;
}

interface TeamScore {
  team: string;
  goals: number;
}

export function selectLossRequiresCandidates(
  match: MatchState,
  markets: readonly StrategyMarket[],
  options: LossRequiresStrategyOptions = {}
): SelectedStrategyMarket[] {
  const entryWindowMinutes = options.entryWindowMinutes ?? DEFAULT_ENTRY_WINDOW_MINUTES;
  const includeLocked = options.includeLocked ?? true;
  const inEntryWindow = isInEntryWindow(match, entryWindowMinutes);

  if (!isWorldCupMatch(match)) return [];
  if (!inEntryWindow && !(includeLocked && options.allowLockedOutsideEntryWindow === true && isLiveSecondHalf(match))) return [];

  const candidates = markets
    .filter((market) => market.eventSlug === match.eventSlug)
    .flatMap((market) => candidatesForMarket(match, market, includeLocked, inEntryWindow));

  return dedupeCandidates(candidates);
}

function isInEntryWindow(match: MatchState, entryWindowMinutes: number): boolean {
  return classifyTailWindow(match, {
    entryWindowMinutes
  }).eligible;
}

function candidatesForMarket(match: MatchState, market: StrategyMarket, includeLocked: boolean, includeNonLocked: boolean): SelectedStrategyMarket[] {
  if (isDrawMarket(market)) return includeNonLocked ? drawCandidates(match, market) : [];
  if (isBttsMarket(market)) return includeLocked ? bttsCandidates(match, market) : [];
  if (isTeamTotalMarket(market)) return teamTotalCandidates(match, market, includeLocked, includeNonLocked);
  if (isTotalMarket(market)) return totalCandidates(match, market, includeLocked, includeNonLocked);
  if (isSpreadMarket(market)) return includeNonLocked ? spreadCandidates(match, market) : [];
  if (isMoneylineMarket(market)) return includeNonLocked ? moneylineCandidates(match, market) : [];
  return [];
}

function isLiveSecondHalf(match: MatchState): boolean {
  return match.period === "2H" && match.isLive && match.ended !== true;
}

function moneylineCandidates(match: MatchState, market: StrategyMarket): SelectedStrategyMarket[] {
  const team = parseWillWinTeam(market.question);
  if (!team) return [];

  const scores = teamScores(match);
  const teamScore = findTeam(scores, team);
  const otherScore = scores.find((score) => normalize(score.team) !== normalize(teamScore?.team ?? team));
  if (!teamScore || !otherScore) return [];

  const margin = teamScore.goals - otherScore.goals;
  const candidates: SelectedStrategyMarket[] = [];

  if (margin >= MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS) {
    const candidate = toCandidate(market, "leader_yes_lead_ge2", "Yes", margin);
    if (candidate) candidates.push(candidate);
  }

  if (margin <= -1) {
    const lossRequiresGoals = Math.abs(margin) + 1;
    const candidate = lossRequiresGoals >= MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS
      ? toCandidate(market, "loser_no", "No", lossRequiresGoals)
      : null;
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

function drawCandidates(match: MatchState, market: StrategyMarket): SelectedStrategyMarket[] {
  const leader = getLeader(match);
  if (!leader || leader.margin < MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS) return [];

  const candidate = toCandidate(market, "draw_no_lead_ge2", "No", leader.margin);
  return candidate ? [candidate] : [];
}

function totalCandidates(match: MatchState, market: StrategyMarket, includeLocked: boolean, includeNonLocked = true): SelectedStrategyMarket[] {
  const line = market.line ?? parseOuLine(market.question);
  if (line === null) return [];

  const currentTotal = match.homeGoals + match.awayGoals;
  const overAtTotal = Math.floor(line) + 1;
  const candidates: SelectedStrategyMarket[] = [];

  if (includeNonLocked && overAtTotal - currentTotal >= MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS) {
    const candidate = toCandidate({ ...market, line }, "total_under_loss_ge2", "Under", overAtTotal - currentTotal);
    if (candidate) candidates.push(candidate);
  }

  if (includeLocked && currentTotal >= overAtTotal) {
    const candidate = toCandidate({ ...market, line }, "total_over_locked", "Over", 999, true);
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

function spreadCandidates(match: MatchState, market: StrategyMarket): SelectedStrategyMarket[] {
  const line = market.line ?? parseSpreadLine(market.question);
  if (line === null) return [];

  const spreadTeamName = parseSpreadTeam(market.question) ?? market.outcomes[0];
  if (!spreadTeamName) return [];

  const scores = teamScores(match);
  const spreadTeam = findTeam(scores, spreadTeamName);
  const otherTeam = scores.find((score) => normalize(score.team) !== normalize(spreadTeam?.team ?? spreadTeamName));
  if (!spreadTeam || !otherTeam) return [];

  const currentMargin = spreadTeam.goals - otherTeam.goals;
  const requiredMargin = Math.floor(-line) + 1;
  const candidates: SelectedStrategyMarket[] = [];

  if (currentMargin >= requiredMargin) {
    const lossRequiresGoals = currentMargin - requiredMargin + 1;
    if (lossRequiresGoals >= MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS) {
      const outcome = spreadCoverOutcome(market, spreadTeamName);
      const candidate = outcome ? toCandidate({ ...market, line }, "spread_tight_loss_ge2", outcome, lossRequiresGoals) : null;
      if (candidate) {
        candidate.spreadSide = "favorite_cover";
        candidates.push(candidate);
      }
    }
  } else {
    const lossRequiresGoals = requiredMargin - currentMargin;
    if (lossRequiresGoals >= MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS) {
      const otherOutcome = spreadOtherSideOutcome(market, spreadTeamName);
      if (otherOutcome) {
        const candidate = toCandidate({ ...market, line }, "spread_tight_loss_ge2", otherOutcome, lossRequiresGoals);
        if (candidate) {
          candidate.spreadSide = "other_side";
          candidates.push(candidate);
        }
      }
    }
  }

  return candidates;
}

function spreadCoverOutcome(market: StrategyMarket, spreadTeamName: string): string | null {
  const yesOutcome = market.outcomes.find((outcome) => normalize(outcome) === "yes");
  if (yesOutcome) return yesOutcome;
  return market.outcomes.find((outcome) => normalize(outcome) === normalize(spreadTeamName)) ?? null;
}

function spreadOtherSideOutcome(market: StrategyMarket, spreadTeamName: string): string | null {
  const noOutcome = market.outcomes.find((outcome) => normalize(outcome) === "no");
  if (noOutcome) return noOutcome;
  return market.outcomes.find((outcome) => normalize(outcome) !== normalize(spreadTeamName)) ?? null;
}

function teamTotalCandidates(match: MatchState, market: StrategyMarket, includeLocked: boolean, includeNonLocked = true): SelectedStrategyMarket[] {
  const line = market.line ?? parseOuLine(market.question);
  const team = market.team ?? parseTeamTotalTeam(market.question, match);
  if (line === null || !team) return [];

  const score = findTeam(teamScores(match), team);
  if (!score) return [];

  const overAtTotal = Math.floor(line) + 1;
  const candidates: SelectedStrategyMarket[] = [];

  if (includeNonLocked && overAtTotal - score.goals >= MINIMUM_NON_LOCKED_LOSS_REQUIRES_GOALS) {
    const candidate = toCandidate({ ...market, line, team: score.team }, "team_total_under_loss_ge2", "Under", overAtTotal - score.goals);
    if (candidate) candidates.push(candidate);
  }

  if (includeLocked && score.goals >= overAtTotal) {
    const candidate = toCandidate({ ...market, line, team: score.team }, "team_total_over_locked", "Over", 999, true);
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

function bttsCandidates(match: MatchState, market: StrategyMarket): SelectedStrategyMarket[] {
  if (match.homeGoals <= 0 || match.awayGoals <= 0) return [];
  const candidate = toCandidate(market, "btts_yes_locked", "Yes", 999, true);
  return candidate ? [candidate] : [];
}

function isTotalMarket(market: StrategyMarket): boolean {
  const type = market.marketType;
  if (type === "team_total") return false;
  if (type === "total") return true;
  const question = market.question.toLowerCase();
  return /\bo\/u\b/i.test(market.question) && !containsKnownTeamAfterColon(market);
}

function isTeamTotalMarket(market: StrategyMarket): boolean {
  return market.marketType === "team_total" || (/\bo\/u\b/i.test(market.question) && containsKnownTeamAfterColon(market));
}

function isSpreadMarket(market: StrategyMarket): boolean {
  return market.marketType === "spread" || market.question.toLowerCase().startsWith("spread:");
}

function isMoneylineMarket(market: StrategyMarket): boolean {
  return market.marketType === "moneyline" || /^will .+ win\b/i.test(market.question);
}

function isDrawMarket(market: StrategyMarket): boolean {
  return market.marketType === "draw" || /\bend in a draw\b/i.test(market.question);
}

function isBttsMarket(market: StrategyMarket): boolean {
  return market.marketType === "btts" || /both teams to score/i.test(market.question);
}

function containsKnownTeamAfterColon(market: StrategyMarket): boolean {
  return parseTeamTotalTeamFromQuestion(market.question) !== null;
}

function toCandidate(
  market: StrategyMarket,
  strategy: TailStrategy,
  outcome: string,
  lossRequiresGoals: number,
  locked = false
): SelectedStrategyMarket | null {
  const outcomeIndex = market.outcomes.findIndex((candidate) => normalize(candidate) === normalize(outcome));
  if (outcomeIndex < 0) return null;

  const tokenId = market.clobTokenIds[outcomeIndex];
  if (!tokenId) return null;

  const selected: SelectedStrategyMarket = {
    ...market,
    strategy,
    outcome: market.outcomes[outcomeIndex] ?? outcome,
    tokenId,
    outcomeIndex,
    lossRequiresGoals
  };
  if (locked) selected.locked = true;
  return selected;
}

function teamScores(match: MatchState): [TeamScore, TeamScore] {
  return [
    { team: match.homeTeam, goals: match.homeGoals },
    { team: match.awayTeam, goals: match.awayGoals }
  ];
}

function findTeam(scores: readonly TeamScore[], team: string): TeamScore | undefined {
  const normalized = normalize(team);
  return scores.find((score) => normalize(score.team) === normalized || normalized.includes(normalize(score.team)) || normalize(score.team).includes(normalized));
}

function parseWillWinTeam(question: string): string | null {
  const match = question.match(/^Will\s+(.+?)\s+win\b/i);
  return match?.[1]?.trim() ?? null;
}

function parseSpreadTeam(question: string): string | null {
  const match = question.match(/^Spread:\s+(.+?)\s+\(/i);
  return match?.[1]?.trim() ?? null;
}

function parseSpreadLine(question: string): number | null {
  const match = question.match(/\(([+-]?\d+(?:\.\d+)?)\)/);
  return match?.[1] ? Number(match[1]) : null;
}

function parseOuLine(question: string): number | null {
  const match = question.match(/\bO\/U\s+([+-]?\d+(?:\.\d+)?)/i);
  return match?.[1] ? Number(match[1]) : null;
}

function parseTeamTotalTeam(question: string, match: MatchState): string | null {
  const parsed = parseTeamTotalTeamFromQuestion(question);
  if (!parsed) return null;
  return findTeam(teamScores(match), parsed)?.team ?? parsed;
}

function parseTeamTotalTeamFromQuestion(question: string): string | null {
  const afterColon = question.split(":").slice(1).join(":").trim();
  if (!afterColon) return null;
  const match = afterColon.match(/^(.+?)\s+O\/U\b/i);
  return match?.[1]?.trim() ?? null;
}

function dedupeCandidates(candidates: SelectedStrategyMarket[]): SelectedStrategyMarket[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.strategy}:${candidate.conditionId}:${candidate.tokenId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalize(value: string): string {
  return value.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and");
}
