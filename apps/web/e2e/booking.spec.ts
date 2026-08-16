/**
 * A-010 — the customer booking flow (BOOK-01, D-4, D-10).
 *
 * Seeded through `seedSetup` rather than by driving the staff UI: this spec is
 * about the CUSTOMER's journey, and forty clicks of setup in front of it would
 * make every failure ambiguous about which half broke.
 *
 * The day list is deliberately not pinned to a fixed date. It is "the next
 * open days from today in the salon's zone", so the spec picks the first one
 * offered — pinning it would mean the suite passes in June and fails in July.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { expect, test } from './fixtures';

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

/** The first option in whichever list is on screen. */
const firstOption = (page: Page) => page.locator('fieldset ul > li > button').first();

async function chooseServiceAndProvider(page: Page) {
  await page.goto('/book');
  await page.getByRole('button', { name: /^Cut 45 min/ }).click();
  await page.getByRole('button', { name: 'Dana', exact: true }).click();
  await expect(page.getByRole('group')).toContainText('Which day suits you?');
}

async function reachTheTimeList(page: Page) {
  await chooseServiceAndProvider(page);
  await firstOption(page).click();
  await expect(page.getByRole('group')).toContainText('What time on');
}

test.describe('customer booking flow (A-010)', () => {
  test('books an appointment end to end', async ({ page }) => {
    await reachTheTimeList(page);
    await firstOption(page).click();

    await page.getByLabel('Your name').fill('Ada Chen');
    await page.getByLabel('Phone').fill('(512) 555-0101');
    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

    // The appointment is real, and it went through the write path — a booked
    // row with a service line and an event, not a bare insert.
    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow({
        include: { lines: true, client: true },
      });
      expect(appointment.status).toBe('booked');
      expect(appointment.lines).toHaveLength(1);
      // Normalized on the way in, so the same person typing it either way is
      // one client (CLIENT-01).
      expect(appointment.client?.phone).toBe('5125550101');
      expect(await prisma.appointmentEvent.count()).toBeGreaterThan(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  // BOOK-01's two hard numbers.
  test('is five screens with two required text inputs', async ({ page }) => {
    await reachTheTimeList(page);
    await expect(page.getByRole('navigation', { name: 'Progress' })).toContainText('of 5');

    await firstOption(page).click();
    await expect(page.locator('input[required]')).toHaveCount(2);
  });

  test('a time can be chosen with the keyboard alone', async ({ page }) => {
    await reachTheTimeList(page);

    const time = firstOption(page);
    const label = ((await time.textContent()) ?? '').trim();
    await time.focus();
    await expect(time).toBeFocused();
    await page.keyboard.press('Enter');

    // Enter on the focused option advanced the flow and carried the choice.
    await expect(page.getByRole('button', { name: 'Confirm appointment' })).toBeVisible();
    expect(label.length).toBeGreaterThan(0);
    await expect(page.locator('form')).toContainText(label.split(/\s+/)[0]!);
  });

  test('announces the times politely when they change', async ({ page }) => {
    await reachTheTimeList(page);
    await expect(page.locator('[aria-live="polite"]')).toContainText(/appointment times? available on/);
  });

  /**
   * D-10: the customer sees the salon's language, never the system's. This
   * catches the ordinary leak — an enum, an id, or an entity name rendered
   * because it happened to be on the object being mapped.
   */
  test('shows the customer no internal vocabulary', async ({ page }) => {
    await reachTheTimeList(page);
    await firstOption(page).click();

    const body = (await page.locator('body').innerText()).toLowerCase();
    for (const leak of ['booked', 'cancelled_late', 'no_show', 'providerid', 'serviceid', 'slot', 'null', 'undefined']) {
      expect(body, `"${leak}" reached the customer`).not.toContain(leak);
    }
    // cuids: 25 characters of id, the shape that leaks from a careless map.
    expect(body).not.toMatch(/\bc[a-z0-9]{24}\b/);
  });

  test('has no accessibility violations on any screen', async ({ page }) => {
    await page.goto('/book');
    const scan = async (where: string) => {
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(violations.map((v) => v.id), where).toEqual([]);
    };

    await scan('service');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await scan('who');
    await page.getByRole('button', { name: 'Dana', exact: true }).click();
    await scan('day');
    await firstOption(page).click();
    await scan('time');
    await firstOption(page).click();
    await scan('details');
  });

  test('refuses a missing name and phone without losing the chosen time', async ({ page }) => {
    await reachTheTimeList(page);
    await firstOption(page).click();

    // The browser's own required-field handling blocks submit; clearing it
    // proves the SERVER validation is there too, which is the one that counts.
    await page.getByLabel('Your name').fill('   ');
    await page.getByLabel('Phone').fill('123');
    await page.locator('form').evaluate((f) => f.querySelectorAll('input').forEach((i) => i.removeAttribute('required')));
    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    await expect(page.getByText('Please give us a name for the appointment.')).toBeVisible();
    await expect(page.getByText(/phone number we can reach you on/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm appointment' })).toBeVisible();
  });
});
