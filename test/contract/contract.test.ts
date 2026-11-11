import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FreeAstro, FreeAstroError, OPERATIONS, type Fetch } from "../../src";

// Calls every operation through the SDK against a Prism mock of spec/freeastro.json. Prism
// validates each request (path, query, headers, JSON body) against the spec and answers 4xx
// with an `sl-violations` header when it does not match, so a passing run means the SDK
// builds requests the API accepts and reads the documented responses.
//
// Request values are the minimal valid requests from `scripts/spec_sync.py samples`.

const PRISM_URL = process.env.PRISM_URL;
const ROOT = join(__dirname, "..", "..");

type Sample = { method: string; path: string; path_params: Record<string, unknown>; query: Record<string, unknown>; body?: unknown };
type Method = (...args: unknown[]) => Promise<unknown>;

const loadSamples = (): Record<string, Sample> =>
  JSON.parse(
    execFileSync(process.env.PYTHON ?? "python3", [join(ROOT, "scripts", "spec_sync.py"), "samples", join(ROOT, "spec", "freeastro.json")], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

type Schema = Record<string, unknown>;
const spec = JSON.parse(readFileSync(join(ROOT, "spec", "freeastro.json"), "utf8")) as {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }>>;
  components: { schemas: Record<string, Schema> };
};

// The JSON kind ("object", "array", ...) a documented response must have, or undefined when
// the spec leaves it open (no schema, unions).
const responseKind = (method: string, path: string): string | undefined => {
  const responses = spec.paths[path]?.[method.toLowerCase()]?.responses ?? {};
  const code = Object.keys(responses).filter((c) => /^2\d\d$/.test(c)).sort()[0];
  let schema = code ? responses[code]?.content?.["application/json"]?.schema : undefined;
  while (schema && typeof schema.$ref === "string") schema = spec.components.schemas[schema.$ref.split("/").pop()!];
  if (!schema) return undefined;
  if (schema.type === "object" || (schema.properties && !schema.type)) return "object";
  return typeof schema.type === "string" ? schema.type : undefined;
};

const kindOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

const resolve = (client: FreeAstro, accessor: readonly string[]) => {
  let owner: Record<string, unknown> = client as unknown as Record<string, unknown>;
  for (const key of accessor.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
  return (owner[accessor[accessor.length - 1]!] as Method).bind(owner);
};

describe.skipIf(!PRISM_URL)("contract (Prism mock)", () => {
  const samples = PRISM_URL ? loadSamples() : {};
  const responses: Response[] = [];
  const recordingFetch: Fetch = async (input, init) => {
    const response = await fetch(input, init);
    responses.push(response.clone());
    return response;
  };
  const client = new FreeAstro({ apiKey: "contract-test-key", baseUrl: PRISM_URL ?? "http://127.0.0.1:4010", retry: false, fetch: recordingFetch });

  it("has a sample for every operation", () => {
    expect(Object.keys(samples).sort()).toEqual(OPERATIONS.map((op) => op.operationId).sort());
  });

  it.each(OPERATIONS.map((op) => [op.accessor.join("."), op] as const))("%s", async (_name, op) => {
    const sample = samples[op.operationId]!;
    const params = { ...sample.path_params, ...sample.query };
    const args = op.hasBody ? [sample.body, params] : [params];
    responses.length = 0;

    let result: unknown;
    try {
      result = await resolve(client, op.accessor)(...args);
    } catch (error) {
      const response = responses.at(-1);
      const details = error instanceof FreeAstroError ? JSON.stringify(error.details) : String(error);
      // Prism validates the request, then cannot serialise schemaless image bodies
      // (image/svg+xml, image/png without a schema or example) and answers 500.
      if (error instanceof FreeAstroError && error.status === 500 && /Cannot find serializer/.test(details)) return;
      throw new Error(
        `${op.method} ${op.path} failed: ${error instanceof Error ? error.message : String(error)}\n` +
          `violations: ${response?.headers.get("sl-violations") ?? "-"}\nbody: ${details}`,
      );
    }

    const response = responses.at(-1)!;
    // Prism also reports where its own generated mock body breaks the response schema
    // (recursive schemas are cut short); only request violations are the SDK's fault.
    const violations = JSON.parse(response.headers.get("sl-violations") ?? "[]") as Array<{ location: string[] }>;
    expect(violations.filter((v) => v.location[0] === "request"), "Prism reported request violations").toEqual([]);
    expect(response.status).toBeLessThan(300);
    const contentType = response.headers.get("content-type") ?? "";
    if (/json/.test(contentType)) {
      // The body parsed as JSON of the documented kind; its static type is checked by tsc.
      const expected = responseKind(op.method, op.path);
      if (expected) expect(kindOf(result) === expected || (expected === "integer" && typeof result === "number")).toBe(true);
    } else {
      expect(typeof result === "string" || result instanceof Uint8Array).toBe(true);
    }
  });
});
