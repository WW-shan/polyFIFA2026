import type { CollectorEvent } from "./types.js";

type NonMatchReason = "coupon" | "ranking" | "season-or-statistic" | "tournament-outright";
export type MatchScope =
  | { kind: "single-match"; reason: "game-id" | "participants-and-match-evidence" }
  | { kind: "non-match"; reason: NonMatchReason }
  | { kind: "ambiguous"; reason: "missing-participants" | "missing-match-evidence" };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function participant(value: unknown): string {
  const name = text(typeof value === "object" && value !== null && "name" in value ? value.name : value);
  if (!/\p{L}/u.test(name) || /^(?:yes|no|over|under|draw|tie|tbd|tba|home|away|to be determined|to be announced)$/i.test(name)) return "";
  return name.toLowerCase();
}

function participantPair(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const first = participant(value[0]), second = participant(value[1]);
  return first !== "" && second !== "" && first !== second;
}

function matchupTitle(title: string): boolean {
  const versus = title.split(/\s+(?:vs\.?|versus)\s+/i);
  // Prefer explicit "vs"; a doubles participant's "V." is a name initial.
  const short = versus.length > 1 ? versus : title.split(/\s+(?:v\.?|V)\s+/);
  const sides = short.length > 1 ? short : title.split(/\s+[-–—]\s+/);
  return participantPair(sides.map((side, index) => index === 0 ? side.split(":").at(-1)!
    : side.split(/:|\s+[-–—]\s+/)[0]!));
}

function nonMatchReason(value: string, matchup = matchupTitle(value)): NonMatchReason | undefined {
  const label = value.toLowerCase().replace(/[-_–—]+/g, " ");
  const contest = /\b(?:match|game|round|quarterfinal|semifinal|final|set)\b/.test(label);
  if (/\b(?:coupons?|parlay|accumulator)\b/.test(label)) return "coupon";
  if (/\brankings?\b/.test(label)
    || (/\byear end\b/.test(label) && /\b(?:ranked|no\.?\s*1|top\s*\d+)|#\d+/.test(label))
    || /\bend\s+(?:of\s+)?(?:20\d{2}|the year)\b.*\b(?:ranked|no\.?\s*1|#1)\b/.test(label)) return "ranking";
  if ((!matchup && !contest && /\b(?:season|seasonal|career)\b/.test(label))
    || /\b(?:(?:this|next|entire|full) season|(?:throughout|during) (?:the )?season|(?:season(?:al)?|career) (?:statistics|stats))\b/.test(label)
    || (!contest && /\b(?:20\d{2}|year|season|career)\b/.test(label)
      && /\b(?:most|more|how many)\b.*\b(?:titles|grand slams|tournaments|aces|wins|goals|points)\b/.test(label))) return "season-or-statistic";
  if (/\boutright\b/.test(label) || (!matchup && !contest
    && /\b(?:win|winner|winners|champion|champions)\b/.test(label)
    && /\b(?:tournament|championship|cup|league|open|wimbledon|roland garros|masters|finals)\b/.test(label))) return "tournament-outright";
  return undefined;
}

/** Classify scope only. This never manufactures a game ID or a finish clock. */
export function classifyMatchScope(event: CollectorEvent): MatchScope {
  const titleMatchup = matchupTitle(event.title);
  const excluded = nonMatchReason(event.title, titleMatchup) ?? nonMatchReason(event.eventSlug, titleMatchup);
  if (excluded) return { kind: "non-match", reason: excluded };
  // A generic event title can still contain an entire tournament-winner slate.
  const marketReasons = event.markets.map(market => {
    const type = text(market.raw.sportsMarketType).toLowerCase();
    if (type === "season_winner") return "season-or-statistic" as const;
    if (["outright", "tournament_winner", "championship_winner", "futures"].includes(type)) return "tournament-outright" as const;
    return nonMatchReason(market.question);
  });
  if (marketReasons.length > 0 && marketReasons.every(reason => reason !== undefined)) {
    return { kind: "non-match", reason: marketReasons[0]! };
  }
  if (event.gameId !== null) return { kind: "single-match", reason: "game-id" };

  const participants = titleMatchup || participantPair(event.raw.participants) || participantPair(event.raw.teams)
    || event.markets.some(market => participantPair(market.outcomes));
  if (!participants) return { kind: "ambiguous", reason: "missing-participants" };
  const sportsMarket = event.markets.some(market => text(market.raw.sportsMarketType) !== "");
  // Gamma startDate/endDate are metadata dates, not scheduled match clocks.
  const scheduled = [event.raw.startTime, ...event.markets.map(market => market.raw.gameStartTime)]
    .some(value => typeof value === "string" && Number.isFinite(Date.parse(value)));
  if (!sportsMarket && !scheduled) return { kind: "ambiguous", reason: "missing-match-evidence" };
  return { kind: "single-match", reason: "participants-and-match-evidence" };
}
