import { defineConfig, devices } from '@playwright/test';

// e2e runs against a production build by default (CLAUDE.md, this repo's
// port is 3300). E2E_DEV=1 restores the dev server for stack traces/source maps
// when debugging a single failing spec — never for the full sweep.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
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
