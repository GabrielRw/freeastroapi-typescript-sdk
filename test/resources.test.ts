import { describe, expect, it, vi } from "vitest";

import { FreeAstro } from "../src";
import type { Fetch } from "../src";

const jsonResponse = (body: unknown = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("typed resources", () => {
  it("matches every reviewed OpenAPI operation", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse());
    const client = new FreeAstro({ apiKey: "test_key", fetch });
    const birth = { year: 1990, month: 6, day: 15, city: "Paris" } as const;

    await client.geo.search({ q: "Paris", limit: 3, country: "FR" });
    await client.moon.phase({ date: "2026-08-27T10:00:00Z", include_eclipse: true });
    await client.moon.month({ year: 2026, month: 8, city: "Paris", include_forecast: true });
    await client.skyEvents.list({ date: "2026-08-27", timezone: "Europe/Paris", include_moon: true });
    await client.western.signs.sun(birth);
    await client.western.signs.moon(birth);
    await client.western.signs.rising(birth);
    await client.western.signs.midheaven(birth);

    expect(fetch.mock.calls.map(([url, init]) => [init?.method, String(url)])).toEqual([
      ["GET", "https://api.freeastroapi.com/api/v2/geo/search?q=Paris&limit=3&country=FR"],
      ["GET", "https://api.freeastroapi.com/api/v1/moon/phase?date=2026-08-27T10%3A00%3A00Z&include_eclipse=true"],
      ["GET", "https://api.freeastroapi.com/api/v1/moon/month?year=2026&month=8&city=Paris&include_forecast=true"],
      ["GET", "https://api.freeastroapi.com/api/v1/sky-events?date=2026-08-27&timezone=Europe%2FParis&include_moon=true"],
      ["POST", "https://api.freeastroapi.com/api/v1/western/signs/sun"],
      ["POST", "https://api.freeastroapi.com/api/v1/western/signs/moon"],
      ["POST", "https://api.freeastroapi.com/api/v1/western/signs/rising"],
      ["POST", "https://api.freeastroapi.com/api/v1/western/signs/midheaven"],
    ]);

    for (const [, init] of fetch.mock.calls.slice(4)) {
      expect(init?.headers && new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual(birth);
    }
  });

  it("allows a Moon phase request with no parameters", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse());
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await client.moon.phase();

    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.freeastroapi.com/api/v1/moon/phase");
  });
});
