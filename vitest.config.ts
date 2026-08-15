import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    // The engine suite must pass under ANY process TZ (D-3). CI runs it twice:
    // once under TZ=UTC and once under TZ=Pacific/Kiritimati (A-001 wires this).
    // Locally, run `TZ=Pacific/Kiritimati npm test` before calling A-008 done.
  },
});
