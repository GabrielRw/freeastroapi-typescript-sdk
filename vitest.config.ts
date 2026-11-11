import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Contract tests (vitest.contract.config.ts) need a Prism mock and live tests
    // (vitest.live.config.ts) call production; neither runs with `npm test`.
    exclude: [...configDefaults.exclude, "test/contract/**", "test/live/**"],
    coverage: {
      include: ["src/**/*.ts"],
    },
  },
});
