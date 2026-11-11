import { describe, expect, it } from "vitest";

import { FreeAstro } from "../../src";

// Nightly smoke test against production (.github/workflows/live-smoke.yml). Five cheap,
// read-only calls; retries are off so a failure never spends extra quota.
const apiKey = process.env.FREEASTRO_TEST_API_KEY;
const baseUrl = process.env.FREEASTRO_BASE_URL;

describe.skipIf(!apiKey)("live API smoke test", () => {
  const client = new FreeAstro({ apiKey: apiKey ?? "", retry: false, ...(baseUrl ? { baseUrl } : {}) });

  it("geo.search", async () => {
    const cities = await client.geo.search({ q: "Paris", limit: 1 });
    expect(cities.results.length).toBeGreaterThan(0);
    expect(cities.results[0]?.timezone).toBeTypeOf("string");
  });

  it("moon.phase", async () => {
    const phase = await client.moon.phase({ date: "2026-01-15" });
    expect(phase).toBeTypeOf("object");
  });

  it("western.signs.sun", async () => {
    const sign = await client.western.signs.sun({ year: 1990, month: 6, day: 15, city: "Paris" });
    expect(sign).toBeTypeOf("object");
  });

  it("natal.calculate", async () => {
    const chart = await client.natal.calculate({ year: 1990, month: 6, day: 15, hour: 14, minute: 30, city: "Paris" });
    expect(chart).toBeTypeOf("object");
  });

  it("vedic.panchang", async () => {
    const panchang = await client.vedic.panchang({ year: 2026, month: 1, day: 14, hour: 6, minute: 0, city: "Delhi" });
    expect(panchang).toBeTypeOf("object");
  });
});
