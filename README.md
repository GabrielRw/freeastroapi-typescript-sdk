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

Chart render endpoints (`client.vedic.kpRender`, `client.vedic.visual.chart`) return SVG as text; use `client.requestRaw` for PNG output.

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
npm run check
```

The resources and types in `src/generated/` are generated from `spec/freeastro.json`. To update them, copy the API's `public-spec/openapi/freeastro.json` into `spec/` and run:

```sh
npm run generate
```

`npm run check` fails when the generated files are out of date.

## Releasing

Bump `version` in `package.json` and `VERSION` in `src/index.ts`, update `CHANGELOG.md`, then push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). The `Release` workflow runs the checks and publishes to npm with provenance.

Issues and contributions are welcome on [GitHub](https://github.com/GabrielRw/freeastroapi-typescript-sdk).

Licensed under Apache License 2.0.
