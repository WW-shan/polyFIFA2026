import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  SCORES365_TIMEZONE, TennisPointsPoller, isLiveTennisFrame, liveTennisGamesFromAllScores,
  matchTennisFrameToTitle, normalizeTennisPointFrame, parseTennisSetStages, tennisAllScoresUrl,
  tennisDateParam, tennisEntrySignal, tennisFrameSideForTitleOutcome, tennisFrameTitleOrientation,
  tennisGameUrl, tennisNamesMatch, type TennisPointFrame
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
    expect(signal.favoriteLeadsSet).toBe(false);
    expect(signal.candidate).toBe(false);
  });

  test("keeps extended tiebreak counters instead of collapsing 8-8 to 0-0", () => {
    const raw = structuredClone(fixture) as { game: { stages: Array<Record<string, unknown>>; currentPointByPointGame: { servingCompetitorId: number; points: unknown[] } } };
    const set = raw.game.stages.find(stage => stage.name === "Set 2")!;
    set.homeCompetitorScore = 6; set.awayCompetitorScore = 6;
    const game = raw.game.stages.find(stage => stage.name === "Game")!;
    game.homeCompetitorScore = 8; game.awayCompetitorScore = 8;
    raw.game.currentPointByPointGame.servingCompetitorId = 69017;
    raw.game.currentPointByPointGame.points = [];
    const value = normalizeTennisPointFrame(raw, observedAtMs)!;
    expect(value.game).toMatchObject({ home: "8", away: "8", tiebreak: true });
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

  test("uses the receiver score as a lower bound when 365 starts the point list at deuce", () => {
    const signal = tennisEntrySignal(frame({
      game: {
        serving: "home", home: "40", away: "40", tiebreak: false, breakPoint: false, setPoint: false, matchPoint: false,
        points: [{ winner: null, home: 40, away: 40, important: 0 }]
      }
    }))!;
    expect(signal.serverLostPoints).toBe(3);
    expect(signal.candidate).toBe(true);
  });

  test("does not fire when the favourite is trailing the live set", () => {
    const signal = tennisEntrySignal(frame({
      sets: [
        { name: "Set 1", shortName: "S1", home: 6, away: 2, ended: true, live: false },
        { name: "Set 2", shortName: "S2", home: 4, away: 5, ended: false, live: true }
      ],
      game: { serving: "home", home: "0", away: "15", tiebreak: false, breakPoint: false, setPoint: false, matchPoint: false, points: [] }
    }))!;
    expect(signal.lateSet).toBe(true);
    expect(signal.oneSetFromMatch).toBe(false);
    expect(signal.favoriteLeadsSet).toBe(false);
    expect(signal.candidate).toBe(false);
  });

  test("enters the deciding set when its leader is one game from the match", () => {
    const decider = (home: number, away: number) => frame({
      setsWon: { home: 1, away: 1 },
      statusText: "Set 3",
      sets: [
        { name: "Set 1", shortName: "S1", home: 6, away: 4, ended: true, live: false },
        { name: "Set 2", shortName: "S2", home: 3, away: 6, ended: true, live: false },
        { name: "Set 3", shortName: "S3", home, away, ended: false, live: true }
      ],
      game: { serving: "home", home: "30", away: "15", tiebreak: false, breakPoint: false, setPoint: false, matchPoint: false, points: [] }
    });
    const homeLeads = tennisEntrySignal(decider(5, 4))!;
    expect(homeLeads.favored).toBe("home");
    expect(homeLeads.oneSetFromMatch).toBe(true);
    expect(homeLeads.lateSet).toBe(true);
    expect(homeLeads.favoriteLeadsSet).toBe(true);

    const awayLeads = tennisEntrySignal(decider(4, 5))!;
    expect(awayLeads.favored).toBe("away");
    expect(awayLeads.oneSetFromMatch).toBe(true);
    expect(awayLeads.lateSet).toBe(true);
  });

  test("does not enter a tied 6-6 deciding tiebreak", () => {
    const signal = tennisEntrySignal(frame({
      setsWon: { home: 1, away: 1 },
      statusText: "Set 3",
      sets: [
        { name: "Set 1", shortName: "S1", home: 6, away: 4, ended: true, live: false },
        { name: "Set 2", shortName: "S2", home: 3, away: 6, ended: true, live: false },
        { name: "Set 3", shortName: "S3", home: 6, away: 6, ended: false, live: true }
      ],
      game: { serving: "home", home: "5", away: "4", tiebreak: true, breakPoint: false, setPoint: false, matchPoint: false, points: [] }
    }));
    expect(signal?.oneSetFromMatch ?? false).toBe(false);
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

  test("tolerates transliteration variants of one player", () => {
    // Live regression: Polymarket "Columbus: Abedallah Shelbayh vs Mitchell
    // Krueger" against the 365Scores spelling "Abdullah Shelbayh".
    expect(matchTennisFrameToTitle({ homeName: "Abdullah Shelbayh", awayName: "Mitchell Krueger" },
      "Columbus: Abedallah Shelbayh vs Mitchell Krueger")).toBe(true);
    expect(tennisFrameTitleOrientation({ homeName: "Abdullah Shelbayh", awayName: "Mitchell Krueger" },
      "Columbus: Abedallah Shelbayh vs Mitchell Krueger")).toBe("direct");
    expect(tennisNamesMatch("Nikoloz Basilashvili", "Nikolas Basilashvili")).toBe(true);
  });

  test("still rejects different players who share a surname or a given name", () => {
    expect(tennisNamesMatch("Mirra Andreeva", "Erika Andreeva")).toBe(false);
    expect(tennisNamesMatch("Alex Michelsen", "Alex Molcan")).toBe(false);
    expect(tennisNamesMatch("Alexander Zverev", "Mischa Zverev")).toBe(false);
    expect(matchTennisFrameToTitle({ homeName: "Mirra Andreeva", awayName: "Madison Keys" },
      "Erika Andreeva vs Madison Keys")).toBe(false);
    expect(matchTennisFrameToTitle({ homeName: "Alex Michelsen", awayName: "Alex Molcan" },
      "Alex Michelsen vs Alex Molcan")).toBe(true);
    expect(matchTennisFrameToTitle({ homeName: "Alex Michelsen", awayName: "Miomir Kecmanovic" },
      "Alex Molcan vs Miomir Kecmanovic")).toBe(false);
  });

  test("maps Polymarket outcome order to the 365Scores home/away coordinate", () => {
    const direct = { homeName: "Bu Yunchaokete", awayName: "Novak Djokovic" };
    expect(tennisFrameTitleOrientation(direct, "China Open: Yunchaokete Bu vs Novak Djokovic")).toBe("direct");
    expect(tennisFrameSideForTitleOutcome(direct, "China Open: Yunchaokete Bu vs Novak Djokovic", 0)).toBe("home");
    expect(tennisFrameSideForTitleOutcome(direct, "China Open: Yunchaokete Bu vs Novak Djokovic", 1)).toBe("away");

    const swapped = { homeName: "Sascha Gueymard Wayenburg", awayName: "Clement Tabur" };
    const title = "Mouilleron-Le-Captif: Clement Tabur vs Sascha Gueymard-Wayenburg";
    expect(tennisFrameTitleOrientation(swapped, title)).toBe("swapped");
    expect(tennisFrameSideForTitleOutcome(swapped, title, 0)).toBe("away");
    expect(tennisFrameSideForTitleOutcome(swapped, title, 1)).toBe("home");
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

  test("rotates the per-poll game cap so later live games are still polled", async () => {
    let nowMs = observedAtMs;
    const docs = new Map<number, unknown>();
    const liveGames = [1, 2, 3].map(index => {
      const id = 7000 + index;
      const home = `Player ${index} Home`;
      const away = `Player ${index} Away`;
      const doc = structuredClone(fixture) as { game: { id: number; homeCompetitor: { name: string }; awayCompetitor: { name: string } } };
      doc.game.id = id;
      doc.game.homeCompetitor.name = home;
      doc.game.awayCompetitor.name = away;
      docs.set(id, doc);
      return { eventSlug: `event-${index}`, title: `${home} vs ${away}`, id, home, away };
    });
    const listingThree = { games: liveGames.map(game => ({
      id: game.id, statusGroup: 3,
      homeCompetitor: { name: game.home }, awayCompetitor: { name: game.away }
    })) };
    const requestedIds: string[] = [];
    const request = (url: string): Promise<unknown> => {
      if (url.includes("/allscores/")) return Promise.resolve(listingThree);
      const id = /gameId=(\d+)/.exec(url)?.[1];
      if (id) requestedIds.push(id);
      return Promise.resolve(docs.get(Number(id)));
    };
    const poller = new TennisPointsPoller({
      request, now: () => nowMs, heartbeatMs: 60_000, listRefreshMs: 600_000, maxGames: 2, concurrency: 1
    });
    const targets = liveGames.map(({ eventSlug, title }) => ({ eventSlug, title }));

    const first = await poller.poll(targets);
    expect(new Set(first.map(result => result.eventSlug))).toEqual(new Set(["event-1", "event-2"]));
    expect(requestedIds).toEqual(["7001", "7002"]);

    nowMs += 61_000;
    const second = await poller.poll(targets);
    expect(new Set(second.map(result => result.eventSlug))).toEqual(new Set(["event-3", "event-1"]));
    expect(requestedIds).toEqual(["7001", "7002", "7003", "7001"]);
  });

  test("polls a transliterated game title that exact matching would miss", async () => {
    const doc = structuredClone(fixture) as { game: { id: number; homeCompetitor: { name: string }; awayCompetitor: { name: string } } };
    doc.game.id = 555001;
    doc.game.homeCompetitor.name = "Abdullah Shelbayh";
    doc.game.awayCompetitor.name = "Mitchell Krueger";
    const listingVariant = { games: [
      { id: 555001, statusGroup: 3, homeCompetitor: { name: "Abdullah Shelbayh" }, awayCompetitor: { name: "Mitchell Krueger" } }
    ] };
    const request: (url: string) => Promise<unknown> = (url) =>
      Promise.resolve(url.includes("/allscores/") ? listingVariant : doc);
    const poller = new TennisPointsPoller({ request, now: () => observedAtMs, listRefreshMs: 600_000 });
    const results = await poller.poll([{
      eventSlug: "atp-shelbay-krueger-2026-10-03",
      title: "Columbus: Abedallah Shelbayh vs Mitchell Krueger"
    }]);
    expect(results).toHaveLength(1);
    expect(results[0]!.eventSlug).toBe("atp-shelbay-krueger-2026-10-03");
    expect(results[0]!.frame.homeName).toBe("Abdullah Shelbayh");
  });

  test("never returns a frame whose players do not match the target title", async () => {
    const doc = structuredClone(fixture) as { game: { id: number; homeCompetitor: { name: string }; awayCompetitor: { name: string } } };
    doc.game.id = 555002;
    doc.game.homeCompetitor.name = "Mirra Andreeva";
    doc.game.awayCompetitor.name = "Madison Keys";
    // The listing wrongly maps a different pairing onto the target slug; the
    // poll-time name verification must drop it instead of arming the wrong event.
    const listingWrong = { games: [
      { id: 555002, statusGroup: 3, homeCompetitor: { name: "Mirra Andreeva" }, awayCompetitor: { name: "Madison Keys" } }
    ] };
    const request: (url: string) => Promise<unknown> = (url) =>
      Promise.resolve(url.includes("/allscores/") ? listingWrong : doc);
    const poller = new TennisPointsPoller({ request, now: () => observedAtMs, listRefreshMs: 600_000 });
    const results = await poller.poll([{ eventSlug: "wta-keys-2026-10-04", title: "Erika Andreeva vs Madison Keys" }]);
    expect(results).toEqual([]);
  });

  test("skips targets that never matched a live 365Scores game", async () => {
    const request: (url: string) => Promise<unknown> = (url) => Promise.resolve(url.includes("/allscores/") ? listing : fixture);
    const poller = new TennisPointsPoller({ request, now: () => observedAtMs });
    const results = await poller.poll([{ eventSlug: "nobody", title: "Nobody Here vs Someone Else" }]);
    expect(results).toEqual([]);
  });
});
