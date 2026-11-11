# Changelog

## 0.3.0

- Typed responses for every operation: the spec now documents a 2xx response for all 142 operations (975 component schemas), so every JSON method returns its `Schemas.*` response type instead of `unknown` or `Record<string, unknown>`. Chart routes return SVG text (or PNG bytes with `responseType: "bytes"`); `client.natal.report` can also return the PDF (`accept: "application/pdf"`, `responseType: "bytes"`).
- Typed errors: error responses reference `ErrorResponse` (422 also `HTTPValidationError`). `FreeAstroError.code` reads gateway `error` codes and route `detail.error` codes, `message` reads `detail.message` and validation issues, and `RateLimitError.retryAfter` also comes from the body's `retry_after_ms`.
- One retry policy: `maxRetries` 2 (the old `retries` option still works), exponential backoff from 0.5 s, factor 2, full jitter, capped at 8 s. 429 is retried for every operation, honouring `Retry-After` and `retry_after_ms`; a wait over 30 s throws `RateLimitError` at once. 408, 5xx, network errors and timeouts are retried for every operation except the side-effecting ones in `SIDE_EFFECTING_OPERATIONS`, which need an `idempotencyKey` or `retry: true`. Other 4xx are never retried. Calculation POSTs are now retried by default; previously only GET requests were.
- Lenient decoding: responses are never validated, so missing required fields, unexpected nulls, unknown fields and unknown enum values never throw. The hand-written v0.1 types follow the spec (`WesternSignResponse.interpretation` is an object or null, `resolved_time` added). A malformed JSON body now throws `FreeAstroError` instead of being retried as a network error.
- `OPERATIONS` entries gain `sideEffecting`.
- Operations with non-JSON responses send the matching `Accept` header and return text (SVG, Markdown, other `text/*`) or a `Uint8Array` (PNG, PDF and other binary types). New `accept` and `responseType` request options (`responseType: "bytes"` reads PNG chart renders).
- The generator handles component names that are not identifiers (`Model-Input` becomes `Schemas.Model_Input`), names that clash with TypeScript types, 2xx responses other than 200 and `+json` content types, and fails on request bodies it cannot encode.
- Add the daily `Sync spec` workflow, `scripts/spec_sync.py` (fetch, normalise, diff, request samples), Prism contract tests and a nightly live smoke test.
- `spec/freeastro.json` is stored normalised (sorted keys); generated files are reordered accordingly.

## 0.2.0

- Cover every operation in the public FreeAstroAPI OpenAPI document (142 operations): Western, Vedic (v1 and v2), Chinese BaZi, numerology, natal charts and reports, transits, ephemeris, horoscopes (v1-v3), AI reports, space charts, geo, Moon and sky events.
- Generate resources and request/response types from the vendored spec (`spec/freeastro.json`) with `npm run generate`; types are exported under the `Schemas` namespace.
- The plain method name calls the latest API version; older versions are available with a `V1`/`V2` suffix.
- Export `OPERATIONS`, a list of every operation and its client method.
- Add a tag-triggered release workflow that publishes to npm with provenance.
- v0.1 methods and types are unchanged.

## 0.1.0

- Add the `FreeAstro` client and generic typed request escape hatch.
- Add typed resources for Geo Search, Moon Phase, Moon Month, Sky Events, and four Western sign operations.
- Add capped exponential retries with `Retry-After` and idempotency-aware POST behavior.
- Add typed API, network, timeout, validation, authentication, permission, conflict, rate-limit, and server errors.
