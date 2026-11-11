import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FreeAstro, OPERATIONS } from "../src";
import type { Fetch } from "../src";

const spec = JSON.parse(readFileSync(join(__dirname, "..", "spec", "freeastro.json"), "utf8")) as {
  paths: Record<string, Record<string, { operationId: string }>>;
};

const specOperations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ id: op.operationId, method: method.toUpperCase(), path })),
);

const jsonResponse = () => new Response("{}", { headers: { "content-type": "application/json" } });

type Method = (...args: unknown[]) => Promise<unknown>;

const resolve = (client: FreeAstro, accessor: readonly string[]) => {
  let owner: Record<string, unknown> = client as unknown as Record<string, unknown>;
  for (const key of accessor.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
  const method = owner[accessor[accessor.length - 1]!] as Method | undefined;
  return method?.bind(owner);
};

describe("generated operations", () => {
  it("covers every operation in the vendored spec exactly once", () => {
    expect(OPERATIONS.map((op) => op.operationId).sort()).toEqual(specOperations.map((op) => op.id).sort());
    const accessors = OPERATIONS.map((op) => op.accessor.join("."));
    expect(new Set(accessors).size).toBe(accessors.length);
  });

  it.each(OPERATIONS.map((op) => [op.accessor.join("."), op] as const))("%s calls its endpoint", async (_name, op) => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse());
    const client = new FreeAstro({ apiKey: "test_key", fetch, retry: false });
    const method = resolve(client, op.accessor);
    expect(method, op.accessor.join(".")).toBeTypeOf("function");

    const pathParams = Object.fromEntries(op.pathParams.map((name) => [name, "p 1"]));
    const body = { year: 1990 };
    const args: unknown[] = op.hasBody ? [body, pathParams] : [{ q: "Paris", year: 2026, month: 1, date: "2026-01-01", ...pathParams }];
    await method!(...args);

    const [url, init] = fetch.mock.calls[0]!;
    const expectedPath = op.path.replace(/\{([^}]+)\}/g, () => encodeURIComponent("p 1"));
    expect(init?.method).toBe(op.method);
    expect(new URL(String(url)).pathname).toBe(expectedPath);
    if (op.hasBody) expect(JSON.parse(String(init?.body))).toEqual(body);
    else expect(init?.body).toBeUndefined();
  });

  it("calls the latest API version by default and keeps older ones reachable", async () => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse());
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await client.vedic.panchang({ year: 2026, month: 1, day: 1, hour: 6, minute: 0, city: "Delhi" } as never);
    await client.vedic.panchangV1({} as never);
    await client.western.natal.insights({} as never);
    await client.natal.report({ job_id: "abc/1", format: "json" });

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.freeastroapi.com/api/v2/vedic/panchang",
      "https://api.freeastroapi.com/api/v1/vedic/panchang",
      "https://api.freeastroapi.com/api/v1/western/natal/insights",
      "https://api.freeastroapi.com/api/v1/natal/report/abc%2F1?format=json",
    ]);
  });
});
