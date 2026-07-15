import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
