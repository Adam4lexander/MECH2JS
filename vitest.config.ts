import { defineConfig } from 'vitest/config';

// Two projects:
//   unit   - needs nothing but the source; always runs.
//   golden - reads the real game data (MW2_ROOT) and the decompilation's
//            listings (MW2_DECOMPILED) and checks the port against them record
//            by record. Each suite skips, loudly, when its inputs are absent.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { test: { name: 'golden', include: ['test/golden/**/*.test.ts', 'test/sim/**/*.test.ts'], testTimeout: 120_000 } },
    ],
  },
});
