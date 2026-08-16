import { defineConfig, devices } from '@playwright/test';

// e2e runs against a production build by default (CLAUDE.md, this repo's
// port is 3300). E2E_DEV=1 restores the dev server for stack traces/source maps
// when debugging a single failing spec — never for the full sweep.
export default defineConfig({
  testDir: './e2e',
  // NOT fullyParallel. Every spec shares ONE app instance and ONE local
  // Postgres test database (CLAUDE.md), and nothing here gives a test its own
  // tenant — the provider roster and service catalog are genuinely global
  // rows. Two specs mutating them concurrently (A-025's provider test and
  // A-006's qualification test both add "Dana") interleave into strict-mode
  // locator violations and count mismatches that have nothing to do with
  // either feature. Same bug class, same fix, as vitest's fileParallelism
  // false in vitest.config.ts: eliminate the race rather than add unique
  // suffixes to every piece of test data forever. The suite runs in ~15-25s
  // either way, so serial execution costs nothing that matters here.
  //
  // fullyParallel: false ALONE is not enough — it only serializes tests
  // WITHIN one spec file. Different files still run across Playwright's
  // default worker pool concurrently, which is what actually produced the
  // remaining collisions (settings.spec.ts and services.spec.ts both mutate
  // the shared provider/business rows). workers: 1 is the real fix.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3300',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.E2E_DEV ? 'npm run dev:test' : 'npm run e2e:server',
    cwd: '../..',
    url: 'http://localhost:3300',
    reuseExistingServer: !process.env.CI,
    // A cold production build is slower than a dev server's near-instant
    // start; the default 120s is sized for dev-server readiness.
    timeout: 300_000,
  },
});
