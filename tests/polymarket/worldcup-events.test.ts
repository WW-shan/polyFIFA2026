import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchOpenWorldCupEventSlugs } from "../../src/polymarket/worldcup-events.js";

afterEach(() => {
  vi.restoreAllMocks();
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
