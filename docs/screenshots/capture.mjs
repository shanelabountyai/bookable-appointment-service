/**
 * The DEMO.md pictures, shot against the same seeded book the demo walks.
 * Not a test: run it after DEMO.md's Setup, with the server up.
 *
 *   node docs/screenshots/capture.mjs docs/screenshots
 *
 * BASE defaults to the local server. Against the hosted demo, set
 * BASE=https://appt.labintelligence.co and DEMO_ACCESS_PASSWORD, and the
 * shared password gate is answered for every request.
 *
 * Two shots change state and put it back: the running-late delta is set and
 * then cleared, so a second run starts from the same book as the first.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3300';
const OUT = process.argv[2] ?? 'docs/screenshots';
const EMAIL = process.env.STAFF_EMAIL ?? 'owner@shear-genius.test';
const PASSWORD = process.env.STAFF_PASSWORD ?? 'demo-owner-password';
const GATE = process.env.DEMO_ACCESS_PASSWORD;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  ...(GATE ? { httpCredentials: { username: 'demo', password: GATE } } : {}),
});
const page = await ctx.newPage();

const shot = async (name, opts = {}) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log(`${name}.png  ${page.url().replace(BASE, '')}  | ${(await page.locator('h1').first().textContent())?.trim()}`);
};
const go = async (path) => {
  await page.goto(BASE + path);
  await page.waitForLoadState('networkidle');
};

// ── the public side ────────────────────────────────────────────────────────
await go('/');
await shot('01-public-home');

await go('/book');
await shot('02-book-services');
await page.locator('main button').filter({ hasText: /^Cut\s*45/ }).first().click();
await page.getByRole('button', { name: 'Continue' }).click();
await page.locator('main button').filter({ hasText: /^Dana$/ }).first().click();
await page.getByText(/Step 3 of 5/).waitFor();
// The second day offered, not the first: the first is often today, whose
// morning has already gone.
await page.locator('main button').filter({ hasText: /September|October|November/ }).nth(1).click();
await page.getByText(/Step 4 of 5/).waitFor();
await shot('03-book-times');

// ── the desk ───────────────────────────────────────────────────────────────
await go('/staff/login');
await page.getByLabel('Email').fill(EMAIL);
await page.getByLabel('Password').fill(PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(/\/staff\/day/);

await go('/staff/day');
await shot('04-day-today');

// Running late: set, shoot, clear. The panel's own sentence is the point —
// "Setting the delta changes no times and sends nothing."
const late = page.locator('form').filter({ hasText: 'Behind by' }).first();
await late.locator('input[name=minutes]').fill('15');
await late.getByRole('button', { name: 'Set' }).click();
await page.getByRole('button', { name: /Back on time/ }).first().waitFor();
await shot('05-running-late');
await page.getByRole('button', { name: /Back on time/ }).first().click();
await page.waitForLoadState('networkidle');

// Tomorrow is the dense day: the override lane, the PPD note, the flags.
await page.getByRole('link', { name: /Next/ }).first().click();
await page.waitForURL(/day=/);
await shot('06-day-tomorrow');

const ppd = page.locator('a[href^="/staff/appointments/"]').filter({ hasText: 'Tom Byrne' }).first();
if (await ppd.count()) {
  await ppd.click();
  await page.waitForURL(/\/staff\/appointments\//);
  await shot('07-appointment-detail', { fullPage: true });
} else {
  console.log('07-appointment-detail skipped: no Tom Byrne chip tomorrow on this book');
}

for (const [name, path] of [
  ['08-opened', '/staff/opened'],
  ['09-waitlist', '/staff/waitlist'],
  ['10-call-down', '/staff/call-down'],
  ['11-unfinished', '/staff/unfinished'],
  ['12-dashboard', '/staff/dashboard'],
  ['13-lapsed', '/staff/dashboard/lapsed'],
]) {
  await go(path);
  await shot(name);
}

await browser.close();
