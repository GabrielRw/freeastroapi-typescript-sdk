import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationError,
  FreeAstro,
  RateLimitError,
  ValidationError,
} from "../src";
import type { Fetch } from "../src";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

describe("FreeAstro", () => {
  it("requires an API key", () => {
    expect(() => new FreeAstro({ apiKey: "" })).toThrow("apiKey is required");
  });

  it("serializes typed GET parameters and authentication", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ results: [], count: 0 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await client.geo.search({ q: "Paris", limit: 3, country: "FR" });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.freeastroapi.com/api/v2/geo/search?q=Paris&limit=3&country=FR");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test_key");
  });

  it("serializes typed POST bodies", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({
      point: "Sun",
      sign: "Gemini",
      sign_id: "gemini",
      degree: 12,
      abs_pos: 72,
      house: 10,
      interpretation: null,
    }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await client.western.signs.sun({ year: 1990, month: 6, day: 15, city: "Paris" });

    const [, init] = fetch.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ year: 1990, month: 6, day: 15, city: "Paris" });
  });

  it("retries GET requests and honors Retry-After", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: "slow down" }, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ results: [], count: 0 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await client.geo.search({ q: "Paris" });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry POST by default", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ detail: "busy" }, { status: 503 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await expect(client.western.signs.sun({ year: 1990, month: 6, day: 15, city: "Paris" })).rejects.toThrow("busy");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries POST with one idempotency key", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: "busy" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({
        point: "Sun",
        sign: "Gemini",
        sign_id: "gemini",
        degree: 12,
        abs_pos: 72,
        house: 10,
        interpretation: null,
      }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: { baseDelayMs: 0 } });

    await client.western.signs.sun(
      { year: 1990, month: 6, day: 15, city: "Paris" },
      { idempotencyKey: "birth-123" },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("birth-123");
    }
  });

  it.each([
    [401, AuthenticationError],
    [422, ValidationError],
    [429, RateLimitError],
  ])("maps status %s to a typed error", async (status, ErrorClass) => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ detail: "request failed" }, { status }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: false });

    await expect(client.geo.search({ q: "Paris" })).rejects.toBeInstanceOf(ErrorClass);
  });

  it("supports custom typed JSON requests", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ ok: true }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    const result = await client.request<{ ok: boolean }>("GET", "/api/v1/custom", {
      query: { enabled: true },
    });

    expect(result.ok).toBe(true);
    expect(String(fetch.mock.calls[0]![0])).toContain("enabled=true");
  });
});
