import type { CollectorEvent, CollectorMarket } from "./types.js";

type NonMatchReason = "coupon" | "ranking" | "season-or-statistic" | "tournament-outright";
export type MatchScope =
  | { kind: "single-match"; reason: "game-id" | "participants-and-match-evidence" }
  | { kind: "non-match"; reason: NonMatchReason }
  | { kind: "ambiguous"; reason: "missing-participants" | "missing-match-evidence" };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function participant(value: unknown): string {
  // Canonicalize only for identity checks; the supplied outcome labels stay raw.
  const name = text(typeof value === "object" && value !== null && "name" in value ? value.name : value)
    .toLowerCase().replace(/\s+/g, " ")
    .replace(/\s*\(\s*[+−-]?\d+(?:\.\d+)?\s*\)$/, "")
    .replace(/\s+[+−-]\d+(?:\.\d+)?$/, "").trim();
  if (!/\p{L}/u.test(name) || /^(?:tbd|tba|to be determined|to be announced)$/.test(name)) return "";
  return name;
}

const categoryPairs = [
  ["yes", "no"], ["odd", "even"], ["over", "under"], ["home", "away"],
  ["high", "low"], ["higher", "lower"], ["above", "below"], ["first", "second"],
  ["both", "neither"], ["none", "other"], ["draw", "tie"]
] as const;

function categoryLabel(value: string): string {
  // Unsigned thresholds affect category matching only, not names like Schalke 04.
  return value.replace(/\s+\d+(?:\.\d+)?(?:\s+\p{L}+)?$/u, "")
    .replace(/^1st\b/, "first").replace(/^2nd\b/, "second")
    .replace(/^(first|second) (?:half|set|period|quarter|map)$/, "$1");
}

function participantPair(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const first = participant(value[0]), second = participant(value[1]);
  if (first === "" || second === "" || first === second) return false;
  const left = categoryLabel(first), right = categoryLabel(second);
  // Reject opposing categories as a pair; a club named Odd can still face Brann.
  return !categoryPairs.some(([a, b]) => (left === a && right === b) || (left === b && right === a));
}

function outcomeParticipants(market: CollectorMarket): boolean {
  const type = text(market.raw.sportsMarketType).toLowerCase();
  // Winner, spread and handicap labels can name opponents. Categorical markets
  // need independent identity; untyped markets can use names plus a start.
  if (type !== "" && type !== "moneyline" && !/(?:^|_)(?:winner|spreads?|handicaps?)$/.test(type)) return false;
  return participantPair(market.outcomes);
}

function marketHeading(value: string): boolean {
  return /^(?:(?:men'?s|women'?s|singles|doubles|match|tournament|game|set|first|second|1st|2nd)\s+)*(?:winner|moneyline|totals?|spreads?|handicaps?|more markets)$/i.test(value.trim());
}

function matchupTitle(title: string): boolean {
  const versus = title.split(/\s+(?:vs\.?|versus)\s+/i);
  // Prefer explicit "vs"; a doubles participant's "V." is a name initial.
  const short = versus.length > 1 ? versus : title.split(/\s+(?:v\.?|V)\s+/);
  let sides = short;
  if (sides.length === 1) {
    sides = title.split(/\s+[-–—]\s+/);
    // Dashes can delimit a market heading instead of an opponent. Remove a
    // heading suffix, then require two actual sides in the remaining title.
    while (sides.length > 0 && marketHeading(sides.at(-1)!)) sides.pop();
    if (sides.some(marketHeading)) return false;
  }
  return participantPair(sides.map((side, index) => index === 0 ? side.split(":").at(-1)!
    : side.split(/:|\s+[-–—]\s+/)[0]!));
}

function singleContestReference(label: string, matchIdentity = false): boolean {
  // An identified event can qualify its match reference with an opponent or
  // a parenthetical rule. The year in that reference dates the match.
  if (matchIdentity && /\b(?:in|during|at|for) (?:the|this|that) [^:;?!]*\b(?:match|game|set|round|quarterfinal|semifinal|final)(?=\s*(?:[(?.!,]|$)|\s+(?:against|between|with|on|at|in)\b)/.test(label)) return true;
  // A match/game/set can modify an annual count ("match wins"). Only a
  // reference to a particular contest establishes a single-match statistic.
  return /\b(?:this|that) (?:match|game|set|round|quarterfinal|semifinal|final)\b/.test(label)
    || /\b(?:match|game|set|round|quarterfinal|semifinal|final)(?: in 20\d{2})?\s*[?.!]*$/.test(label);
}

function longTermStatistic(label: string, matchup: boolean, matchIdentity: boolean): boolean {
  if (/\b(?:season(?:al)?|career) (?:statistics|stats|totals?|records?)\b/.test(label)) return true;
  if (!matchup && /\b(?:season(?:al)?|career)\b/.test(label) && !singleContestReference(label, matchIdentity)) return true;
  // A match heading cannot override the period of a later statistics question.
  return label.split(":").some(clause => {
    const wholePeriod = /\b(?:in|during|throughout|over|for) (?:the )?(?:calendar year )?20\d{2}\b/.test(clause)
      || /\b(?:(?:this|next|last|entire|full|whole|calendar) (?:year|season)|(?:during|throughout|over) (?:the )?(?:year|season))\b/.test(clause);
    const quantity = /\b(?:most|more|fewest|fewer|how many|number of|totals?)\b/.test(clause);
    return wholePeriod && quantity && !singleContestReference(clause, matchIdentity);
  });
}

function nonMatchReason(value: string, matchup = matchupTitle(value), matchIdentity = false): NonMatchReason | undefined {
  const label = value.toLowerCase().replace(/[-_–—]+/g, " ").replace(/\s+/g, " ");
  const contest = /\b(?:match|game|round|quarterfinal|semifinal|final|set)\b/.test(label);
  if (/\b(?:coupons?|parlay|accumulator)\b/.test(label)) return "coupon";
  // "Year-End Finals" names a competition; participant seed/rank labels there
  // are not a prediction. Other year-end targets in the same title still count.
  const rankingLabel = label.replace(/\byear end(?=\s+(?:(?:atp|wta|tour)\s+)?(?:finals?|championships?)\b)/g, "");
  const rank = /\b(?:ranked|no\.?\s*\d+|number\s+\d+|top\s*\d+)\b|#\d+\b/.test(rankingLabel);
  const yearEnd = /\byear end\b|\bend\s+(?:of\s+)?(?:20\d{2}|(?:the\s+)?year)\b/.test(rankingLabel);
  if (/\brankings?\b/.test(label)
    || (rank && yearEnd)) return "ranking";
  if (longTermStatistic(label, matchup, matchIdentity)) return "season-or-statistic";
  if (/\boutright\b/.test(label) || (!matchup && !contest
    && /\b(?:win|winner|winners|champion|champions)\b/.test(label)
    && /\b(?:tournament|championship|cup|league|open|wimbledon|roland garros|masters|finals)\b/.test(label))) return "tournament-outright";
  return undefined;
}

/** Classify scope only. This never manufactures a game ID or a finish clock. */
export function classifyMatchScope(event: CollectorEvent): MatchScope {
  const titleMatchup = matchupTitle(event.title);
  const participants = titleMatchup || participantPair(event.raw.participants) || participantPair(event.raw.teams)
    || event.markets.some(outcomeParticipants);
  const matchIdentity = event.gameId !== null || participants;
  const excluded = nonMatchReason(event.title, titleMatchup, matchIdentity) ?? nonMatchReason(event.eventSlug, titleMatchup, matchIdentity);
  if (excluded) return { kind: "non-match", reason: excluded };
  // A generic event title can still contain an entire tournament-winner slate.
  const marketReasons = event.markets.map(market => {
    const type = text(market.raw.sportsMarketType).toLowerCase();
    if (type === "season_winner") return "season-or-statistic" as const;
    if (["outright", "tournament_winner", "championship_winner", "futures"].includes(type)) return "tournament-outright" as const;
    return nonMatchReason(market.question, matchupTitle(market.question), matchIdentity);
  });
  if (marketReasons.length > 0 && marketReasons.every(reason => reason !== undefined)) {
    return { kind: "non-match", reason: marketReasons[0]! };
  }
  if (event.gameId !== null) return { kind: "single-match", reason: "game-id" };

  if (!participants) return { kind: "ambiguous", reason: "missing-participants" };
  const sportsMarket = event.markets.some(market => text(market.raw.sportsMarketType) !== "");
  // Gamma startDate/endDate are metadata dates, not scheduled match clocks.
  const scheduled = [event.raw.startTime, ...event.markets.map(market => market.raw.gameStartTime)]
    .some(value => typeof value === "string" && Number.isFinite(Date.parse(value)));
  if (!sportsMarket && !scheduled) return { kind: "ambiguous", reason: "missing-match-evidence" };
  return { kind: "single-match", reason: "participants-and-match-evidence" };
}
