# `@freeastroapi/sdk`

[![CI](https://github.com/GabrielRw/freeastroapi-typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/GabrielRw/freeastroapi-typescript-sdk/actions/workflows/ci.yml)

Official TypeScript client for [FreeAstroAPI](https://www.freeastroapi.com).

> v0.1.0 is source-ready but has not been published to npm yet.

## Install

After the first registry release:

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

## Typed resources in v0.1.0

```ts
client.geo.search(...);
client.moon.phase(...);
client.moon.month(...);
client.skyEvents.list(...);
client.western.signs.sun(...);
client.western.signs.moon(...);
client.western.signs.rising(...);
client.western.signs.midheaven(...);
```

These methods match the reviewed operations in `public-spec/openapi/freeastro.yaml`. Use the typed generic escape hatch for another documented endpoint:

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

Issues and contributions are welcome on [GitHub](https://github.com/GabrielRw/freeastroapi-typescript-sdk).

Licensed under Apache License 2.0.
