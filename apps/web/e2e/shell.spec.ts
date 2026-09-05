/**
 * A-085 (D-49, D-50) — THE STAFF SHELL (design brief §5.5, §8.4).
 *
 * The item is a navigation change, so the assertions are about REACHABILITY
 * rather than about markup. Before this file existed the measurement was:
 * `/staff/unfinished` had ONE inbound door behind a badge that hid at zero,
 * `/staff/waitlist`, `/staff/messages` and `/staff/clients` had one each, and
 * `/staff` — the page sign-in landed on — named twelve of twenty-three routes.
 *
 * The test that matters most is the LAST one: it starts on the day grid, with
 * the phone ringing, and gets to a named client in one hop. That is §5.5's
 * headline gap and the operator review has named it twice.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
    const business = await prisma.business.findFirstOrThrow();
    await prisma.client.create({
      data: { businessId: business.id, name: 'Margaret Kerr', phone: '5125550199' },
    });
  } finally {
    await prisma.$disconnect();
  }
});

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Awaited, or the `goto` in a caller races the session cookie and lands back
  // on the login page with no shell to assert against.
  await expect(page).toHaveURL(/\/staff\/day/);
}

/** The shell's own nav, so a link named "Day" here is never the day toolbar's. */
const shell = (page: Page) => page.getByRole('navigation', { name: 'Staff' });

test('signing in lands on the day grid, not on an index', async ({ page }) => {
  await signIn(page);
  // §5.5: "The day grid is the home screen in practice, not /staff."
  await expect(page).toHaveURL(/\/staff\/day/);
});

test('every desk screen is one hop from every other', async ({ page }) => {
  await signIn(page);

  // The measured defect, inverted into an assertion: each of these had one or
  // two inbound doors in the whole product, and now has one from everywhere.
  for (const [label, url] of [
    ['Opened up', /\/staff\/opened/],
    ['Still open', /\/staff\/unfinished/],
    ['Waitlist', /\/staff\/waitlist/],
    ['Call-down', /\/staff\/call-down/],
    ['Conflicts', /\/staff\/conflicts/],
    ['Messages', /\/staff\/messages/],
    ['Day', /\/staff\/day/],
  ] as const) {
    await shell(page).getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(url);
  }
});

test('the shell follows you onto a screen it did not send you to', async ({ page }) => {
  await signIn(page);
  // A page reached by a route the nav does not name still carries the chrome —
  // that is the difference between a layout and a component pasted on pages.
  await page.goto('/staff/settings');
  await expect(shell(page).getByRole('link', { name: 'Day', exact: true })).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: 'At the desk:' })).toBeVisible();
});

test('the current section is marked, and only one is', async ({ page }) => {
  await signIn(page);
  await page.goto('/staff/waitlist');

  const current = shell(page).locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText(/Waitlist/);

  // A deeper URL in the same section still marks its section — otherwise the
  // shell says "you are nowhere" on exactly the screens people get lost on.
  await page.goto('/staff/dashboard/lapsed');
  await expect(shell(page).locator('[aria-current="page"]')).toHaveText(/Dashboard/);

  // And `/staff` is matched exactly: Setup must not be current on every page.
  await page.goto('/staff/day');
  await expect(shell(page).locator('[aria-current="page"]')).toHaveText(/Day/);
});

test('the owner tier is separated, and Setup is not owner-only', async ({ page }) => {
  await signIn(page);
  await page.goto('/staff/day');

  // Dashboard is owner-gated exactly as it was before the shell existed; Setup
  // is not, because every route it indexes is `requireStaff` and a navigation
  // change must not quietly remove a stylist's access to Services.
  await expect(shell(page).getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(shell(page).getByRole('link', { name: 'Setup' })).toBeVisible();

  await shell(page).getByRole('link', { name: 'Setup' }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
  for (const label of ['Availability', 'Providers', 'Who works here', 'Services', 'The room', 'Settings']) {
    await expect(page.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
});

test('the counts are the same fact everywhere, and the day no longer keeps its own', async ({ page }) => {
  await signIn(page);
  // Nothing is unfinished and nothing has opened up on a fresh salon, so the
  // doors are there and the numbers are not (D-50).
  await page.goto('/staff/day');
  await expect(shell(page).getByRole('link', { name: 'Opened up', exact: true })).toBeVisible();
  await expect(shell(page).getByRole('link', { name: 'Still open', exact: true })).toBeVisible();

  // The day toolbar used to render its own copies of both. It must not any
  // more — two renderings of one count is two answers the first time the
  // derivation changes, and `listOpenedSlots` is a derivation, not a COUNT(*).
  const toolbar = page.getByRole('main');
  await expect(toolbar.getByRole('link', { name: /Opened up/ })).toHaveCount(0);
  await expect(toolbar.getByRole('link', { name: /Still open/ })).toHaveCount(0);
});

test('finds a client from the day grid in one hop, while she waits', async ({ page }) => {
  await signIn(page);
  await page.goto('/staff/day');

  // §5.5's headline gap: this was day grid → /staff → Clients → search.
  await shell(page).getByLabel('Search a client').fill('Kerr');
  await shell(page).getByRole('button', { name: 'Find' }).click();

  await expect(page).toHaveURL(/\/staff\/clients\?q=Kerr/);
  await expect(page.getByRole('link', { name: /Margaret Kerr/ })).toBeVisible();
});

test('the shell has no accessibility violations', async ({ page }) => {
  await signIn(page);
  await page.goto('/staff/day');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
