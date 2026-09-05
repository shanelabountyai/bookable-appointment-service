import AxeBuilder from '@axe-core/playwright';
import { PrismaClient } from '@bookable/db';
import { addDays, calendarDay, fromDate, resolve, toDate, toLabel, wallTime, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

test.describe('business settings & providers (A-025)', () => {
  test('both routes refuse an anonymous visitor', async ({ page }) => {
    await page.goto('/staff/settings');
    await expect(page).toHaveURL(/\/staff\/login$/);
    await page.goto('/staff/providers');
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  test('an owner can change policy and it persists', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/settings');

    await page.getByLabel('Booking horizon (days)').fill('75');
    await page.getByLabel('No-show threshold').fill('4');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Booking horizon (days)')).toHaveValue('75');
    await expect(page.getByLabel('No-show threshold')).toHaveValue('4');
  });

  // The D-11/D-19 trap the operator found (R-3), asserted through the UI: the
  // owner must be STOPPED, and told which setting is the problem.
  test('refuses a cancellation cutoff longer than the lead time, next to the field', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/settings');

    await page.getByLabel('Minimum lead time (minutes)').fill('60');
    await page.getByLabel('Cancellation cutoff (minutes)').fill('1440');
    await page.getByRole('button', { name: 'Save settings' }).click();

    const cutoff = page.getByLabel('Cancellation cutoff (minutes)');
    await expect(cutoff).toHaveAttribute('aria-invalid', 'true');
    // Target the ERROR element by id, not by text: the field's help text
    // deliberately explains the same rule, so a text locator matches both and
    // would pass even if only the hint were present.
    const error = page.locator('#cancellationCutoffMinutes-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('already unable to cancel');
    // ...and the input actually points at it for a screen reader.
    await expect(cutoff).toHaveAttribute('aria-describedby', /cancellationCutoffMinutes-error/);
    await expect(page.getByText('Settings saved.')).toHaveCount(0);

    // And nothing was written.
    await page.reload();
    await expect(page.getByLabel('Minimum lead time (minutes)')).not.toHaveValue('60');
  });

  test('an owner can add, deactivate and reactivate a provider', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/providers');

    await page.getByLabel('Add a provider').fill('Dana');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Dana')).toBeVisible();

    await page.getByRole('button', { name: 'Deactivate' }).first().click();
    await expect(page.getByText('Not taking bookings')).toBeVisible();

    // Deactivation is not deletion — she is still listed.
    await expect(page.getByText('Dana')).toBeVisible();

    await page.getByRole('button', { name: 'Reactivate' }).first().click();
    await expect(page.getByText('Not taking bookings')).toHaveCount(0);
  });

  /**
   * A-041 (operator P-8). `listDeactivationImpact` was built by A-019 and had
   * ZERO callers — deactivating used to grey a row and warn nobody, so
   * forty stranded appointments surfaced only when somebody happened to open
   * the conflicts screen. Now a two-step confirm, with the actual list.
   */
  test('deactivating a provider with future appointments requires confirmation and lists who is affected', async ({
    page,
  }) => {
    let providerId = '';
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const zone = zoneId(business.timezone);
      const provider = await prisma.provider.create({
        data: { businessId: business.id, displayName: 'Dana', displayOrder: 0 },
      });
      providerId = provider.id;
      const service = await prisma.service.create({
        data: { businessId: business.id, name: 'Cut', durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, priceCents: 5500 },
      });
      const client = await prisma.client.create({
        data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' },
      });

      const day = addDays(calendarDay(toLabel(fromDate(new Date()), zone).day), 30);
      const start = resolve(day, wallTime('14:00'), zone);
      const end = resolve(day, wallTime('14:45'), zone);
      if (start.kind !== 'unique' || end.kind !== 'unique') throw new Error('fixture day is not a unique instant');

      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: provider.id,
          clientId: client.id,
          startAt: toDate(start.at),
          endAt: toDate(end.at),
          blockedStart: toDate(start.at),
          blockedEnd: toDate(end.at),
          startDay: day,
          startWallTime: '14:00',
          status: 'booked',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await signIn(page);
    await page.goto('/staff/providers');

    await page.getByRole('button', { name: 'Deactivate' }).click();

    // Refused with the LIST, not a bare count — client, phone, date, service.
    await expect(page.getByText('1 future appointment is booked with her.')).toBeVisible();
    await expect(page.getByText('Ada Chen')).toBeVisible();
    await expect(page.getByText('5125550101')).toBeVisible();
    await expect(page.getByText('Not taking bookings')).toHaveCount(0);

    await page.getByRole('button', { name: 'Deactivate anyway' }).click();
    await expect(page.getByText('Not taking bookings')).toBeVisible();

    const prisma2 = new PrismaClient();
    try {
      const updated = await prisma2.provider.findUniqueOrThrow({ where: { id: providerId } });
      expect(updated.active).toBe(false);
      // The confirm is about the WRITE, not the appointment — nothing about
      // it changed underneath the deactivation.
      const appointment = await prisma2.appointment.findFirstOrThrow({ where: { providerId } });
      expect(appointment.status).toBe('booked');
    } finally {
      await prisma2.$disconnect();
    }
  });

  test('refuses a blank provider name', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/providers');
    // Bypass the browser's `required` so the SERVER-side check is what runs.
    //
    // Reached through the FIELD'S OWN `.form`, not `querySelector('form')`.
    // The old version meant "the first form in the document", which was this
    // one right up until A-085 put a client search box in the shell above every
    // staff screen — and then it silently marked the wrong form, `required`
    // blocked the submit, and the server-side check this test exists for never
    // ran. A locator that names what it wants cannot drift like that.
    await page.getByLabel('Add a provider').fill('x');
    await page.getByLabel('Add a provider').fill('');
    await page
      .getByLabel('Add a provider')
      .evaluate((el) => (el as HTMLInputElement).form?.setAttribute('novalidate', 'true'));
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('A provider needs a name.')).toBeVisible();
  });

  test('settings and providers pages have no serious accessibility violations', async ({ page }) => {
    await signIn(page);
    for (const path of ['/staff/settings', '/staff/providers']) {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious, `${path} has serious axe violations`).toEqual([]);
    }
  });
});
