# `@freeastroapi/sdk`

[![CI](https://github.com/GabrielRw/freeastroapi-typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/GabrielRw/freeastroapi-typescript-sdk/actions/workflows/ci.yml)

Official TypeScript client for [FreeAstroAPI](https://www.freeastroapi.com).

## Install

```sh
npm install @freeastroapi/sdk
```

## Quick start

```ts
import { FreeAstro } from "@freeastroapi/sdk";

const client = new FreeAstro({
  apiKey: process.env.FREEASTRO_API_KEY!,
});

const cities = await client.geo.search({ q: "Paris", limit: 3 });
console.log(cities.results[0]?.timezone);
```

Keep API keys in server-side or otherwise trusted runtimes. Do not bundle them into browser JavaScript.

## Resources

Every public operation in the [FreeAstroAPI OpenAPI document](spec/freeastro.json) has a typed method. Resources follow the API paths:

```ts
// POST /api/v1/natal/calculate
const chart = await client.natal.calculate({ year: 1990, month: 6, day: 15, hour: 14, minute: 30, city: "Paris" });

// POST /api/v1/western/natal/insights
const insights = await client.western.natal.insights(insightsRequest);

// POST /api/v1/western/progressions/secondary/exact-aspects
await client.western.progressions.secondaryExactAspects(request);

// POST /api/v2/vedic/panchang
const panchang = await client.vedic.panchang({ year: 2026, month: 1, day: 14, hour: 6, minute: 0, city: "Delhi" });

// GET /api/v1/chinese/calendar/{date}?lang=en
await client.chinese.calendar({ date: "2026-02-17", lang: "en" });

// GET /api/v3/horoscope/daily/sign?sign=aries
await client.horoscope.daily.sign({ sign: "aries" });
```

Method arguments are `(body, params?, options?)` for operations with a JSON body and `(params, options?)` otherwise, where `params` holds the path and query parameters.

When an operation exists in several API versions, the plain method name calls the latest version and older versions carry a suffix: `client.vedic.chart` calls `/api/v2/vedic/chart`, `client.vedic.chartV1` calls `/api/v1/vedic/chart`, and `client.horoscope.daily.signV1` / `signV2` reach the older daily horoscopes. Deprecated operations are marked `@deprecated`.

Resource groups: `ai`, `chinese`, `ephemeris`, `geo`, `horoscope`, `moon`, `natal`, `numerology`, `skyEvents`, `space`, `transits`, `vedic`, and `western` (with `astrocartography`, `directions`, `electional`, `natal`, `progressions`, `signs`, `transits` and more). `OPERATIONS` lists every operation with its client method.

### Types

Request and response types are generated from the spec's component schemas and exported under the `Schemas` namespace. Methods return the documented response type; where the spec does not describe a response, the result is `unknown` and you can pass your own type:

```ts
import { FreeAstro, type Schemas } from "@freeastroapi/sdk";

const request: Schemas.SynastryRequest = { person_a: personA, person_b: personB };
const synastry = await client.western.synastry(request);

const raw = await client.natal.calculate<MyNatalChart>(birth);
```

Operations with non-JSON responses send the matching `Accept` header and return text (SVG, Markdown) or a `Uint8Array` (PNG, PDF). The chart render endpoints (`client.vedic.kpRender`, `client.vedic.visual.chart`) return SVG as text; for PNG output pass `{ responseType: "bytes" }`:

```ts
const png = await client.vedic.kpRender<Uint8Array>({ ...birth, format: "png" }, { responseType: "bytes" });
```

### v0.1 methods

`client.geo.search`, `client.moon.phase`, `client.moon.month`, `client.skyEvents.list` and `client.western.signs.*` keep their v0.1 signatures and hand-written types.

### Other endpoints

Use the typed generic escape hatch for anything else:

```ts
const result = await client.request<MyResponse>("POST", "/api/v1/example", {
  body: { example: true },
  idempotencyKey: crypto.randomUUID(),
});
```

## Retries and idempotency

GET, HEAD, and OPTIONS requests retry transient network failures and HTTP 408, 429, 500, 502, 503, and 504 responses by default. The client honors `Retry-After` and caps exponential backoff.

Unsafe methods are not retried automatically. Supplying an `idempotencyKey` makes a request eligible for retry, or you can opt in explicitly with `retry: true` when the endpoint is known to be replay-safe.

```ts
await client.western.signs.sun(input, {
  idempotencyKey: "stable-key-for-this-logical-request",
});
```

## Errors

All API failures derive from `FreeAstroError`. More specific classes include `AuthenticationError`, `PermissionError`, `ValidationError`, `ConflictError`, `RateLimitError`, `ServerError`, `NetworkError`, and `TimeoutError`.

```ts
import { FreeAstroError, RateLimitError } from "@freeastroapi/sdk";

try {
  await client.geo.search({ q: "Paris" });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.error(error.retryAfter);
  } else if (error instanceof FreeAstroError) {
    console.error(error.status, error.code, error.requestId);
  }
}
```

## Development

```sh
npm install
npm run check                # generate:check, typecheck, unit tests, build
npm run test:contract:mock   # every method against a Prism mock of the spec (needs Python 3)
```

The resources and types in `src/generated/` are generated from `spec/freeastro.json` by `scripts/generate.mjs` (`npm run generate`). `npm run check` fails when the generated files are out of date. The generator's own tests (`test/generator.test.ts`) run it on a small synthetic spec (`test/fixtures/synthetic-spec.json`) covering component names that are not identifiers, error response schemas, 201 responses and non-JSON bodies.

### Tests

| Command | What it runs |
| --- | --- |
| `npm test` | Unit tests with a mocked `fetch`, including the generator tests. |
| `npm run test:contract:mock` | Starts [Prism](https://github.com/stoplightio/prism) (`scripts/with_prism.py`, pinned version) in mock mode on `spec/freeastro.json` and calls every operation through the SDK (`vitest.contract.config.ts`). Prism rejects any request that does not match the spec; responses must parse as the documented JSON kind, text or bytes. With Prism already running: `PRISM_URL=http://127.0.0.1:4010 npm run test:contract`. |
| `npm run test:live` | Five read-only calls against production (`vitest.live.config.ts`); needs `FREEASTRO_TEST_API_KEY`. |
| `python3 -m unittest discover -s scripts -p "test_*.py"` | Tests for `scripts/spec_sync.py`. |

Request values for the contract tests come from `python3 scripts/spec_sync.py samples spec/freeastro.json`, which builds a minimal valid request for every operation from its schema.

## Maintaining

### How the spec stays in sync

Production (`https://api.freeastroapi.com/openapi.json`) is the source of truth: the API is deployed by hand, so the live document is what customers call.

1. **`Sync spec` workflow** (`.github/workflows/sync-spec.yml`, daily and on demand) fetches the live spec with `scripts/spec_sync.py fetch`, which validates it and writes it normalised (sorted keys except schema `properties`, which keep the API's field order; 2-space indent) so diffs only show real changes.
2. If it differs from `spec/freeastro.json`, the workflow regenerates the SDK, runs `npm run check` and the Prism contract tests, and opens or updates a pull request from the `spec-sync/auto` branch, labelled `spec-sync`. If generation or a check fails, the workflow run fails and no pull request is opened.
3. The pull request body is the output of `scripts/spec_sync.py diff`: added, removed and changed operations and schemas. Breaking changes (removed operations, parameters or request fields, newly required request fields or parameters, removed request enum values, removed response fields or content types, removed schemas) are listed first and the title starts with `BREAKING:`. The script never picks the version; you do.
4. If production goes back to matching `main`, the next run closes the stale pull request.

Pull requests opened with `GITHUB_TOKEN` do not trigger other workflows, so CI does not start on its own for `spec-sync/auto`; the sync run already ran the same checks. To get CI status on the pull request, run **Actions → CI → Run workflow** on the `spec-sync/auto` branch, or close and reopen the pull request.

Run the same steps locally:

```sh
cp spec/freeastro.json /tmp/previous-spec.json
npm run spec:fetch                                   # python3 scripts/spec_sync.py fetch
npm run spec:diff -- /tmp/previous-spec.json spec/freeastro.json
npm run generate && npm run check && npm run test:contract:mock
```

The **`Live smoke test` workflow** (`.github/workflows/live-smoke.yml`, daily and on demand) runs `npm run test:live` with the `FREEASTRO_TEST_API_KEY` repository secret: geo search, moon phase, western sun sign, a natal chart and a vedic panchang, without retries (5 requests a day). Without the secret it is skipped with a notice.

`scripts/spec_sync.py` and `scripts/with_prism.py` are standard-library Python and identical in every FreeAstroAPI SDK repository; copy them, `test/fixtures/synthetic-spec.json` and the three workflows when starting a new SDK, then swap in that language's generate, check and test commands.

### Releasing

After merging a spec-sync pull request (or any release-worthy change):

1. Pick the version: breaking changes need a major bump (a minor bump while the SDK is 0.x), new operations or types a minor bump, anything else a patch.
2. Bump `version` in `package.json` and `VERSION` in `src/index.ts`, and add a `CHANGELOG.md` entry.
3. Commit, then push a matching tag: `git tag v0.3.0 && git push origin v0.3.0`.

The `Release` workflow checks that the tag matches `package.json`, runs `npm run check` and publishes to npm with provenance.

Issues and contributions are welcome on [GitHub](https://github.com/GabrielRw/freeastroapi-typescript-sdk).

Licensed under Apache License 2.0.
