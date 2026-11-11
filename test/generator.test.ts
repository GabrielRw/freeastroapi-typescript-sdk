import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { generate } from "../scripts/generate.mjs";
import { AuthenticationError, ConflictError, HttpClient, ValidationError, type Fetch } from "../src";

// A small synthetic spec covering cases the production spec does not have yet: component
// names that are not identifiers, error response schemas, 201 responses and non-JSON bodies.
const ROOT = join(__dirname, "..");
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "synthetic-spec.json"), "utf8"));
const OUT = join(ROOT, "node_modules", ".cache", "generator-test");

const { files } = generate(fixture);
const schemas = files["schemas.ts"]!;
const resources = files["resources.ts"]!;

type Generated = Record<string, new (client: HttpClient) => Record<string, (...args: unknown[]) => Promise<unknown>>>;
let generated: Generated;

beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "generated"), { recursive: true });
  writeFileSync(join(OUT, "client.ts"), `export * from ${JSON.stringify(join(ROOT, "src", "client"))};\n`);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(OUT, "generated", name), content);
  generated = (await import(join(OUT, "generated", "resources.ts"))) as Generated;
});

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

const respond = (body: BodyInit | null, init: ResponseInit) => vi.fn<Fetch>().mockImplementation(async () => new Response(body, init));

describe("generator", () => {
  it("lists only side-effecting operations the spec has and reports the rest", () => {
    const withChat = structuredClone(fixture);
    withChat.paths["/api/v1/things/create"].post.operationId = "v2_vedic_chat";
    const result = generate(withChat);
    expect(result.files["resources.ts"]).toContain('SIDE_EFFECTING_OPERATIONS: ReadonlySet<string> = new Set([\n  "v2_vedic_chat",\n]);');
    expect(result.files["resources.ts"]).toMatch(/operationId: "v2_vedic_chat".*sideEffecting: true/);
    expect(result.missingSideEffecting).not.toContain("v2_vedic_chat");
    expect(generate(fixture).missingSideEffecting).toHaveLength(7);
  });

  it("emits code that type-checks", () => {
    const program = ts.createProgram([join(OUT, "generated", "resources.ts")], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  it("turns component names into identifiers and resolves refs to them", () => {
    expect(schemas).toContain("export interface Thing_Input {");
    expect(schemas).toContain("export interface Thing_Output {");
    expect(schemas).toContain("Schema `Thing-Input` in the OpenAPI document.");
    // `Record` would shadow the utility type the generator uses.
    expect(schemas).toContain("export interface RecordSchema {");
    expect(schemas).toContain("owner?: RecordSchema | null;");
    expect(schemas).toContain("export interface ErrorResponse {");
    expect(resources).toContain("createV1<T = Schemas.Thing_Output>(body: Schemas.Thing_Input");
  });

  it("types 201 and vendor JSON responses", () => {
    expect(resources).toContain("item<T = Schemas.RecordSchema>(params: V1ThingsItemParams");
    expect(resources).toContain("create<T = Schemas.Thing_Output>(body: Schemas.Thing_Input");
  });

  it("returns text for SVG and Markdown, bytes for PNG and PDF", () => {
    expect(resources).toContain("svg<T = string>(body: Schemas.RenderRequest");
    expect(resources).toContain("markdown<T = string>(options?");
    expect(resources).toContain("png<T = Uint8Array>(options?");
    expect(resources).toContain("pdf<T = Uint8Array>(params: V1DocsPdfParams");
    expect(resources).toContain("mixed<T = string>(body: Schemas.RenderRequest");
  });

  it("rejects request bodies it cannot encode", () => {
    const spec = structuredClone(fixture);
    spec.paths["/api/v1/render/svg"].post.requestBody = { content: { "multipart/form-data": { schema: { type: "object" } } } };
    expect(() => generate(spec)).toThrow(/multipart\/form-data are not supported/);
  });

  it("sends the right Accept header and decodes each body kind", async () => {
    const svgFetch = respond("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    const svg = await new generated.RenderResource!(new HttpClient({ apiKey: "k", fetch: svgFetch })).svg!({ size: 100 });
    expect(svg).toBe("<svg/>");
    expect(new Headers(svgFetch.mock.calls[0]![1]?.headers).get("accept")).toBe("image/svg+xml");

    const pdfFetch = respond(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } });
    const pdf = await new generated.DocsResource!(new HttpClient({ apiKey: "k", fetch: pdfFetch })).pdf!({ job_id: "j" });
    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(Array.from(pdf as Uint8Array)).toEqual([37, 80, 68, 70]);
    expect(new Headers(pdfFetch.mock.calls[0]![1]?.headers).get("accept")).toBe("application/pdf");

    const mdFetch = respond("# Title", { headers: { "content-type": "text/markdown; charset=utf-8" } });
    expect(await new generated.DocsResource!(new HttpClient({ apiKey: "k", fetch: mdFetch })).markdown!()).toBe("# Title");

    const pngFetch = respond(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } });
    const mixed = new generated.RenderResource!(new HttpClient({ apiKey: "k", fetch: pngFetch }));
    expect(await mixed.mixed!({ size: 100 }, { responseType: "bytes" })).toBeInstanceOf(Uint8Array);

    const jsonFetch = respond(JSON.stringify({ id: "1", name: "a" }), { status: 201, headers: { "content-type": "application/json" } });
    const things = new generated.ThingsResource!(new HttpClient({ apiKey: "k", fetch: jsonFetch }));
    expect(await things.item!({ thing_id: "a/b", lang: "fr" })).toEqual({ id: "1", name: "a" });
    expect(String(jsonFetch.mock.calls[0]![0])).toBe("https://api.freeastroapi.com/api/v1/things/item/a%2Fb?lang=fr");
    expect(new Headers(jsonFetch.mock.calls[0]![1]?.headers).get("accept")).toBe("application/json");
  });

  it("maps documented error responses to typed errors with the error body", async () => {
    const body = JSON.stringify({ detail: "Report not ready", code: "not_ready", trace_id: "t-1" });
    const conflict = respond(body, { status: 409, headers: { "content-type": "application/json" } });
    const docs = new generated.DocsResource!(new HttpClient({ apiKey: "k", fetch: conflict, retry: false }));
    const error = await docs.pdf!({ job_id: "j" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ status: 409, code: "not_ready", requestId: "t-1", message: "Report not ready" });

    const problem = respond(JSON.stringify({ detail: "bad size" }), { status: 400, headers: { "content-type": "application/problem+json" } });
    const things = new generated.ThingsResource!(new HttpClient({ apiKey: "k", fetch: problem }));
    await expect(things.createV1!({ name: "a" })).rejects.toBeInstanceOf(ValidationError);

    const unauthorized = respond(JSON.stringify({ detail: "bad key" }), { status: 401, headers: { "content-type": "application/json" } });
    const render = new generated.RenderResource!(new HttpClient({ apiKey: "k", fetch: unauthorized }));
    await expect(render.png!()).rejects.toBeInstanceOf(AuthenticationError);
  });
});
