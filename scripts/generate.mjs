#!/usr/bin/env node
// Generates typed resources and schema types from the vendored OpenAPI document.
//
//   node scripts/generate.mjs           write src/generated/*
//   node scripts/generate.mjs --check   fail if src/generated/* is out of date
//
// spec/freeastro.json is refreshed from production by .github/workflows/sync-spec.yml
// (`python3 scripts/spec_sync.py fetch`). Hand-written resources (src/resources.ts) extend the
// generated base classes for geo, moon, skyEvents and western so their v0.1 signatures stay
// unchanged. `generate(spec)` is exported for the generator's unit tests.

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = join(ROOT, "spec", "freeastro.json");
const OUT_DIR = join(ROOT, "src", "generated");
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

// Operations implemented by hand in src/resources.ts (kept for v0.1 compatibility).
const HAND_WRITTEN = new Set([
  "v2_geo_search",
  "v1_moon_phase",
  "v1_moon_month",
  "v1_sky_events",
  "v1_western_signs_sun",
  "v1_western_signs_moon",
  "v1_western_signs_rising",
  "v1_western_signs_midheaven",
]);
// Resources whose top-level class is hand-written and extends `<Name>ResourceBase`.
const HAND_WRITTEN_RESOURCES = new Set(["geo", "moon", "skyEvents", "western"]);
// Method names for operations whose path has nothing after the resource.
const EMPTY_NAME = { v1_sky_events: "list" };

// Names the generated code relies on, or that are not valid TypeScript type names.
const RESERVED_TYPE_NAMES = new Set([
  "Array", "Record", "Promise", "Partial", "Uint8Array", "unknown", "never", "string", "number", "boolean",
  "object", "symbol", "bigint", "undefined", "null", "void", "any", "this", "typeof", "keyof",
]);
// Response content types returned as text; any other non-JSON type is returned as bytes.
const isJsonType = (type) => /^application\/json\b|\+json\b/i.test(type);
const isTextType = (type) => /^text\/|^image\/svg\+xml|^application\/(xml|yaml|x-yaml)\b|\+xml\b/i.test(type);

// Current spec and component-name mapping, set by `generate`.
let schemaNames = new Map();

const camel = (text) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part[0].toLowerCase() : part[0].toUpperCase()) + part.slice(1))
    .join("");
const pascal = (text) => {
  const c = camel(text);
  return c ? c[0].toUpperCase() + c.slice(1) : c;
};
const isIdent = (key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
const propKey = (key) => (isIdent(key) ? key : JSON.stringify(key));
const isParam = (segment) => segment.startsWith("{") && segment.endsWith("}");

const docComment = (lines, indent) => {
  const text = lines
    .filter((line) => line !== undefined && line !== null && String(line).trim() !== "")
    .join("\n")
    .replace(/\*\//g, "*\\/");
  if (!text) return "";
  const body = text.split("\n").map((line) => `${indent} *${line ? ` ${line}` : ""}`.replace(/\s+$/, ""));
  return `${indent}/**\n${body.join("\n")}\n${indent} */\n`;
};

// ---------------------------------------------------------------- schema -> TypeScript

const literal = (value) => JSON.stringify(value);

// anyOf/oneOf members that only add constraints (e.g. `{required: ["city"]}` next to
// `properties`) describe validation, not shape; such unions are ignored for typing.
const CONSTRAINT_KEYS = new Set(["required", "not", "title", "description", "minProperties", "maxProperties"]);
const shapeUnion = (schema) => {
  const union = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(union)) return null;
  const constraintOnly = union.every((s) => s && Object.keys(s).every((k) => CONSTRAINT_KEYS.has(k)));
  return constraintOnly ? null : union;
};

// Component names become TypeScript identifiers: `Model-Input` -> `Model_Input`.
function buildSchemaNames(names) {
  const map = new Map();
  const used = new Set();
  for (const raw of names) {
    let name = raw.replace(/[^A-Za-z0-9_$]/g, "_");
    if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
    if (RESERVED_TYPE_NAMES.has(name)) name = `${name}Schema`;
    let unique = name;
    for (let i = 2; used.has(unique); i += 1) unique = `${name}${i}`;
    used.add(unique);
    map.set(raw, unique);
  }
  return map;
}

const refName = (ref) => {
  const raw = ref.split("/").pop();
  const name = schemaNames.get(raw);
  if (!name) throw new Error(`Unresolved $ref ${ref}`);
  return name;
};

function tsType(schema, prefix, indent = "") {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) return "unknown";
  if (schema.$ref) return prefix + refName(schema.$ref);
  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return [...new Set(schema.enum.map(literal))].join(" | ") || "never";
  const union = shapeUnion(schema);
  if (union) {
    const members = [...new Set(union.map((s) => wrap(tsType(s, prefix, indent))))];
    return members.join(" | ");
  }
  if (Array.isArray(schema.allOf)) {
    const members = [...new Set(schema.allOf.map((s) => wrap(tsType(s, prefix, indent))))];
    return members.join(" & ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((t) => wrap(tsType({ ...schema, type: t }, prefix, indent))).join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${tsType(schema.items, prefix, indent)}>`;
    case "object":
    case undefined:
      if (schema.properties || schema.additionalProperties !== undefined || schema.type === "object") {
        return objectType(schema, prefix, indent);
      }
      return "unknown";
    default:
      return "unknown";
  }
}

const wrap = (type) => (/[|&]/.test(type) && !/^[{(]/.test(type) && !type.startsWith("Array<") ? `(${type})` : type);

function objectBody(schema, prefix, indent) {
  const required = new Set(schema.required ?? []);
  const inner = `${indent}  `;
  const lines = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    lines.push(
      docComment([prop.description, prop.deprecated ? "@deprecated" : undefined], inner) +
        `${inner}${propKey(key)}${required.has(key) ? "" : "?"}: ${tsType(prop, prefix, inner)};`,
    );
  }
  if (schema.additionalProperties && Object.keys(schema.properties ?? {}).length > 0) {
    lines.push(`${inner}[key: string]: unknown;`);
  }
  return lines;
}

function objectType(schema, prefix, indent) {
  const hasProps = Object.keys(schema.properties ?? {}).length > 0;
  if (!hasProps) {
    const extra = schema.additionalProperties;
    if (extra && typeof extra === "object") return `Record<string, ${tsType(extra, prefix, indent)}>`;
    return "Record<string, unknown>";
  }
  return `{\n${objectBody(schema, prefix, indent).join("\n")}\n${indent}}`;
}

function renderSchemas(schemas) {
  const out = [
    "// Generated by scripts/generate.mjs from spec/freeastro.json. Do not edit.",
    "/* eslint-disable */",
    "",
  ];
  for (const [raw, schema] of Object.entries(schemas)) {
    const name = schemaNames.get(raw);
    const doc = docComment([schema.description, name !== raw ? `Schema \`${raw}\` in the OpenAPI document.` : undefined], "");
    const isObject =
      (schema.type === "object" || schema.properties) &&
      Object.keys(schema.properties ?? {}).length > 0 &&
      !shapeUnion(schema) &&
      !schema.allOf;
    if (isObject) {
      out.push(`${doc}export interface ${name} {\n${objectBody(schema, "", "").join("\n")}\n}\n`);
    } else {
      out.push(`${doc}export type ${name} = ${tsType(schema, "", "")};\n`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- operations

// The first 2xx response decides the return type: its JSON schema, else text or bytes.
function successResponse(op) {
  const code = Object.keys(op.responses ?? {})
    .filter((c) => /^2\d\d$/.test(c))
    .sort()[0];
  const content = (code && op.responses[code]?.content) || {};
  // Text types first so content negotiation (e.g. a mock server) prefers what we decode.
  const types = Object.keys(content).sort((x, y) => Number(isTextType(y)) - Number(isTextType(x)) || x.localeCompare(y));
  const jsonType = types.find(isJsonType);
  if (jsonType) return { kind: "json", schema: content[jsonType]?.schema, types };
  if (types.length === 0) return { kind: "json", schema: undefined, types };
  return { kind: types.some(isTextType) ? "text" : "bytes", schema: undefined, types };
}

function collectOperations(spec) {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      let version = 1;
      let segments;
      if (path === "/natal") {
        segments = ["natal", "simple"];
      } else {
        const match = path.match(/^\/api\/v(\d+)\/(.*)$/);
        if (!match) throw new Error(`Unexpected public path ${path}`);
        version = Number(match[1]);
        segments = match[2].split("/").filter(Boolean);
      }
      const params = (op.parameters ?? []).filter((p) => p.in === "path" || p.in === "query");
      const bodyContent = op.requestBody?.content ?? {};
      const bodyType = Object.keys(bodyContent).sort().find(isJsonType);
      if (op.requestBody && !bodyType) {
        throw new Error(`${op.operationId}: request body types ${Object.keys(bodyContent).join(", ") || "(none)"} are not supported; only JSON bodies are.`);
      }
      const jsonBody = bodyType ? bodyContent[bodyType] : undefined;
      const success = successResponse(op);
      ops.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        op,
        version,
        resource: camel(segments[0]),
        rest: segments.slice(1),
        pathParams: params.filter((p) => p.in === "path"),
        queryParams: params.filter((p) => p.in === "query"),
        body: jsonBody ? jsonBody.schema ?? {} : null,
        bodyRequired: Boolean(op.requestBody?.required),
        json: success.kind === "json" ? success.schema : undefined,
        responseKind: success.kind,
        responseTypes: success.types,
      });
    }
  }
  return ops;
}

function assignNames(ops) {
  // A second path segment becomes a sub-resource when no operation sits directly on it.
  const direct = new Set();
  for (const o of ops) {
    const literalRest = o.rest.filter((s) => !isParam(s));
    if (literalRest.length === 1) direct.add(`${o.resource}/${literalRest[0]}`);
  }
  for (const o of ops) {
    const literalRest = o.rest.filter((s) => !isParam(s));
    let sub = null;
    let nameParts = literalRest;
    if (literalRest.length >= 2 && !isParam(o.rest[0]) && !direct.has(`${o.resource}/${o.rest[0]}`)) {
      sub = camel(o.rest[0]);
      nameParts = literalRest.slice(1);
    }
    o.sub = sub;
    o.baseName = nameParts.length ? camel(nameParts.join("-")) : EMPTY_NAME[o.id] ?? "get";
  }
  const groups = new Map();
  for (const o of ops) {
    const key = `${o.resource}/${o.sub ?? ""}/${o.baseName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  for (const group of groups.values()) {
    const latest = Math.max(...group.map((o) => o.version));
    const perVersion = new Map();
    for (const o of group) {
      if (perVersion.has(o.version)) throw new Error(`Name clash: ${o.id} and ${perVersion.get(o.version).id}`);
      perVersion.set(o.version, o);
      o.name = o.version === latest ? o.baseName : `${o.baseName}V${o.version}`;
    }
  }
  for (const o of ops) o.accessor = [o.resource, ...(o.sub ? [o.sub] : []), o.name];
  // Sub-resource and method names must not collide.
  const members = new Map();
  for (const o of ops) {
    const top = `${o.resource}.${o.sub ?? o.name}`;
    const kind = o.sub ? "sub" : "method";
    if (members.has(top) && members.get(top) !== kind) throw new Error(`Member clash on ${top}`);
    members.set(top, kind);
  }
  return ops;
}

// ---------------------------------------------------------------- resources

const paramsTypeName = (o) => `${pascal(o.id)}Params`;

function renderParamsType(o) {
  const params = [...o.pathParams, ...o.queryParams];
  if (params.length === 0) return "";
  const lines = params.map(
    (p) =>
      docComment([p.description ?? p.schema?.description, p.deprecated ? "@deprecated" : undefined], "  ") +
      `  ${propKey(p.name)}${p.required ? "" : "?"}: ${tsType(p.schema, "Schemas.", "  ")};`,
  );
  return `/** Path and query parameters for \`${o.method} ${o.path}\`. */\nexport interface ${paramsTypeName(o)} {\n${lines.join("\n")}\n}\n`;
}

function responseType(o) {
  if (o.responseKind === "text") return "string";
  if (o.responseKind === "bytes") return "Uint8Array";
  return o.json ? tsType(o.json, "Schemas.", "    ") : "unknown";
}

function responseNote(o) {
  const types = o.responseTypes.join(", ");
  if (o.responseKind === "bytes") return `Returns the response body (${types}) as bytes.`;
  if (o.responseKind !== "text") return undefined;
  if (o.responseTypes.every(isTextType)) return `Returns the response body (${types}) as text.`;
  return `Returns the response body (${types}) as text; for binary formats such as PNG pass \`{ responseType: "bytes" }\` and \`T = Uint8Array\`.`;
}

const responseDefaults = (o) =>
  o.responseKind === "json"
    ? ""
    : `, { accept: ${literal(o.responseTypes.join(", "))}, responseType: ${literal(o.responseKind)} }`;

function renderMethod(o) {
  const hasParams = o.pathParams.length + o.queryParams.length > 0;
  const paramsRequired = [...o.pathParams, ...o.queryParams].some((p) => p.required);
  const args = [];
  if (o.body) args.push(`body: ${o.body.$ref || o.body.type ? tsType(o.body, "Schemas.", "    ") : "unknown"}`);
  if (hasParams) args.push(`params${paramsRequired ? "" : "?"}: ${paramsTypeName(o)}`);
  args.push("options?: EndpointRequestOptions");

  let pathExpr = JSON.stringify(o.path);
  let queryExpr = hasParams ? "params" : "undefined";
  const pre = [];
  if (o.pathParams.length) {
    const names = o.pathParams.map((p) => p.name);
    pre.push(`    const { ${names.join(", ")}, ...query } = params;`);
    pathExpr =
      "`" +
      o.path.replace(/\{([^}]+)\}/g, (_, name) => `\${encodeURIComponent(String(${name}))}`) +
      "`";
    queryExpr = "query";
  }
  const summary = o.op.summary ?? o.id;
  const description = (o.op.description ?? "").trim().split("\n\n")[0];
  const doc = docComment(
    [
      summary,
      description && description !== summary ? `\n${description}` : undefined,
      `\n\`${o.method} ${o.path}\``,
      responseNote(o),
      o.op.deprecated ? "@deprecated" : undefined,
    ],
    "  ",
  );
  const respType = responseType(o);
  return (
    doc +
    `  ${o.name}<T = ${respType}>(${args.join(", ")}): Promise<T> {\n` +
    pre.map((l) => `${l}\n`).join("") +
    `    return this.client.request<T>(${JSON.stringify(o.method)}, ${pathExpr}, withPayload(options, ${queryExpr}, ${o.body ? "body" : "undefined"}${responseDefaults(o)}));\n` +
    `  }\n`
  );
}

function renderResources(ops) {
  const resources = new Map();
  for (const o of ops) {
    if (!resources.has(o.resource)) resources.set(o.resource, { methods: [], subs: new Map() });
    const r = resources.get(o.resource);
    if (o.sub) {
      if (!r.subs.has(o.sub)) r.subs.set(o.sub, []);
      r.subs.get(o.sub).push(o);
    } else {
      r.methods.push(o);
    }
  }

  const out = [
    "// Generated by scripts/generate.mjs from spec/freeastro.json. Do not edit.",
    "/* eslint-disable */",
    'import type { EndpointRequestOptions, HttpClient, RequestOptions } from "../client";',
    'import type * as Schemas from "./schemas";',
    "",
    "const withPayload = (",
    "  options: EndpointRequestOptions | undefined,",
    "  query: object | undefined,",
    "  body: unknown,",
    "  defaults?: Pick<RequestOptions, \"accept\" | \"responseType\">,",
    "): RequestOptions => {",
    "  const result: RequestOptions = { ...defaults, ...options };",
    "  if (query !== undefined) result.query = query;",
    "  if (body !== undefined) result.body = body;",
    "  return result;",
    "};",
    "",
  ];

  for (const o of ops) {
    const t = renderParamsType(o);
    if (t) out.push(t);
  }

  const className = (resource, sub) =>
    sub ? `${pascal(resource)}${pascal(sub)}Resource` : HAND_WRITTEN_RESOURCES.has(resource) ? `${pascal(resource)}ResourceBase` : `${pascal(resource)}Resource`;

  const topLevel = [];
  for (const [resource, r] of [...resources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const generatedSubs = [...r.subs.entries()]
      .map(([sub, list]) => [sub, list.filter((o) => !HAND_WRITTEN.has(o.id))])
      .filter(([, list]) => list.length > 0);
    for (const [sub, list] of generatedSubs) {
      out.push(`export class ${className(resource, sub)} {\n  constructor(protected readonly client: HttpClient) {}\n`);
      for (const o of list) out.push(renderMethod(o));
      out.push("}\n");
    }
    const methods = r.methods.filter((o) => !HAND_WRITTEN.has(o.id));
    const name = className(resource, null);
    topLevel.push([resource, name]);
    const fields = generatedSubs.map(([sub]) => `  readonly ${sub}: ${className(resource, sub)};\n`).join("");
    const inits = generatedSubs.map(([sub]) => `    this.${sub} = new ${className(resource, sub)}(client);\n`).join("");
    out.push(`export class ${name} {\n${fields}\n  constructor(protected readonly client: HttpClient) {\n${inits}  }\n`);
    for (const o of methods) out.push(renderMethod(o));
    out.push("}\n");
  }

  const generatedTop = topLevel.filter(([resource]) => !HAND_WRITTEN_RESOURCES.has(resource));
  out.push(
    "/** Resources generated for every public operation outside the hand-written ones. */",
    "export abstract class GeneratedResources {",
    ...generatedTop.map(([resource, name]) => `  readonly ${resource}: ${name};`),
    "",
    "  protected constructor(http: HttpClient) {",
    ...generatedTop.map(([resource, name]) => `    this.${resource} = new ${name}(http);`),
    "  }",
    "}",
    "",
  );

  out.push(
    "export interface OperationInfo {",
    "  operationId: string;",
    "  method: string;",
    "  path: string;",
    "  /** Property path on the client, e.g. `[\"western\", \"natal\", \"insights\"]`. */",
    "  accessor: readonly string[];",
    "  hasBody: boolean;",
    "  pathParams: readonly string[];",
    "  deprecated: boolean;",
    "}",
    "",
    "/** Every public operation and the client method that calls it. */",
    "export const OPERATIONS: readonly OperationInfo[] = [",
    ...ops.map(
      (o) =>
        `  { operationId: ${literal(o.id)}, method: ${literal(o.method)}, path: ${literal(o.path)}, accessor: ${literal(o.accessor)}, hasBody: ${Boolean(o.body)}, pathParams: ${literal(o.pathParams.map((p) => p.name))}, deprecated: ${Boolean(o.op.deprecated)} },`,
    ),
    "];",
    "",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------- main

/** Render the generated files for an OpenAPI document: `{ files: { name: content }, ops }`. */
export function generate(spec) {
  const schemas = spec.components?.schemas ?? {};
  schemaNames = buildSchemaNames(Object.keys(schemas));
  const ops = assignNames(collectOperations(spec));
  return {
    files: {
      "schemas.ts": renderSchemas(schemas),
      "resources.ts": renderResources(ops),
    },
    ops,
    schemaCount: Object.keys(schemas).length,
  };
}

function main() {
  const { files, ops, schemaCount } = generate(JSON.parse(readFileSync(SPEC_PATH, "utf8")));
  const check = process.argv.includes("--check");
  let stale = [];
  if (!check) mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(OUT_DIR, name);
    if (check) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== content) stale.push(target);
    } else {
      writeFileSync(target, content);
    }
  }
  if (check && stale.length) {
    console.error(`Out of date: ${stale.join(", ")}. Run \`npm run generate\`.`);
    process.exit(1);
  }
  console.log(`${check ? "Checked" : "Generated"} ${ops.length} operations, ${schemaCount} schemas.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
