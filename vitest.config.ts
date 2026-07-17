import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 80,
        functions: 85,
        lines: 80,
        statements: 80,
      },
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
