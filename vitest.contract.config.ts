import { defineConfig } from "vitest/config";

// Contract tests against a Prism mock of spec/freeastro.json:
//   npm run test:contract:mock            (starts Prism through scripts/with_prism.py)
//   PRISM_URL=http://127.0.0.1:4010 npm run test:contract
export default defineConfig({
  test: {
    include: ["test/contract/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
