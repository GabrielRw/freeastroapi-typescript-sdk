#!/usr/bin/env node
// Generates typed resources and schema types from the vendored OpenAPI document.
//
//   node scripts/generate.mjs           write src/generated/*
//   node scripts/generate.mjs --check   fail if src/generated/* is out of date
//
// Update spec/freeastro.json from the API's public-spec/openapi/freeastro.json, then run
// `npm run generate`. Hand-written resources (src/resources.ts) extend the generated base
// classes for geo, moon, skyEvents and western so their v0.1 signatures stay unchanged.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const schemas = spec.components?.schemas ?? {};

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

function tsType(schema, prefix, indent = "") {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) return "unknown";
  if (schema.$ref) return prefix + schema.$ref.split("/").pop();
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

function renderSchemas() {
  const out = [
    "// Generated by scripts/generate.mjs from spec/freeastro.json. Do not edit.",
    "/* eslint-disable */",
    "",
  ];
  for (const [name, schema] of Object.entries(schemas)) {
    const doc = docComment([schema.description], "");
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

function collectOperations() {
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
      const jsonBody = op.requestBody?.content?.["application/json"];
      const okContent = op.responses?.["200"]?.content ?? {};
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
        json: okContent["application/json"]?.schema,
        binary: !okContent["application/json"] && Object.keys(okContent).length > 0,
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
  if (o.binary) return "string";
  return o.json ? tsType(o.json, "Schemas.", "    ") : "unknown";
}

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
      o.binary ? "Returns the image body as text; use `requestRaw` for binary formats such as PNG." : undefined,
      o.op.deprecated ? "@deprecated" : undefined,
    ],
    "  ",
  );
  const respType = responseType(o);
  return (
    doc +
    `  ${o.name}<T = ${respType}>(${args.join(", ")}): Promise<T> {\n` +
    pre.map((l) => `${l}\n`).join("") +
    `    return this.client.request<T>(${JSON.stringify(o.method)}, ${pathExpr}, withPayload(options, ${queryExpr}, ${o.body ? "body" : "undefined"}));\n` +
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
    "): RequestOptions => {",
    "  const result: RequestOptions = { ...options };",
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

const ops = assignNames(collectOperations());
const files = {
  "schemas.ts": renderSchemas(),
  "resources.ts": renderResources(ops),
};

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
console.log(`${check ? "Checked" : "Generated"} ${ops.length} operations, ${Object.keys(schemas).length} schemas.`);
