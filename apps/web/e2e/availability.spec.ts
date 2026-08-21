import AxeBuilder from '@axe-core/playwright';
import { PrismaClient } from '@bookable/db';
import { instantFromIso, toDate } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

/** Through the one conversion module, like every other spec (D-3/D-4). */
const at = (iso: string) => toDate(instantFromIso(iso));

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

async function addProvider(page: import('@playwright/test').Page, name: string) {
  await page.goto('/staff/providers');
  await page.getByLabel('Add a provider').fill(name);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe('availability (A-007)', () => {
  test('refuses an anonymous visitor', async ({ page }) => {
    await page.goto('/staff/availability');
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  test('business hours can be set and persist', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('#open-').fill('09:00');
    await page.locator('#close-').fill('18:00');
    await page.getByRole('button', { name: 'Add hours' }).click();

    await expect(page.getByText('09:00–18:00')).toBeVisible();
    await page.reload();
    await expect(page.getByText('09:00–18:00')).toBeVisible();
  });

  // AVAIL-01: never swapped, never silently empty.
  test('refuses a window that closes before it opens', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('#open-').fill('17:00');
    await page.locator('#close-').fill('09:00');
    await page.getByRole('button', { name: 'Add hours' }).click();

    await expect(page.getByText(/does not come after/)).toBeVisible();
    await expect(page.getByText('17:00–09:00')).toHaveCount(0);
  });

  test('refuses a break that falls outside its window', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('#open-').fill('09:00');
    await page.locator('#close-').fill('17:00');
    await page.locator('#breakOpen-').fill('18:00');
    await page.locator('#breakClose-').fill('19:00');
    await page.getByRole('button', { name: 'Add hours' }).click();

    await expect(page.getByText(/falls outside its window/)).toBeVisible();
  });

  test('a provider gets her own hours, separate from the business', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();
    await expect(page.getByRole('heading', { name: 'Weekly hours' })).toBeVisible();

    await page.locator('input[name="open"]').first().fill('10:00');
    await page.locator('input[name="close"]').first().fill('16:00');
    await page.getByRole('button', { name: 'Add hours' }).click();
    await expect(page.getByText('10:00–16:00')).toBeVisible();

    // The business pattern is untouched by a provider's hours.
    await page.getByRole('link', { name: 'The business' }).click();
    await expect(page.getByText('10:00–16:00')).toHaveCount(0);
  });

  // AVAIL-02: an override REPLACES, never merges.
  test('a date override is recorded and shown as replacing that day', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('input[name="day"]').fill('2026-12-24');
    await page.locator('input[name="open"]').nth(1).fill('10:00');
    await page.locator('input[name="close"]').nth(1).fill('14:00');
    await page.locator('input[name="reason"]').first().fill('Christmas Eve');
    await page.getByRole('button', { name: 'Save date' }).click();

    await expect(page.getByText('2026-12-24')).toBeVisible();
    await expect(page.getByText('10:00–14:00')).toBeVisible();
    await expect(page.getByText('Christmas Eve')).toBeVisible();
  });

  test('a closed-all-day override is recorded as closed', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('input[name="day"]').fill('2026-07-04');
    await page.locator('input[name="isClosed"]').check();
    await page.locator('input[name="reason"]').first().fill('Independence Day');
    await page.getByRole('button', { name: 'Save date' }).click();

    await expect(page.getByText('2026-07-04')).toBeVisible();
    await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  });

  /**
   * AVAIL-03 / D-2: recording time off over an existing appointment must
   * SUCCEED. Refusing it is not the design — surfacing what it stranded for a
   * human is (A-019).
   */
  test('time off is accepted, with an explicit offset (D-4)', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();

    await page.locator('input[name="startAt"]').fill('2026-06-09T14:00:00-05:00');
    await page.locator('input[name="endAt"]').fill('2026-06-09T16:00:00-05:00');
    await page.locator('input[name="reason"]').last().fill('Dentist');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // "Time off" also appears in the section heading, the explanatory
    // paragraph and the <option> — scope to the recorded row itself.
    const row = page.getByRole('listitem').filter({ hasText: 'Dentist' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Time off')).toBeVisible();
  });

  /**
   * A-041 (operator P-8). The write ALWAYS succeeds (D-2/A-007) — this test
   * is about the sentence that comes back with it. The screen's own copy has
   * promised "which appointments it strands is shown" since A-007; nothing
   * ever computed it until this row.
   */
  test('time off says what it just stranded, and links to the list', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const provider = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.create({
        data: { businessId: business.id, name: 'Cut', durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, priceCents: 5500 },
      });
      const client = await prisma.client.create({ data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' } });
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: provider.id,
          clientId: client.id,
          startAt: at('2026-06-09T15:00:00.000Z'),
          endAt: at('2026-06-09T15:45:00.000Z'),
          blockedStart: at('2026-06-09T15:00:00.000Z'),
          blockedEnd: at('2026-06-09T15:45:00.000Z'),
          startDay: '2026-06-09',
          startWallTime: '10:00',
          status: 'booked',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();

    // Covers the whole morning, including her 10:00.
    await page.locator('input[name="startAt"]').fill('2026-06-09T09:00:00-05:00');
    await page.locator('input[name="endAt"]').fill('2026-06-09T12:00:00-05:00');
    await page.locator('input[name="reason"]').last().fill('Called in sick');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // The write is NOT refused (D-2/A-007) — it already happened. This is
    // what the response says about it.
    await expect(page.getByText('Time off added.')).toBeVisible();
    await expect(page.getByText('1 appointment now stranded.')).toBeVisible();

    await page.getByRole('link', { name: 'Deal with them' }).click();
    await expect(page).toHaveURL(/\/staff\/conflicts\?day=2026-06-09/);
    await expect(page.getByText('Ada Chen')).toBeVisible();
  });

  // D-4: a zoneless payload is undecidable on fall-back day.
  test('refuses a time-off payload with no timezone offset', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();

    await page.locator('input[name="startAt"]').fill('2026-06-09T14:00:00');
    await page.locator('input[name="endAt"]').fill('2026-06-09T16:00:00');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByText(/explicit timezone offset/)).toBeVisible();
  });

  test('the availability page has no serious accessibility violations', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');
    await page.goto('/staff/availability');
    const businessScan = await new AxeBuilder({ page }).analyze();
    expect(businessScan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

    await page.getByRole('link', { name: 'Dana' }).click();
    const providerScan = await new AxeBuilder({ page }).analyze();
    expect(providerScan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
});
