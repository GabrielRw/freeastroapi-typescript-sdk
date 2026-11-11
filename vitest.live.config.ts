import { defineConfig } from "vitest/config";

// Smoke tests against production. They need FREEASTRO_TEST_API_KEY and spend a handful of
// requests from that key's daily quota: FREEASTRO_TEST_API_KEY=... npm run test:live
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
});
