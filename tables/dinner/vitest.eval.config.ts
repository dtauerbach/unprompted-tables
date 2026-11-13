import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// By name, so dinner.eval.ts plays a public match to its end before
// lab.eval.ts walks the public lists for its rooms: the walk then has a
// listed feed and match page to read, not only an empty list.
class ByName extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    // A quick feud runs to dinner, two minutes in at the latest.
    testTimeout: 300_000,
    fileParallelism: false,
    sequence: { sequencer: ByName },
  },
});
