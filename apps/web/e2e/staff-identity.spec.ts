/**
 * A-037 / D-33 — WHO IS AT THE DESK.
 *
 * Four people share one terminal, so every mutation read "by the front desk"
 * and "who moved this appointment" had no real answer. The PIN is deliberately
 * NOT a login: it acts inside a session already opened with a real credential,
 * and decides only whose name goes on the next thing that happens.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

/** The bar is a native `<details>`; the `/staff` page also says "At the desk:"
 *  in its own paragraph, so the summary has to be named explicitly. */
function deskBar(page: Page) {
  return page.locator('summary').filter({ hasText: 'At the desk:' });
}

async function addPriya(page: Page) {
  await page.goto('/staff/people');
  const form = page.locator('form').filter({ hasText: 'Add somebody' });
  await form.getByLabel('Name').fill('Priya');
  await form.getByLabel('Desk PIN').fill('4821');
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Priya added.')).toBeVisible();
}

test.describe('named staff identity', () => {
  test.beforeEach(async () => {
    const prisma = new PrismaClient();
    try {
      await seedSetup(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('somebody added to the roster can take the desk, and the log says their name', async ({ page }) => {
    await signIn(page);
    await addPriya(page);

    // The bar is on every staff screen, so taking the desk does not mean
    // navigating somewhere first.
    await page.goto('/staff/day');
    await expect(deskBar(page)).toBeVisible();
    await deskBar(page).click();
    await page.getByLabel('Who').selectOption({ label: 'Priya' });
    await page.getByLabel('PIN').fill('4821');
    await page.getByRole('button', { name: 'That’s me' }).click();

    await expect(page.getByText('Priya is at the desk.')).toBeVisible();

    // And the stamp on the next mutation is hers, not the account's.
    const prisma = new PrismaClient();
    try {
      const priya = await prisma.staffUser.findFirstOrThrow({ where: { name: 'Priya' } });
      await page.goto('/staff');
      await expect(page.getByRole('main').getByText('Priya')).toBeVisible();
      expect(priya.pinHash).not.toBe('4821');
      // A roster identity is not an account: no email, so no way to sign in.
      expect(priya.email).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('a wrong PIN is refused with one generic message', async ({ page }) => {
    await signIn(page);
    await addPriya(page);

    await page.goto('/staff');
    await deskBar(page).click();
    await page.getByLabel('Who').selectOption({ label: 'Priya' });
    await page.getByLabel('PIN').fill('0000');
    await page.getByRole('button', { name: 'That’s me' }).click();

    await expect(page.getByText('That name and PIN do not match.')).toBeVisible();
    // Still whoever it was — a failed switch must not silently hand the desk
    // over, or the log would name the wrong person for the rest of the shift.
    await expect(page.getByRole('main').getByText('Front desk')).toBeVisible();
  });

  /** Off-boarding takes somebody off the switcher and ends their session,
   *  without taking their name off the events they already stamped. */
  test('taking somebody off the roster removes them from the switcher', async ({ page }) => {
    await signIn(page);
    await addPriya(page);

    await page.goto('/staff/people');
    const row = page.locator('li').filter({ hasText: 'Priya' });
    await row.getByRole('button', { name: 'Take off the roster' }).click();
    await expect(page.getByText('Priya is off the roster.')).toBeVisible();

    await page.goto('/staff');
    await deskBar(page).click();
    await expect(page.getByText('Nobody else has a desk PIN yet.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      // Deactivated, NOT deleted — the name has to survive on every event it
      // ever stamped, or "who did this" loses its answer the day she leaves.
      const priya = await prisma.staffUser.findFirstOrThrow({ where: { name: 'Priya' } });
      expect(priya.active).toBe(false);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('the roster screen has no serious accessibility violations', async ({ page }) => {
    await signIn(page);
    await addPriya(page);
    await page.goto('/staff/people');

    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious).toEqual([]);
  });
});
