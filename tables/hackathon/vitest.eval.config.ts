import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    // A hackathon listed to close in a minute and freeze in two and a half,
    // played through in real time.
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
