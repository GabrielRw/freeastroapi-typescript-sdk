import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationError,
  ConflictError,
  FreeAstro,
  FreeAstroError,
  NetworkError,
  PermissionError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from "../src";
import type { Fetch } from "../src";

const jsonResponse = (body: unknown, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200, headers });
};

describe("HTTP transport", () => {
  it("normalizes the base URL, merges headers, and protects authentication headers", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ ok: true }));
    const client = new FreeAstro({
      apiKey: "real_key",
      baseUrl: "https://example.test/",
      fetch,
      headers: { "X-SDK": "typescript", "X-API-Key": "wrong" },
    });

    await client.request("GET", "/health", {
      headers: { Accept: "text/plain", "x-sdk-request": "one", "x-api-key": "also-wrong" },
    });

    const [url, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe("https://example.test/health");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-api-key")).toBe("real_key");
    expect(headers.get("x-sdk")).toBe("typescript");
    expect(headers.get("x-sdk-request")).toBe("one");
  });

  it("serializes repeated query values and omits nullish values", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse({ ok: true }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await client.request("GET", "/custom", {
      query: { body: ["sun", "moon"], exact: false, zero: 0, missing: null, absent: undefined },
    });

    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://api.freeastroapi.com/custom?body=sun&body=moon&exact=false&zero=0",
    );
  });

  it("returns raw response metadata without losing parsed data", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () =>
      jsonResponse({ ok: true }, { headers: { "x-request-id": "req_123" } }),
    );
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    const result = await client.requestRaw<{ ok: boolean }>("GET", "/custom");

    expect(result.data).toEqual({ ok: true });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-request-id")).toBe("req_123");
  });

  it("parses vendor JSON, text, and empty responses", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(new Response('{"ok":true}', { headers: { "content-type": "application/problem+json" } }))
      .mockResolvedValueOnce(new Response("ready", { headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    expect(await client.request("GET", "/json")).toEqual({ ok: true });
    expect(await client.request("GET", "/text")).toBe("ready");
    expect(await client.request("GET", "/empty")).toBeUndefined();
  });

  it.each([
    [401, AuthenticationError],
    [403, PermissionError],
    [400, ValidationError],
    [422, ValidationError],
    [409, ConflictError],
    [429, RateLimitError],
    [503, ServerError],
    [418, FreeAstroError],
  ])("maps HTTP %s to %s", async (status, ErrorClass) => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () =>
      jsonResponse({ detail: "failed" }, { status }),
    );
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: false });

    await expect(client.request("GET", "/failure")).rejects.toBeInstanceOf(ErrorClass);
  });

  it("preserves structured error metadata", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () =>
      jsonResponse(
        { message: "invalid chart", code: "bad_chart", field: "year" },
        { status: 422, headers: { "x-request-id": "req_456" } },
      ),
    );
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: false });

    const error = await client.request("GET", "/failure").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      message: "invalid chart",
      status: 422,
      code: "bad_chart",
      requestId: "req_456",
      details: { message: "invalid chart", code: "bad_chart", field: "year" },
    });
  });

  it("parses numeric and HTTP-date Retry-After values on rate-limit errors", async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: "wait" }, { status: 429, headers: { "retry-after": "2.5" } }))
      .mockResolvedValueOnce(jsonResponse({ detail: "wait" }, { status: 429, headers: { "retry-after": future } }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: false });

    const numeric = await client.request("GET", "/limited").catch((caught: unknown) => caught);
    const dated = await client.request("GET", "/limited").catch((caught: unknown) => caught);

    expect(numeric).toMatchObject({ retryAfter: 2.5 });
    expect(dated).toBeInstanceOf(RateLimitError);
    expect((dated as RateLimitError).retryAfter).toBeGreaterThan(55);
    expect((dated as RateLimitError).retryAfter).toBeLessThanOrEqual(60);
  });

  it("retries transient network failures for GET requests", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: { baseDelayMs: 0 } });

    await expect(client.request("GET", "/unstable")).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("respects global and per-request retry controls", async () => {
    const noRetryFetch = vi.fn<Fetch>().mockImplementation(async () =>
      jsonResponse({ detail: "busy" }, { status: 503 }),
    );
    const noRetryClient = new FreeAstro({ apiKey: "test_key", fetch: noRetryFetch, retry: false });
    await expect(noRetryClient.request("GET", "/busy")).rejects.toBeInstanceOf(ServerError);
    expect(noRetryFetch).toHaveBeenCalledOnce();

    const optInFetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: "busy" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const optInClient = new FreeAstro({ apiKey: "test_key", fetch: optInFetch, retry: { baseDelayMs: 0 } });
    await expect(optInClient.request("POST", "/safe", { retry: true })).resolves.toEqual({ ok: true });
    expect(optInFetch).toHaveBeenCalledTimes(2);
  });

  it("turns exhausted transport failures into NetworkError", async () => {
    const cause = new TypeError("offline");
    const fetch = vi.fn<Fetch>().mockRejectedValue(cause);
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: false });

    const error = await client.request("GET", "/offline").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).cause).toBe(cause);
  });

  it("turns an elapsed deadline into TimeoutError", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: false, timeoutMs: 5 });

    await expect(client.request("GET", "/slow")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("preserves caller cancellation instead of wrapping it", async () => {
    const reason = new DOMException("cancelled by caller", "AbortError");
    const controller = new AbortController();
    controller.abort(reason);
    const fetch = vi.fn<Fetch>().mockImplementation(async (_input, init) => {
      throw init?.signal?.reason;
    });
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: false });

    await expect(client.request("GET", "/cancelled", { signal: controller.signal })).rejects.toBe(reason);
  });
});
