import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  appendSportsAudit,
  matchSportsUpdateToEvent,
  normalizeSportsUpdate,
  parseElapsedSeconds
} from "../../src/polymarket/sports-live.js";
import type { WorldCupEventRef } from "../../src/polymarket/worldcup-events.js";

const refs: WorldCupEventRef[] = [
  {
    eventSlug: "fifwc-prt-uzb-2026-06-23",
    gameId: 90086952,
    sportradarGameId: "sr:sport_event:66457034",
    homeTeam: "Portugal",
    awayTeam: "Uzbekistan",
    startTime: "2026-06-23T17:00:00Z"
  }
];

describe("sports live update helpers", () => {
  test("parses elapsed formats", () => {
    expect(parseElapsedSeconds("89:30")).toBe(5370);
    expect(parseElapsedSeconds("90+3'")).toBe(5580);
    expect(parseElapsedSeconds("93:00")).toBe(5580);
    expect(parseElapsedSeconds("")).toBeUndefined();
  });

  test("matches by gameId and normalizes score", () => {
    const update = normalizeSportsUpdate({
      gameId: 90086952,
      score: "3-1",
      period: "2H",
      elapsed: "90+3'",
      live: true,
      ended: false
    }, refs, new Date("2026-06-23T19:00:00.000Z"));

    expect(update).toMatchObject({
      eventSlug: "fifwc-prt-uzb-2026-06-23",
      homeGoals: 3,
      awayGoals: 1,
      period: "2H",
      elapsedSeconds: 5580,
      isLive: true,
      ended: false
    });
  });

  test("matches by sportradarGameId", () => {
    expect(matchSportsUpdateToEvent({ sportradarGameId: "sr:sport_event:66457034" }, refs)?.eventSlug)
      .toBe("fifwc-prt-uzb-2026-06-23");
  });

  test("returns null for malformed scores", () => {
    expect(normalizeSportsUpdate({ gameId: 90086952, score: "bad", period: "2H", live: true }, refs)).toBeNull();
  });

  test("writes audit records as ndjson", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-sports-audit-"));
    const file = join(dir, "audit.ndjson");
    await appendSportsAudit(file, {
      receivedAt: "2026-06-23T19:00:00.000Z",
      raw: { gameId: 90086952 },
      normalized: { eventSlug: "fifwc-prt-uzb-2026-06-23" }
    });

    expect(await readFile(file, "utf8")).toContain("\"eventSlug\":\"fifwc-prt-uzb-2026-06-23\"");
  });
});
