import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RETRY, FreeAstro, NetworkError, RateLimitError, SIDE_EFFECTING_OPERATIONS, ServerError, ValidationError } from "../src";
import type { Fetch } from "../src";

const jsonResponse = (body: unknown, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200, headers });
};

const failingThenOk = (failure: () => Response | Promise<Response>) =>
  vi.fn<Fetch>().mockImplementationOnce(async () => failure()).mockImplementation(async () => jsonResponse({ ok: true }));

const fast = { baseDelayMs: 0 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retry policy", () => {
  it("defaults to 2 retries, 0.5 s base, 8 s cap and a 30 s Retry-After limit", () => {
    expect(DEFAULT_RETRY).toMatchObject({ maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8_000, maxRetryAfterMs: 30_000 });
    expect(DEFAULT_RETRY.statuses).toEqual([408, 500, 502, 503, 504]);
  });

  it("lists the side-effecting operations", () => {
    expect([...SIDE_EFFECTING_OPERATIONS].sort()).toEqual([
      "v1_ai_generate",
      "v1_natal_calculate",
      "v1_western_transits_insights",
      "v1_western_transits_timeline",
      "v2_vedic_chat",
      "v2_vedic_qa",
      "v2_western_chat",
    ]);
  });

  it("retries 429 on a side-effecting POST without an idempotency key", async () => {
    const fetch = failingThenOk(() => jsonResponse({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "0" } }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await expect(client.vedic.chat({} as never)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).has("idempotency-key")).toBe(false);
  });

  it("waits retry_after_ms from the error body", async () => {
    const fetch = failingThenOk(() => jsonResponse({ error: "rate_limited", retry_after_ms: 20 }, { status: 429 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    const started = Date.now();
    await expect(client.natal.calculate({} as never)).resolves.toEqual({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a Retry-After header", { headers: { "retry-after": "60" } }, {}, 60],
    ["retry_after_ms in the body", {}, { retry_after_ms: 45_000 }, 45],
  ])("raises RateLimitError at once when %s exceeds 30 s", async (_name, init, body, seconds) => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ error: "rate_limited", ...body }, { status: 429, ...init }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    const error = await client.geo.search({ q: "Paris" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(seconds);
    expect((error as RateLimitError).code).toBe("rate_limited");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry 503 on v2_vedic_chat without an idempotency key", async () => {
    const fetch = failingThenOk(() => jsonResponse({ detail: "busy" }, { status: 503 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: fast });

    await expect(client.vedic.chat({} as never)).rejects.toBeInstanceOf(ServerError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries 503 on v2_vedic_chat with an idempotency key", async () => {
    const fetch = failingThenOk(() => jsonResponse({ detail: "busy" }, { status: 503 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: fast });

    await expect(client.vedic.chat({} as never, { idempotencyKey: "chat-1" })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get("idempotency-key")).toBe("chat-1");
  });

  it("retries 503 on v2_vedic_chat when the caller opts in", async () => {
    const fetch = failingThenOk(() => jsonResponse({ detail: "busy" }, { status: 503 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: fast });

    await expect(client.vedic.chat({} as never, { retry: true })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([408, 500, 502, 503, 504])("retries %s on a calculation POST", async (status) => {
    const fetch = failingThenOk(() => jsonResponse({ detail: "busy" }, { status }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: fast });

    await expect(client.vedic.panchang({} as never)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries network errors on calculation POSTs but not on side-effecting ones", async () => {
    const calc = vi.fn<Fetch>().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(jsonResponse({ ok: true }));
    await new FreeAstro({ apiKey: "test_key", fetch: calc, retry: fast }).western.signs.sun({ year: 1990, month: 6, day: 15, city: "Paris" });
    expect(calc).toHaveBeenCalledTimes(2);

    const report = vi.fn<Fetch>().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(jsonResponse({ ok: true }));
    await expect(new FreeAstro({ apiKey: "test_key", fetch: report, retry: fast }).natal.calculate({} as never)).rejects.toBeInstanceOf(NetworkError);
    expect(report).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 409, 422])("never retries %s", async (status) => {
    const fetch = failingThenOk(() => jsonResponse({ detail: "no" }, { status }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: fast });

    await expect(client.geo.search({ q: "Paris" }, { retry: true })).rejects.toThrow("no");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("applies the policy to generic requests by matching the spec path", async () => {
    const report = failingThenOk(() => jsonResponse({ detail: "busy" }, { status: 503 }));
    await expect(new FreeAstro({ apiKey: "test_key", fetch: report, retry: fast }).request("POST", "/api/v1/natal/calculate?debug=1", { body: {} })).rejects.toBeInstanceOf(ServerError);
    expect(report).toHaveBeenCalledOnce();

    const calc = failingThenOk(() => jsonResponse({ detail: "busy" }, { status: 503 }));
    await new FreeAstro({ apiKey: "test_key", fetch: calc, retry: fast }).request("POST", "/api/v2/vedic/panchang", { body: {} });
    expect(calc).toHaveBeenCalledTimes(2);

    const chat = failingThenOk(() => jsonResponse({ detail: "busy" }, { status: 503 }));
    await expect(new FreeAstro({ apiKey: "test_key", fetch: chat, retry: fast }).request("POST", "/api/v2/vedic/chat", { body: {} })).rejects.toBeInstanceOf(ServerError);
    expect(chat).toHaveBeenCalledOnce();

    const unknown = failingThenOk(() => jsonResponse({ detail: "busy" }, { status: 503 }));
    await expect(new FreeAstro({ apiKey: "test_key", fetch: unknown, retry: fast }).request("POST", "/api/v1/unknown")).rejects.toBeInstanceOf(ServerError);
    expect(unknown).toHaveBeenCalledOnce();
  });

  it("uses full-jitter exponential backoff capped at maxDelayMs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
      if (ms === 60_000) return realSetTimeout(handler, ms);
      delays.push(Math.round(ms ?? 0));
      return realSetTimeout(handler, 0);
    }) as typeof setTimeout);
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ detail: "busy" }, { status: 503 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, timeoutMs: 60_000, retry: { maxRetries: 6 } });

    await expect(client.geo.search({ q: "Paris" })).rejects.toBeInstanceOf(ServerError);

    expect(fetch).toHaveBeenCalledTimes(7);
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it("honours per-request maxRetries and disabling", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ detail: "busy" }, { status: 429, headers: { "retry-after": "0" } }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await expect(client.geo.search({ q: "Paris" }, { retry: { maxRetries: 4 } })).rejects.toBeInstanceOf(RateLimitError);
    expect(fetch).toHaveBeenCalledTimes(5);

    fetch.mockClear();
    await expect(client.geo.search({ q: "Paris" }, { retry: false })).rejects.toBeInstanceOf(RateLimitError);
    expect(fetch).toHaveBeenCalledOnce();

    fetch.mockClear();
    await expect(client.geo.search({ q: "Paris" }, { retry: { retries: 1 } })).rejects.toBeInstanceOf(RateLimitError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads codes and messages from route, gateway and validation error bodies", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: { error: "invalid_city", message: "Unknown city" } }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ detail: [{ loc: ["body", "year"], msg: "Field required", type: "missing" }] }, { status: 422 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await expect(client.geo.search({ q: "?" })).rejects.toMatchObject({ code: "invalid_city", message: "Unknown city" });
    const error = await client.geo.search({ q: "?" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ message: "Field required" });
  });
});
