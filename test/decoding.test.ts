import { describe, expect, it, vi } from "vitest";

import { FreeAstro } from "../src";
import type { Fetch } from "../src";

// Response `required` lists are partly inferred from samples, so responses are never validated:
// missing required fields, nulls, unknown fields and unknown enum values come back as sent.
describe("lenient response decoding", () => {
  const body = {
    // MoonPhaseResponse requires `next_phases`: omitted.
    timestamp: null, // required string
    phase: {
      name: "Super Blue Moon", // not one of the documented phase names
      phase_angle_deg: 12.5,
      illumination: null, // required number
      is_waxing: true,
    },
    unexpected_field: { nested: [1, 2, 3] },
  };

  it.each([
    ["a hand-written method", (client: FreeAstro) => client.moon.phase()],
    ["a generated method", (client: FreeAstro) => client.vedic.panchang({} as never)],
    ["a generic request", (client: FreeAstro) => client.request("GET", "/api/v1/moon/phase")],
  ])("returns the body unchanged from %s", async (_name, call) => {
    const fetch = vi.fn<Fetch>().mockImplementation(
      async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
    const client = new FreeAstro({ apiKey: "test_key", fetch });

    await expect(call(client)).resolves.toEqual(body);
  });
});
