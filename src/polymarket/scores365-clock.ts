import type { MatchState } from "../domain/types.js";
import { fetchJson, type HttpOptions } from "./http.js";

export const SCORES365_REMAINING_SECONDS_SOURCE = "365scores_added_time_precise_game_time" as const;

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const GOAL_SIGNAL_HTTP_TIMEOUT_MS = 700;
const GOAL_SIGNAL_PBP_TIMEOUT_MS = 350;
const GOAL_INCIDENT_MAX_LOOKBACK_MINUTES = 2;
const SCORES365_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Origin": "https://www.365scores.com",
  "Referer": "https://www.365scores.com/"
};

export interface Scores365ClockOptions extends HttpOptions {
  timezoneName?: string;
}

export interface Scores365ClockPatch extends Partial<MatchState> {
  remainingSeconds: number;
  remainingSecondsSource: typeof SCORES365_REMAINING_SECONDS_SOURCE;
  scores365GameId: number;
}

export interface Scores365ScorePatch extends Partial<MatchState> {
  homeGoals: number;
  awayGoals: number;
  scores365GameId: number;
}

export interface Scores365GoalSignal extends Scores365ScorePatch {
  scoreMatchesSports: boolean;
  hasMatchingGoal: boolean;
  hasNoGoalSignal: boolean;
  hasVarReviewSignal: boolean;
  hasPostRegulationGoalSignal?: boolean;
  details: string[];
}

export function extract365ScoresClock(raw: unknown, match: MatchState): Scores365ClockPatch | null {
  const game = unwrapGame(raw);
  if (!game) return null;

  if (!gameTeamsMatch(game, match)) return null;

  if (!isRegulationSecondHalfClock(game, match)) return null;

  const addedTime = numberValue(game.addedTime);
  const precise = isRecord(game.preciseGameTime) ? game.preciseGameTime : null;
  const minutes = numberValue(precise?.minutes);
  const seconds = numberValue(precise?.seconds);
  if (addedTime === undefined || minutes === undefined || seconds === undefined) return null;
  if ([addedTime, minutes, seconds].some((value) => !Number.isSafeInteger(value) || value < 0) || seconds >= 60) return null;
  if (precise?.autoProgress !== true || precise.clockDirection !== 1) return null;

  const elapsedSeconds = minutes * 60 + seconds;
  const expectedEndSeconds = (90 + addedTime) * 60;
  if (!Number.isSafeInteger(elapsedSeconds) || !Number.isSafeInteger(expectedEndSeconds)) return null;
  const remainingSeconds = Math.max(0, expectedEndSeconds - elapsedSeconds);
  const patch: Scores365ClockPatch = {
    remainingSeconds,
    remainingSecondsSource: SCORES365_REMAINING_SECONDS_SOURCE,
    elapsedSeconds,
    minute: minutes,
    scores365GameId: numberValue(game.id) ?? match.scores365GameId ?? 0
  };
  if (patch.scores365GameId <= 0) return null;
  return patch;
}

function isRegulationSecondHalfClock(game: Record<string, unknown>, match: MatchState): boolean {
  if (match.period !== "2H" || !match.isLive) return false;
  const phases = [game.statusText, game.shortStatusText, game.period, game.periodName, game.gameTimeDisplay]
    .map((value) => stringValue(value).trim().toLowerCase().replace(/[-_]/g, " "));
  const nonRegulation = /\b(?:extra(?:\s*time)?|overtime|aet|et|ot|ft|full\s*time|ended|finished|penalties|shootout|1h|ht|half\s*time|(?:1st|first)\s+half)\b/;
  if (phases.some((phase) => nonRegulation.test(phase))) return false;
  const display = stringValue(game.gameTimeDisplay).trim();
  const addedTimeDisplay = display.match(/^(\d+)\s*\+\s*\d+['’]?$/);
  if (addedTimeDisplay && addedTimeDisplay[1] !== "90") return false;
  return phases.some((phase) => /^(?:2h|(?:2nd|second)\s+half)$/.test(phase)) || addedTimeDisplay?.[1] === "90";
}

export function extract365ScoresScorePatch(raw: unknown, match: MatchState): Scores365ScorePatch | null {
  const game = unwrapGame(raw);
  if (!game) return null;
  if (!gameTeamsMatch(game, match)) return null;

  const homeCompetitor = isRecord(game.homeCompetitor) ? game.homeCompetitor : null;
  const awayCompetitor = isRecord(game.awayCompetitor) ? game.awayCompetitor : null;
  const homeGoals = numberValue(homeCompetitor?.score);
  const awayGoals = numberValue(awayCompetitor?.score);
  const scores365GameId = numberValue(game.id) ?? match.scores365GameId ?? 0;
  if (homeGoals === undefined || awayGoals === undefined || scores365GameId <= 0) return null;
  if (homeGoals < 0 || awayGoals < 0) return null;

  return {
    homeGoals: Math.trunc(homeGoals),
    awayGoals: Math.trunc(awayGoals),
    scores365GameId
  };
}

export function extract365ScoresGoalSignal(raw: unknown, match: MatchState, previousMatch?: MatchState): Scores365GoalSignal | null {
  const game = unwrapGame(raw);
  if (!game) return null;
  if (!gameTeamsMatch(game, match)) return null;

  const scorePatch = extract365ScoresScorePatch(game, match);
  if (!scorePatch) return null;

  const details: string[] = [];
  const homeCompetitor = isRecord(game.homeCompetitor) ? game.homeCompetitor : null;
  const awayCompetitor = isRecord(game.awayCompetitor) ? game.awayCompetitor : null;
  const previous = previousMatch?.eventSlug === match.eventSlug
    && normalizeTeam(previousMatch.homeTeam) === normalizeTeam(match.homeTeam)
    && normalizeTeam(previousMatch.awayTeam) === normalizeTeam(match.awayTeam) ? previousMatch : undefined;
  const expectedCompetitors = expectedScoringCompetitorIds(match, previous, homeCompetitor, awayCompetitor);
  const playByPlay = playByPlaySource(raw, game);
  const incident = goalIncidentContext(game.events, playByPlay, match, previous, expectedCompetitors);
  const eventSignals = inspect365Events(game.events, incident, game);
  const pbpSignals = inspect365PlayByPlay(playByPlay, incident);
  details.push(...eventSignals.details, ...pbpSignals.details);

  const hasNoGoalSignal = eventSignals.hasNoGoalSignal || pbpSignals.hasNoGoalSignal;
  const hasVarReviewSignal = !hasNoGoalSignal && (eventSignals.hasVarReviewSignal || pbpSignals.hasVarReviewSignal);
  const hasMatchingGoal = !hasNoGoalSignal && (eventSignals.hasMatchingGoal || pbpSignals.hasMatchingGoal);
  const hasPostRegulationGoalSignal = eventSignals.hasPostRegulationGoalSignal || pbpSignals.hasPostRegulationGoalSignal;

  return {
    ...scorePatch,
    scoreMatchesSports: scorePatch.homeGoals === match.homeGoals && scorePatch.awayGoals === match.awayGoals,
    hasMatchingGoal,
    hasNoGoalSignal,
    hasVarReviewSignal,
    hasPostRegulationGoalSignal,
    details: details.length > 0 ? details : ["365 goal signal contained score only"]
  };
}

export function find365ScoresGameForMatch(raw: unknown, match: MatchState): Record<string, unknown> | null {
  const games = isRecord(raw) && Array.isArray(raw.games) ? raw.games : [];
  const normalizedHome = normalizeTeam(match.homeTeam);
  const normalizedAway = normalizeTeam(match.awayTeam);

  for (const item of games) {
    if (!isRecord(item)) continue;
    const home = isRecord(item.homeCompetitor) ? stringValue(item.homeCompetitor.name) : "";
    const away = isRecord(item.awayCompetitor) ? stringValue(item.awayCompetitor.name) : "";
    if (normalizeTeam(home) === normalizedHome && normalizeTeam(away) === normalizedAway) return item;
  }

  return null;
}

export class Scores365ClockProvider {
  private readonly gameIdByEventSlug = new Map<string, number>();

  constructor(private readonly options: Scores365ClockOptions = {}) {}

  async fetchClock(match: MatchState): Promise<Scores365ClockPatch | null> {
    const gameId = match.scores365GameId ?? this.gameIdByEventSlug.get(match.eventSlug) ?? await this.discoverGameId(match);
    if (gameId === undefined) return null;
    this.gameIdByEventSlug.set(match.eventSlug, gameId);
    const raw = await fetchJson<unknown>(this.gameUrl(gameId), this.httpOptions());
    return extract365ScoresClock(raw, { ...match, scores365GameId: gameId });
  }

  async fetchScore(match: MatchState): Promise<Scores365ScorePatch | null> {
    const cachedGameId = match.scores365GameId ?? this.gameIdByEventSlug.get(match.eventSlug);
    let discoveredGameId: number | undefined;
    if (cachedGameId === undefined) {
      const raw = await fetchJson<unknown>(this.allscoresUrl(match), this.httpOptions());
      const game = find365ScoresGameForMatch(raw, match);
      discoveredGameId = game ? numberValue(game.id) : undefined;
      const scorePatch = game ? extract365ScoresScorePatch(game, match) : null;
      if (discoveredGameId !== undefined) this.gameIdByEventSlug.set(match.eventSlug, discoveredGameId);
      if (scorePatch) return scorePatch;
    }

    const gameId = cachedGameId ?? discoveredGameId ?? await this.discoverGameId(match);
    if (gameId === undefined) return null;
    this.gameIdByEventSlug.set(match.eventSlug, gameId);
    const raw = await fetchJson<unknown>(this.gameUrl(gameId), this.httpOptions());
    return extract365ScoresScorePatch(raw, { ...match, scores365GameId: gameId });
  }

  async fetchGoalSignal(match: MatchState, previousMatch?: MatchState): Promise<Scores365GoalSignal | null> {
    const gameId = match.scores365GameId ?? this.gameIdByEventSlug.get(match.eventSlug) ?? await this.discoverGameId(match);
    if (gameId === undefined) return null;
    this.gameIdByEventSlug.set(match.eventSlug, gameId);

    const raw = await fetchJson<unknown>(this.gameUrl(gameId), this.httpOptions(GOAL_SIGNAL_HTTP_TIMEOUT_MS));
    const game = unwrapGame(raw);
    const feedUrl = game ? playByPlayFeedUrl(game) : undefined;
    const playByPlay = feedUrl ? await fetchJson<unknown>(feedUrl, this.httpOptions(GOAL_SIGNAL_PBP_TIMEOUT_MS)).catch(() => null) : null;
    return extract365ScoresGoalSignal(playByPlay ? { game: game ?? raw, playByPlay } : raw, { ...match, scores365GameId: gameId }, previousMatch);
  }

  private async discoverGameId(match: MatchState): Promise<number | undefined> {
    const raw = await fetchJson<unknown>(this.allscoresUrl(match), this.httpOptions());
    const game = find365ScoresGameForMatch(raw, match);
    return game ? numberValue(game.id) : undefined;
  }

  private allscoresUrl(match: MatchState): string {
    const { startDate, endDate } = dateRangeForMatch(match.startTime, this.options.timezoneName ?? DEFAULT_TIMEZONE);
    const params = new URLSearchParams({
      appTypeId: "5",
      langId: "1",
      timezoneName: this.options.timezoneName ?? DEFAULT_TIMEZONE,
      userCountryId: "2",
      sports: "1",
      startDate,
      endDate
    });
    return `https://webws.365scores.com/web/games/allscores/?${params.toString()}`;
  }

  private gameUrl(gameId: number): string {
    const params = new URLSearchParams({
      appTypeId: "5",
      langId: "1",
      timezoneName: this.options.timezoneName ?? DEFAULT_TIMEZONE,
      userCountryId: "2",
      gameId: String(gameId)
    });
    return `https://webws.365scores.com/web/game/?${params.toString()}`;
  }

  private httpOptions(timeoutMs?: number): HttpOptions {
    const options: HttpOptions = {
      ...this.options,
      headers: {
        ...SCORES365_HEADERS,
        ...this.options.headers
      }
    };
    if (timeoutMs !== undefined) options.timeoutMs = Math.min(this.options.timeoutMs ?? timeoutMs, timeoutMs);
    return options;
  }
}

interface GoalTextSignals {
  hasMatchingGoal: boolean;
  hasNoGoalSignal: boolean;
  hasVarReviewSignal: boolean;
  hasPostRegulationGoalSignal: boolean;
  details: string[];
}

function inspect365Events(events: unknown, incident: GoalIncidentContext, game: Record<string, unknown>): GoalTextSignals {
  const signals: GoalTextSignals = {
    hasMatchingGoal: false,
    hasNoGoalSignal: false,
    hasVarReviewSignal: false,
    hasPostRegulationGoalSignal: false,
    details: []
  };
  if (!Array.isArray(events)) return signals;

  for (const item of events) {
    if (!isRecord(item)) continue;
    if (isHistoricalGoalSignal(item, incident)) continue;
    const eventType = isRecord(item.eventType) ? item.eventType : {};
    const eventTypeId = numberValue(eventType.id);
    const text = [
      stringValue(eventType.name),
      stringValue(eventType.subTypeName),
      stringValue(item.name),
      stringValue(item.description)
    ].join(" ");
    const normalized = text.toLowerCase();
    if (isNoGoalText(normalized) || eventTypeId === 11) {
      signals.hasNoGoalSignal = true;
      signals.details.push(`365 event no goal/disallowed: ${compactText(text)}`);
      continue;
    }
    if (normalized.includes("var")) {
      signals.hasVarReviewSignal = true;
      signals.details.push(`365 event VAR signal: ${compactText(text)}`);
    }
    if (eventTypeId === 1 && incident.currentGoals.has(item)) {
      signals.hasMatchingGoal = true;
      signals.details.push(`365 event normal goal: ${compactText(text)}`);
      if (isPostRegulation365GoalEvent(item, game)) {
        signals.hasPostRegulationGoalSignal = true;
        const gameTime = numberValue(item.gameTime);
        const addedTime = numberValue(item.addedTime);
        const displayTime = gameTime !== undefined && addedTime && addedTime > 0 ? `${gameTime}+${addedTime}` : String(gameTime ?? "");
        signals.details.push(`365 event post-regulation goal at ${displayTime}`);
      }
    }
  }
  return signals;
}

function isPostRegulation365GoalEvent(item: Record<string, unknown>, game: Record<string, unknown>): boolean {
  const gameTime = numberValue(item.gameTime);
  if (gameTime !== undefined && gameTime > 105) return true;
  const text = [
    stringValue(item.periodName),
    stringValue(item.period),
    stringValue(item.statusText),
    stringValue(item.shortStatusText),
    stringValue(item.gameTimeDisplay),
    stringValue(game.periodName),
    stringValue(game.period),
    stringValue(game.statusText),
    stringValue(game.shortStatusText),
    stringValue(game.gameTimeDisplay)
  ].join(" ").toLowerCase();
  return /\b(extra time|overtime|after extra time|aet|1st extra|2nd extra)\b/.test(text);
}

function inspect365PlayByPlay(playByPlay: unknown, incident: GoalIncidentContext): GoalTextSignals {
  const signals: GoalTextSignals = {
    hasMatchingGoal: false,
    hasNoGoalSignal: false,
    hasVarReviewSignal: false,
    hasPostRegulationGoalSignal: false,
    details: []
  };
  for (const message of playByPlayMessages(playByPlay)) {
    if (isHistoricalGoalSignal(message, incident)) continue;
    const text = recordText(message).toLowerCase();
    if (!text) continue;
    if (isNoGoalText(text)) {
      signals.hasNoGoalSignal = true;
      signals.details.push(`365 PBP no goal: ${compactText(recordText(message))}`);
      continue;
    }
    if (text.includes("var")) {
      signals.hasVarReviewSignal = true;
      signals.details.push(`365 PBP VAR signal: ${compactText(recordText(message))}`);
    }
    if (isNormalGoalText(text) && incident.currentGoals.has(message)) {
      signals.hasMatchingGoal = true;
      signals.details.push(`365 PBP normal goal: ${compactText(recordText(message))}`);
    }
  }
  return signals;
}

interface GoalIncidentContext {
  match: MatchState;
  earliestMinute: number | undefined;
  currentGoals: Set<Record<string, unknown>>;
  goalIdentityById: Map<string, "current" | "historical" | "unknown">;
}

function goalIncidentContext(
  events: unknown,
  playByPlay: unknown,
  match: MatchState,
  previousMatch: MatchState | undefined,
  expectedCompetitors: Set<number>
): GoalIncidentContext {
  const currentMinute = Number.isFinite(match.minute) && match.minute >= 0 ? match.minute : undefined;
  const previousMinute = previousMatch && Number.isFinite(previousMatch.minute) && previousMatch.minute >= 0
    ? previousMatch.minute : undefined;
  // Allow minute rounding across recent snapshots without reopening the entire history after a gap.
  const earliestMinute = currentMinute === undefined ? undefined : Math.max(
    0, currentMinute - GOAL_INCIDENT_MAX_LOOKBACK_MINUTES, Math.min(currentMinute, previousMinute ?? currentMinute) - 1
  );
  const goalRecords = [
    ...(Array.isArray(events) ? events.filter(isRecord).filter((item) =>
      isRecord(item.eventType) && numberValue(item.eventType.id) === 1
      && !isNoGoalText(`${recordText(item.eventType)} ${recordText(item)}`)) : []),
    ...playByPlayMessages(playByPlay).filter((item) => isNormalGoalText(recordText(item)))
  ];
  const evidence = goalRecords.map((record) => ({
    record,
    minute: goalSignalMinute(record, match),
    competitorId: numberValue(record.competitorId ?? record.CompetitorId ?? record.teamId ?? record.TeamId),
    scoreMatches: scoreTextMatchesIncident(recordText(record), match),
    contributes: previousMatch ? scoreTextWithinTransition(recordText(record), previousMatch, match) : scoreTextMatchesIncident(recordText(record), match)
  }));
  const scoreIncreased = previousMatch ? goalsTotal(match) > goalsTotal(previousMatch) : goalsTotal(match) > 0;
  const candidates = evidence.filter((goal) => {
    if (!scoreIncreased || goal.contributes === false) return false;
    if (expectedCompetitors.size > 0) {
      if (goal.competitorId !== undefined && !expectedCompetitors.has(goal.competitorId)) return false;
      if (goal.competitorId === undefined && goal.contributes !== true) return false;
    }
    if (goal.minute === undefined) return goal.contributes === true;
    // A known score transition identifies its goal after the previous snapshot, however long
    // the review lasts. Without that snapshot, require a current score or recent timestamp.
    if (previousMinute !== undefined) return goal.minute >= previousMinute - 1;
    return goal.scoreMatches === true || (earliestMinute !== undefined && goal.minute >= earliestMinute);
  });
  const candidateMinutes = candidates.map((goal) => goal.minute).filter((minute): minute is number => minute !== undefined);
  const latestGoalMinute = candidateMinutes.length > 0 ? Math.max(...candidateMinutes) : undefined;
  const currentGoals = new Set(candidates
    // Every goal introduced since the prior score contributes to this transition.
    // Selecting only the latest would hide cancellation of an earlier new goal.
    .filter((goal) => previousMatch !== undefined || goal.minute === undefined || goal.minute === latestGoalMinute)
    .map((goal) => goal.record));
  const currentGoalIds = new Set([...currentGoals].flatMap(goalSignalIds));
  const goalIdentityById: GoalIncidentContext["goalIdentityById"] = new Map();
  for (const goal of evidence) {
    // Clock age alone cannot make a referenced goal historical. A newer matching goal or a
    // prior score snapshot must establish that it belongs to a different incident.
    const historical = goal.minute !== undefined && (
      (latestGoalMinute !== undefined && goal.minute < latestGoalMinute)
      || (previousMinute !== undefined && goal.minute < previousMinute - 1 && goal.scoreMatches !== true)
    );
    for (const id of goalSignalIds(goal.record)) {
      if (currentGoalIds.has(id)) goalIdentityById.set(id, "current");
      else goalIdentityById.set(id, historical && goalIdentityById.get(id) !== "unknown" ? "historical" : "unknown");
    }
  }
  return {
    match,
    earliestMinute,
    currentGoals,
    goalIdentityById
  };
}

function isHistoricalGoalSignal(item: Record<string, unknown>, incident: GoalIncidentContext): boolean {
  if (incident.currentGoals.has(item)) return false;
  const references = [
    item.relatedEventId, item.RelatedEventId, item.relatedGoalId, item.RelatedGoalId,
    item.goalEventId, item.GoalEventId, item.originalEventId, item.OriginalEventId,
    item.goalId, item.GoalId
  ].map(signalIdentifier).filter((id): id is string => id !== undefined);
  references.push(...goalSignalIds(item).filter((id) => incident.goalIdentityById.has(id)));
  if (references.length > 0) {
    // Unknown or conflicting references remain blocking, even with an apparently old timestamp.
    return references.every((id) => incident.goalIdentityById.get(id) === "historical");
  }
  const minute = goalSignalMinute(item, incident.match);
  if (minute !== undefined) {
    const side = numberValue(item.competitorId ?? item.CompetitorId ?? item.teamId ?? item.TeamId);
    for (const goal of incident.currentGoals) {
      const goalMinute = goalSignalMinute(goal, incident.match);
      const goalSide = numberValue(goal.competitorId ?? goal.CompetitorId ?? goal.teamId ?? goal.TeamId);
      // Without a reference, a same-side (or unknown-side) review at or after a
      // contributing goal is not proven historical just because a feed was late.
      if (goalMinute !== undefined && minute >= goalMinute - 1
        && (side === undefined || goalSide === undefined || side === goalSide)) return false;
    }
  }
  return minute !== undefined && incident.earliestMinute !== undefined && minute < incident.earliestMinute;
}

interface GoalSignalTime {
  minute: number;
  stoppageBase: number | undefined;
}

function goalSignalMinute(item: Record<string, unknown>, match: MatchState): number | undefined {
  const addedValues = [item.addedTime, item.AddedTime].filter(hasGoalTimeValue).map(numberValue);
  if (addedValues.some((value) => value === undefined || !Number.isSafeInteger(value) || value < 0)) return undefined;
  if (new Set(addedValues).size > 1) return undefined;
  const added = addedValues[0];
  const times: GoalSignalTime[] = [];
  const values = [item.gameTime, item.GameTime, item.minute, item.Minute, item.gameTimeDisplay, item.GameTimeDisplay];
  for (const value of values.filter(hasGoalTimeValue)) {
    const time = parseGoalSignalTime(value);
    if (!time) return undefined;
    if (time.stoppageBase !== undefined && added !== undefined && Math.floor(time.minute - time.stoppageBase) !== added) return undefined;
    if (time.stoppageBase === undefined && [45, 90, 105, 120].includes(time.minute) && added !== undefined) {
      times.push({ minute: time.minute + added, stoppageBase: time.minute });
    } else {
      times.push(time);
    }
  }
  if (times.length === 0) return undefined;

  const minutes = new Set<number>();
  for (const time of times) {
    // A bare base minute (90) and its expanded display (90+4) describe the same timestamp.
    const expanded = time.stoppageBase === undefined ? times.filter((other) => other.stoppageBase === time.minute) : [];
    if (expanded.length > 0) {
      for (const other of expanded) minutes.add(other.minute);
    } else {
      minutes.add(time.minute);
    }
  }
  if (minutes.size !== 1) return undefined;
  const minute = [...minutes][0];
  // During second-half stoppage time, an unqualified 90 may omit the added minutes.
  if (minute === 90 && match.period === "2H" && match.minute > 90 && times.every((time) => time.stoppageBase === undefined)) return undefined;
  return minute;
}

function hasGoalTimeValue(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0);
}

function parseGoalSignalTime(value: unknown): GoalSignalTime | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined) return numeric >= 0 ? { minute: numeric, stoppageBase: undefined } : undefined;
  if (typeof value !== "string") return undefined;
  const display = value.trim().match(/^(\d+)(?:\s*\+\s*(\d+))?(?::([0-5]\d))?['’]?$/);
  if (!display?.[1]) return undefined;
  const base = Number(display[1]);
  const minute = base + Number(display[2] ?? 0) + Number(display[3] ?? 0) / 60;
  return Number.isFinite(minute) ? { minute, stoppageBase: display[2] === undefined ? undefined : base } : undefined;
}

function goalSignalIds(item: Record<string, unknown>): string[] {
  return [item.id, item.Id, item.ID, item.eventId, item.EventId, item.goalId, item.GoalId]
    .map(signalIdentifier).filter((id): id is string => id !== undefined);
}

function signalIdentifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function expectedScoringCompetitorIds(
  match: MatchState,
  previousMatch: MatchState | undefined,
  homeCompetitor: Record<string, unknown> | null,
  awayCompetitor: Record<string, unknown> | null
): Set<number> {
  const ids = new Set<number>();
  const homeId = numberValue(homeCompetitor?.id);
  const awayId = numberValue(awayCompetitor?.id);
  if (!previousMatch) {
    if (homeId !== undefined && match.homeGoals > 0) ids.add(homeId);
    if (awayId !== undefined && match.awayGoals > 0) ids.add(awayId);
    return ids;
  }
  if (homeId !== undefined && match.homeGoals > previousMatch.homeGoals) ids.add(homeId);
  if (awayId !== undefined && match.awayGoals > previousMatch.awayGoals) ids.add(awayId);
  return ids;
}

function playByPlaySource(raw: unknown, game: Record<string, unknown>): unknown {
  if (isRecord(raw) && raw.playByPlay !== undefined) return raw.playByPlay;
  return game.playByPlay;
}

function playByPlayFeedUrl(game: Record<string, unknown>): string | undefined {
  const playByPlay = isRecord(game.playByPlay) ? game.playByPlay : null;
  const feedUrl = stringValue(playByPlay?.feedURL ?? playByPlay?.feedUrl);
  return feedUrl || undefined;
}

function playByPlayMessages(playByPlay: unknown): Record<string, unknown>[] {
  if (!isRecord(playByPlay)) return [];
  const candidates = [
    playByPlay.Messages,
    playByPlay.messages,
    playByPlay.comments,
    playByPlay.Comments
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function recordText(record: Record<string, unknown>): string {
  const pieces: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && isTextKey(key)) pieces.push(value);
  }
  return pieces.join(" ");
}

function isTextKey(key: string): boolean {
  return /name|title|comment|description|text|type/i.test(key);
}

function isNoGoalText(text: string): boolean {
  return /goal\s+disallowed|disallowed\s+goal|no\s+goal|goal\s+overturned|overturned\s+by\s+var|cancel(?:led|ed)\s+goal|goal\s+cancel(?:led|ed)/i.test(text);
}

function isNormalGoalText(text: string): boolean {
  return /\bgoal\b/i.test(text) && !isNoGoalText(text);
}

function scoreTextMatchesIncident(text: string, match: MatchState): boolean | undefined {
  const scores = scorePairsInText(text, match);
  if (scores.length === 0) return undefined;
  return scores.every(([homeGoals, awayGoals]) => homeGoals === match.homeGoals && awayGoals === match.awayGoals);
}

function scoreTextWithinTransition(text: string, previous: MatchState, current: MatchState): boolean | undefined {
  const scores = scorePairsInText(text, current);
  if (scores.length === 0) return undefined;
  return scores.every(([home, away]) =>
    home >= previous.homeGoals && away >= previous.awayGoals
    && home <= current.homeGoals && away <= current.awayGoals
    && home + away > goalsTotal(previous)
  );
}

function scorePairsInText(text: string, match: MatchState): Array<[number, number]> {
  const scores: Array<[number, number]> = [];
  for (const score of text.matchAll(/\b(\d+)\s*[-:,]\s*(\d+)\b/g)) {
    scores.push([Number(score[1]), Number(score[2])]);
  }
  const home = teamScoreInText(text, match.homeTeam);
  const away = teamScoreInText(text, match.awayTeam);
  if (home !== undefined && away !== undefined) scores.push([home, away]);
  return scores;
}

function teamScoreInText(text: string, team: string): number | undefined {
  const normalizedTeam = normalizeTeam(team);
  const names = [normalizedTeam, ...Object.keys(TEAM_ALIASES).filter((alias) => TEAM_ALIASES[alias] === normalizedTeam)];
  const normalizedText = normalizeTeam(text);
  for (const name of names) {
    const score = normalizedText.match(new RegExp(`\\b${name}\\s+(\\d+)\\b`));
    if (score?.[1] !== undefined) return Number(score[1]);
  }
  return undefined;
}

function goalsTotal(match: Pick<MatchState, "homeGoals" | "awayGoals">): number {
  return match.homeGoals + match.awayGoals;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dateRangeForMatch(startTime: string | undefined, timezoneName: string): { startDate: string; endDate: string } {
  const base = startTime ? new Date(startTime) : new Date();
  const dates = [formatDate(base, "UTC"), formatDate(base, timezoneName)];
  const sorted = [...new Set(dates)].sort((a, b) => sortableDate(a).localeCompare(sortableDate(b)));
  return {
    startDate: sorted[0] ?? formatDate(base, timezoneName),
    endDate: sorted[sorted.length - 1] ?? formatDate(base, timezoneName)
  };
}

function formatDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  return `${day}/${month}/${year}`;
}

function sortableDate(value: string): string {
  const [day, month, year] = value.split("/");
  return `${year ?? ""}-${month ?? ""}-${day ?? ""}`;
}

function unwrapGame(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.game)) return raw.game;
  return raw;
}

function gameTeamsMatch(game: Record<string, unknown>, match: MatchState): boolean {
  const home = isRecord(game.homeCompetitor) ? stringValue(game.homeCompetitor.name) : "";
  const away = isRecord(game.awayCompetitor) ? stringValue(game.awayCompetitor.name) : "";
  if (!home || !away) return false;
  return normalizeTeam(home) === normalizeTeam(match.homeTeam)
    && normalizeTeam(away) === normalizeTeam(match.awayTeam);
}

function normalizeTeam(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((part) => part.length > 0 && part !== "and")
    .join(" ");
  return TEAM_ALIASES[normalized] ?? normalized;
}

const TEAM_ALIASES: Record<string, string> = {
  "cabo verde": "cape verde",
  "cote d ivoire": "ivory coast",
  "ir iran": "iran",
  "turkey": "turkiye",
  "united states": "usa"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}
