import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { liveStateOf, matchEspnGame, parseScoreboard, parseSummary, teamsMatch } from "../../../src/research/shadow/espn.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve("tests/fixtures/shadow", name), "utf8")) as unknown;
}

const pre = parseScoreboard(fixture("espn-scoreboard-pre.json"));
const finals = parseScoreboard(fixture("espn-scoreboard-final.json"));

describe("parseScoreboard", () => {
  test("reads the scheduled Eagles/Bears game", () => {
    expect(pre).toHaveLength(1);
    const game = pre[0]!;
    expect(game.espnId).toBe("401872963");
    expect(game.startMs).toBe(Date.parse("2026-09-29T00:15:00Z"));
    expect(game.status.state).toBe("pre");
    expect(game.home.displayName).toBe("Chicago Bears");
    expect(game.away.displayName).toBe("Philadelphia Eagles");
    expect(game.home.names).toContain("bears");
    expect(game.home.names).toContain("chicago");
    expect(game.homeScore).toBe(0);
  });

  test("reads finished games with winner and clock", () => {
    expect(finals).toHaveLength(2);
    const game = finals[0]!;
    expect(game.espnId).toBe("401872953");
    expect(game.status.state).toBe("post");
    expect(game.status.completed).toBe(true);
    expect(game.status.clockSeconds).toBe(0);
    expect(game.home.displayName).toBe("Buffalo Bills");
    expect(game.homeScore).toBe(24);
    expect(game.awayScore).toBe(16);
    expect(game.winner).toBe("home");
  });

  test("drops malformed events instead of guessing", () => {
    expect(parseScoreboard({ events: [{ id: "1" }, null] })).toEqual([]);
    expect(parseScoreboard({})).toEqual([]);
    expect(parseScoreboard(null)).toEqual([]);
  });
});

describe("liveStateOf", () => {
  test("returns null before and after the game", () => {
    expect(liveStateOf(pre[0]!)).toBeNull();
    expect(liveStateOf(finals[0]!)).toBeNull();
  });

  test("returns the visible state while in progress", () => {
    const game = { ...pre[0]!, status: { ...pre[0]!.status, state: "in" as const, period: 4, clock: "2:31", clockSeconds: 151 },
      homeScore: 24, awayScore: 20 };
    expect(liveStateOf(game)).toEqual({ period: 4, clockSeconds: 151, clock: "2:31", homeScore: 24, awayScore: 20 });
  });

  test("refuses a state without a clock or scores", () => {
    const base = { ...pre[0]!, status: { ...pre[0]!.status, state: "in" as const, period: 4, clock: "2:31", clockSeconds: 151 },
      homeScore: 24, awayScore: 20 };
    expect(liveStateOf({ ...base, status: { ...base.status, clockSeconds: null } })).toBeNull();
    expect(liveStateOf({ ...base, homeScore: null })).toBeNull();
  });
});

describe("team matching", () => {
  test("matches a Polymarket outcome name against ESPN aliases", () => {
    expect(teamsMatch(pre[0]!.away.names, "Eagles")).toBe(true);
    expect(teamsMatch(pre[0]!.home.names, "Bears")).toBe(true);
    expect(teamsMatch(pre[0]!.home.names, "Eagles")).toBe(false);
    expect(teamsMatch([], "Eagles")).toBe(false);
    expect(teamsMatch(["Bears"], "")).toBe(false);
  });

  test("selects the game whose teams and start time agree", () => {
    const match = matchEspnGame(pre, { names: ["Eagles", "Bears"], startMs: Date.parse("2026-09-29T00:15:00Z") });
    expect(match?.espnId).toBe("401872963");
    expect(matchEspnGame(pre, { names: ["Eagles", "Bears"], startMs: Date.parse("2026-09-30T00:15:00Z") })).toBeNull();
    expect(matchEspnGame(pre, { names: ["Eagles", "Cowboys"], startMs: Date.parse("2026-09-29T00:15:00Z") })).toBeNull();
  });
});

describe("parseSummary", () => {
  test("reads the final score and the last published play", () => {
    const summary = parseSummary(fixture("espn-summary-final.json"));
    expect(summary.status.state).toBe("post");
    expect(summary.homeScore).toBe(30);
    expect(summary.awayScore).toBe(26);
    expect(summary.winner).toBe("home");
    expect(summary.lastPlay).toEqual({
      wallclockMs: Date.parse("2026-09-28T03:54:17Z"), period: 4, clock: "0:00", clockSeconds: 0, homeScore: 30, awayScore: 26
    });
  });

  test("ignores the rejected win probability field and tolerates missing plays", () => {
    expect(JSON.stringify(parseSummary(fixture("espn-summary-final.json")))).not.toContain("123456789");
    expect(parseSummary({ header: { competitions: [{}] } }).lastPlay).toBeNull();
    expect(parseSummary(null).status.state).toBe("unknown");
  });
});
