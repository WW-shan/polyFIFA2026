import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  SCORES365_TIMEZONE, TennisPointsPoller, isLiveTennisFrame, liveTennisGamesFromAllScores,
  matchTennisFrameToTitle, normalizeTennisPointFrame, parseTennisSetStages, tennisAllScoresUrl,
  tennisDateParam, tennisEntrySignal, tennisGameUrl, type TennisPointFrame
} from "../../src/collector/tennis-points.js";

const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/scores365-tennis-game.json"), "utf8")) as unknown;
const observedAtMs = Date.parse("2026-10-02T05:57:00.000+08:00");

function frame(overrides: Partial<TennisPointFrame> = {}): TennisPointFrame {
  return {
    observedAtMs, scores365GameId: 1, startTime: null, statusText: "Set 2", statusGroup: 3,
    competition: null, homeName: "Favorite Player", awayName: "Underdog Player",
    setsWon: { home: 1, away: 0 }, setsToWin: 2,
    sets: [
      { name: "Set 1", shortName: "S1", home: 6, away: 2, ended: true, live: false },
      { name: "Set 2", shortName: "S2", home: 5, away: 4, ended: false, live: true }
    ],
    game: { serving: "home", home: "15", away: "30", tiebreak: false, breakPoint: false, setPoint: false, matchPoint: false, points: [] },
    ...overrides
  };
}

describe("365Scores tennis point frames", () => {
  test("normalizes the recorded live game document", () => {
    const value = normalizeTennisPointFrame(fixture, observedAtMs)!;
    expect(value).not.toBeNull();
    expect(value.scores365GameId).toBe(4867638);
    expect(value.homeName).toBe("Guido Ivan Justo");
    expect(value.awayName).toBe("Pedro Sakamoto");
    expect(value.statusGroup).toBe(3);
    expect(isLiveTennisFrame(value)).toBe(true);
    expect(value.setsWon).toEqual({ home: 1, away: 0 });
    expect(value.setsToWin).toBe(2);
    expect(value.sets.map(set => [set.name, set.home, set.away, set.ended, set.live])).toEqual([
      ["Set 1", 6, 2, true, false],
      ["Set 2", 5, 4, false, true]
    ]);
    expect(value.game).toMatchObject({
      serving: "home", home: "15", away: "15", tiebreak: false, breakPoint: false
    });
    expect(value.game!.points).toEqual([
      { winner: "home", home: 15, away: 0, important: 0 },
      { winner: "away", home: 15, away: 15, important: 0 }
    ]);
  });

  test("normalizes a perfect service game into set and match points", () => {
    const raw = structuredClone(fixture) as { game: { stages: Array<Record<string, unknown>>; currentPointByPointGame: { servingCompetitorId: number } } };
    const sets = raw.game.stages.find(stage => stage.name === "Set 2")!;
    sets.homeCompetitorScore = 5; sets.awayCompetitorScore = 4;
    const game = raw.game.stages.find(stage => stage.name === "Game")!;
    game.homeCompetitorScore = 40; game.awayCompetitorScore = 0;
    raw.game.currentPointByPointGame.servingCompetitorId = 69017;
    const value = normalizeTennisPointFrame(raw, observedAtMs)!;
    expect(value.game).toMatchObject({ home: "40", away: "0", serving: "home", setPoint: true, matchPoint: true, breakPoint: false });
  });

  test("keeps tiebreak counters raw and refuses a regular-game entry", () => {
    const raw = structuredClone(fixture) as { game: { stages: Array<Record<string, unknown>>; currentPointByPointGame: { servingCompetitorId: number } } };
    const set = raw.game.stages.find(stage => stage.name === "Set 2")!;
    set.homeCompetitorScore = 6; set.awayCompetitorScore = 6;
    const game = raw.game.stages.find(stage => stage.name === "Game")!;
    game.homeCompetitorScore = 3; game.awayCompetitorScore = 5;
    raw.game.currentPointByPointGame.servingCompetitorId = 69017;
    const value = normalizeTennisPointFrame(raw, observedAtMs)!;
    expect(value.game).toMatchObject({ home: "3", away: "5", tiebreak: true, breakPoint: false });
    const signal = tennisEntrySignal(value)!;
    expect(signal.tiebreak).toBe(true);
    expect(signal.lateSet).toBe(true);
    expect(signal.regularGame).toBe(false);
    expect(signal.candidate).toBe(false);
  });

  test("flags the regular-game point loss as the entry candidate", () => {
    const signal = tennisEntrySignal(frame())!;
    expect(signal.favored).toBe("home");
    expect(signal.oneSetFromMatch).toBe(true);
    expect(signal.lateSet).toBe(true);
    expect(signal.regularGame).toBe(true);
    expect(signal.favoriteServing).toBe(true);
    expect(signal.serverLostPoints).toBe(2);
    expect(signal.candidate).toBe(true);
  });

  test("does not fire before the favourite loses a service point", () => {
    const signal = tennisEntrySignal(frame({ game: { serving: "home", home: "40", away: "0", tiebreak: false, breakPoint: false, setPoint: true, matchPoint: true, points: [] } }))!;
    expect(signal.serverLostPoints).toBe(0);
    expect(signal.candidate).toBe(false);
  });

  test("does not fire when the favourite is receiving", () => {
    const signal = tennisEntrySignal(frame({ game: { serving: "away", home: "30", away: "15", tiebreak: false, breakPoint: false, setPoint: false, matchPoint: false, points: [] } }))!;
    expect(signal.favoriteServing).toBe(false);
    expect(signal.candidate).toBe(false);
  });

  test("parses set stages and knows the draw length", () => {
    const stages = (fixture as { game: { stages: unknown[] } }).game.stages;
    expect(parseTennisSetStages(stages)).toMatchObject({ setsWon: { home: 1, away: 0 }, setsToWin: 2 });
  });

  test("matches Polymarket titles in either order and rejects doubles", () => {
    const value = normalizeTennisPointFrame(fixture, observedAtMs)!;
    expect(matchTennisFrameToTitle(value, "Pedro Sakamoto vs Guido Ivan Justo")).toBe(true);
    expect(matchTennisFrameToTitle(value, "Guido Ivan Justo vs Pedro Sakamoto")).toBe(true);
    expect(matchTennisFrameToTitle(value, "Mackinlay J./Okonkwo O. vs Rybakov A./Smith K.")).toBe(false);
    expect(matchTennisFrameToTitle(value, "Somebody Else vs Pedro Sakamoto")).toBe(false);
  });

  test("matches swapped given/family names and shortened names", () => {
    expect(matchTennisFrameToTitle({ homeName: "Bu Yunchaokete", awayName: "Novak Djokovic" },
      "China Open: Yunchaokete Bu vs Novak Djokovic")).toBe(true);
    expect(matchTennisFrameToTitle({ homeName: "Matheus Almeida", awayName: "Tomas Barrios Vera" },
      "Curitiba: Matheus Pucinelli de Almeida vs Tomas Barrios")).toBe(true);
    expect(matchTennisFrameToTitle({ homeName: "Sascha Gueymard Wayenburg", awayName: "Clement Tabur" },
      "Mouilleron-Le-Captif: Clement Tabur vs Sascha Gueymard-Wayenburg")).toBe(true);
    expect(matchTennisFrameToTitle({ homeName: "Mackinlay J.", awayName: "Okonkwo O." },
      "Mackinlay vs Okonkwo")).toBe(false);
    expect(matchTennisFrameToTitle({ homeName: "Novak Djokovic", awayName: "Carlos Alcaraz" },
      "Novak Djokovic vs Carlos Alcaraz")).toBe(true);
  });

  test("builds the public URLs and date parameters", () => {
    expect(tennisDateParam(Date.parse("2026-10-01T18:00:00.000Z"))).toBe("02/10/2026");
    expect(tennisGameUrl(4867638)).toContain("gameId=4867638");
    expect(tennisGameUrl(4867638)).toContain(encodeURIComponent(SCORES365_TIMEZONE));
    expect(tennisAllScoresUrl("01/10/2026", "03/10/2026")).toContain("startDate=01%2F10%2F2026");
  });

  test("reads live games out of an allscores listing", () => {
    const live = liveTennisGamesFromAllScores({ games: [
      { id: 1, statusGroup: 3, homeCompetitor: { name: "A" }, awayCompetitor: { name: "B" }, startTime: "t" },
      { id: 2, statusGroup: 4, homeCompetitor: { name: "C" }, awayCompetitor: { name: "D" } }
    ] });
    expect(live).toEqual([{ scores365GameId: 1, homeName: "A", awayName: "B", startTime: "t", competition: null }]);
  });
});

describe("TennisPointsPoller", () => {
  const listing = { games: [
    { id: 4867638, statusGroup: 3, homeCompetitor: { name: "Guido Ivan Justo" }, awayCompetitor: { name: "Pedro Sakamoto" } },
    { id: 999, statusGroup: 3, homeCompetitor: { name: "A./B." }, awayCompetitor: { name: "C./D." } }
  ] };

  test("polls only matched live games and deduplicates unchanged frames", async () => {
    let nowMs = observedAtMs;
    const urls: string[] = [];
    const request: (url: string) => Promise<unknown> = (url) => {
      urls.push(url);
      return Promise.resolve(url.includes("/allscores/") ? listing : fixture);
    };
    const poller = new TennisPointsPoller({ request, now: () => nowMs, heartbeatMs: 60_000, listRefreshMs: 600_000 });
    const targets = [{ eventSlug: "atp-justo-sakamoto", title: "Guido Ivan Justo vs Pedro Sakamoto" }];
    const first = await poller.poll(targets);
    expect(first).toHaveLength(1);
    expect(first[0]!.eventSlug).toBe("atp-justo-sakamoto");
    expect(first[0]!.frame.game?.home).toBe("15");
    expect(urls.filter(url => url.includes("/web/game/"))).toHaveLength(1);

    const second = await poller.poll(targets);
    expect(second).toHaveLength(0);

    nowMs += 61_000;
    const third = await poller.poll(targets);
    expect(third).toHaveLength(1);
    expect(urls.filter(url => url.includes("/allscores/"))).toHaveLength(1);
  });

  test("skips targets that never matched a live 365Scores game", async () => {
    const request: (url: string) => Promise<unknown> = (url) => Promise.resolve(url.includes("/allscores/") ? listing : fixture);
    const poller = new TennisPointsPoller({ request, now: () => observedAtMs });
    const results = await poller.poll([{ eventSlug: "nobody", title: "Nobody Here vs Someone Else" }]);
    expect(results).toEqual([]);
  });
});
