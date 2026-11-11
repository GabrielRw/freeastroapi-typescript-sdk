# Changelog

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
