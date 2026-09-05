/**
 * A-046 — the chair the desk can now see (RES-01, D-30).
 *
 * Before this item `grep -rn "hair" apps/web/app` returned two strings and
 * both were refusals: "stays: no chair free at the new time" and "Every Chair
 * is taken at that time". The room decided what could be booked and appeared
 * on no screen. These specs are the other direction — every place a chair is
 * now legible, and the one control that proves the requirement is data.
 *
 * `seedSetup` runs on an empty database (`fixtures.ts` TRUNCATEs first), so
 * this exercises the FIRST seed run — the configuration every real install
 * starts in, and the one checkpoint 3's dormant resource layer hid in.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { instant, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

const at = (iso: string) => toDate(instantFromIso(iso));

/** A Tuesday the seeded roster works. */
const DAY = '2026-06-09';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

/**
 * A whole-minute instant N days from the real clock.
 *
 * The retirement confirm counts holds whose ENVELOPE has not yet ended, so it
 * is one of the few things on this screen that genuinely depends on `now` — a
 * fixture pinned to the seeded Tuesday is in the past and correctly counts
 * zero, which is a green test asserting nothing. Floored to the minute because
 * the schema CHECKs that every stored instant lands on one.
 */
const MINUTE = 60_000;
function daysFromNow(days: number, extraMinutes = 0): Date {
  const at = Math.floor(Date.now() / MINUTE) * MINUTE + days * 24 * 60 * MINUTE + extraMinutes * MINUTE;
  return toDate(instant(at));
}

/** One booking in a known chair. Written straight to the database: the write
 *  path has its own suite, and this spec is about what the SCREEN says. */
async function seedSeatedAppointment(when?: { start: Date; end: Date }) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const chair = await prisma.resource.findFirstOrThrow({ where: { name: 'Chair 1' } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' },
    });
    const startAt = when?.start ?? at('2026-06-09T10:00:00-05:00');
    const endAt = when?.end ?? at('2026-06-09T10:45:00-05:00');
    const label = toLabel(instant(startAt.getTime()), zoneId(business.timezone));
    // `return await` — a bare return lets the `finally` disconnect Prisma
    // before the write lands.
    return await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        resourceId: chair.id,
        startAt,
        endAt,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: label.day,
        startWallTime: label.time,
        lines: {
          create: {
            businessId: business.id,
            serviceId: service.id,
            ordinal: 0,
            priceCents: 5500,
            durationMinutes: 45,
          },
        },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

test.beforeEach(async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('/staff/resources — the room the operator owns', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/resources');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('shows the seeded chairs, the capacity, and which services need one', async ({ page }) => {
    await page.goto('/staff/resources');

    await expect(page.getByRole('heading', { name: 'Chair' })).toBeVisible();
    await expect(page.getByText('4 in service.')).toBeVisible();
    // The requirement the seed writes and nothing else could read until now.
    await expect(page.getByText(/Required by .*Colour/)).toBeVisible();
    for (const name of ['Chair 1', 'Chair 2', 'Chair 3', 'Chair 4']) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
  });

  test('a fifth chair can be added, and the room grows', async ({ page }) => {
    await page.goto('/staff/resources');
    await page.getByLabel('Add a chair').fill('Chair 5');
    await page.getByRole('button', { name: 'Add' }).last().click();

    await expect(page.getByText('Chair 5', { exact: true })).toBeVisible();
    await expect(page.getByText('5 in service.')).toBeVisible();
  });

  test('retiring a chair with someone in it is confirmed, never silent', async ({ page }) => {
    await seedSeatedAppointment({ start: daysFromNow(7), end: daysFromNow(7, 45) });
    await page.goto('/staff/resources');

    const row = page.getByRole('listitem').filter({ hasText: 'Chair 1' });
    await row.getByRole('button', { name: 'Take out of service' }).click();

    // The count, before anything changes — the whole point of the step.
    await expect(page.getByText(/1 appointment is still booked into this one/)).toBeVisible();
    await expect(page.getByText('4 in service.')).toBeVisible();

    await page.getByRole('button', { name: 'Take it out anyway' }).click();
    // Exact, and scoped to the row: "Out of service" is a substring of every
    // other row's "Take out of service" button.
    await expect(row.getByText('Out of service', { exact: true })).toBeVisible();
    await expect(page.getByText('3 in service.')).toBeVisible();
  });

  test('has no axe violations', async ({ page }) => {
    await page.goto('/staff/resources');
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('the chair, where it binds', () => {
  test('the day grid carries a room strip with a track per chair', async ({ page }) => {
    await seedSeatedAppointment();
    await page.goto(`/staff/day?day=${DAY}`);

    const room = page.getByRole('region', { name: /Chairs — 4 in service/ });
    await expect(room).toBeVisible();
    // The client is in the strip as well as in Dana's column: two different
    // occupancies of the same hour, which is the whole reason the strip exists.
    await expect(room.getByRole('link', { name: /Chair 1, 10:00–10:45, Ada Chen with Dana/ })).toBeVisible();
  });

  // day-grid.spec.ts's axe pass covers the day with an EMPTY room, which is
  // what caught the strip's unreachable scroll box. This is the other half:
  // the strip with chairs, tracks and links actually in it.
  test('the day page with an occupied room has no axe violations', async ({ page }) => {
    await seedSeatedAppointment();
    await page.goto(`/staff/day?day=${DAY}`);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('the appointment detail says which chair she is in', async ({ page }) => {
    const appointment = await seedSeatedAppointment();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByText('Where')).toBeVisible();
    await expect(page.getByText('Chair 1', { exact: true })).toBeVisible();
  });

  test('the service form owns the requirement, and clearing it sticks', async ({ page }) => {
    await page.goto('/staff/services');

    const card = page.getByRole('listitem').filter({ hasText: 'Colour' }).first();
    await card.getByRole('group').filter({ hasText: 'Edit' }).getByText('Edit').click();

    const needs = card.getByLabel('Needs');
    await expect(needs).toHaveValue(/.+/); // the seeded chair requirement
    await needs.selectOption('');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByText('Service updated.')).toBeVisible();

    await page.reload();
    await card.getByRole('group').filter({ hasText: 'Edit' }).getByText('Edit').click();
    await expect(card.getByLabel('Needs')).toHaveValue('');
  });
});
