import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchOpenWorldCupEventSlugs, normalizeWorldCupEventRefs } from "../../src/polymarket/worldcup-events.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("World Cup event refs", () => {
  test("keeps tradable fifwc slug and rich ids", () => {
    const refs = normalizeWorldCupEventRefs([
      {
        slug: "fifwc-prt-uzb-2026-06-23",
        title: "Portugal vs. Uzbekistan",
        startTime: "2026-06-23T17:00:00Z",
        eventMetadata: {
          gameId: 90086952,
          sportradarGameId: "sr:sport_event:66457034"
        },
        closed: false,
        archived: false,
        active: true
      }
    ]);

    expect(refs).toEqual([
      {
        eventSlug: "fifwc-prt-uzb-2026-06-23",
        gameId: 90086952,
        sportradarGameId: "sr:sport_event:66457034",
        homeTeam: "Portugal",
        awayTeam: "Uzbekistan",
        startTime: "2026-06-23T17:00:00Z"
      }
    ]);
  });

  test("dedupes by event slug and rejects non-single-match slugs", () => {
    const refs = normalizeWorldCupEventRefs([
      { slug: "fifwc-prt-uzb-2026-06-23", title: "Portugal vs. Uzbekistan" },
      { slug: "fifwc-prt-uzb-2026-06-23", title: "Portugal vs. Uzbekistan" },
      { slug: "fifwc-more-goals-2026", title: "Most goals" }
    ]);

    expect(refs.map((ref) => ref.eventSlug)).toEqual(["fifwc-prt-uzb-2026-06-23"]);
  });
});

describe("World Cup event discovery", () => {
  test("fetches open single-match FIFWC slugs from Gamma", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify([
      { slug: "fifwc-prt-uzb-2026-06-23", closed: false, archived: false },
      { slug: "fifwc-fra-irq-2026-06-22", closed: true, archived: false },
      { slug: "world-cup-winner-2026", closed: false, archived: false },
      { slug: "fifwc-more-markets-2026-06-23", closed: false, archived: false }
    ]), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fetchOpenWorldCupEventSlugs()).resolves.toEqual(["fifwc-prt-uzb-2026-06-23"]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("gamma-api.polymarket.com/events?"), expect.any(Object));
  });
});
