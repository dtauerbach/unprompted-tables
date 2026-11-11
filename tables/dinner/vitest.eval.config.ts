import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    // A quick feud runs to dinner, two minutes in at the latest.
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
