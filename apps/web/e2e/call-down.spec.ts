/**
 * A-021 — the call-down list (APPT-02).
 *
 * Seeded relative to TODAY, same reason as A-020's no-show spec: "tomorrow"
 * is the window, and a fixed date would eventually stop being tomorrow.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

let ZONE: string;
let TOMORROW: string;

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

/** An appointment written directly, in whatever status, at 15:00 on the given
 *  day — off the write path because these are set up in the past-of-the-call
 *  relative to nothing in particular, just a fixed hour that exists everywhere. */
async function seed(client: { name: string; phone: string }, day: string, status = 'booked') {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const provider = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const record = await prisma.client.create({ data: { businessId: business.id, ...client } });

    const resolved = resolve(calendarDay(day), wallTime('15:00'), zoneId(ZONE));
    if (resolved.kind !== 'unique') throw new Error(`15:00 is not unique on ${day}`);
    const startAt = toDate(resolved.at);
    const endAt = toDate(instant(resolved.at + 45 * 60_000));

    await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: provider.id,
        clientId: record.id,
        status: status as 'booked',
        startAt,
        endAt,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: day,
        startWallTime: '15:00',
        lines: {
          create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
        },
      },
    });
    return record.id;
  } finally {
    await prisma.$disconnect();
  }
}

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
    const business = await prisma.business.findFirstOrThrow();
    ZONE = business.timezone;
    TOMORROW = addDays(toLabel(fromDate(new Date()), zoneId(ZONE)).day, 1);
  } finally {
    await prisma.$disconnect();
  }
});

test.describe('the call-down list (A-021)', () => {
  test('lists a booked-but-unconfirmed appointment tomorrow, with a phone link', async ({ page }) => {
    await seed({ name: 'Ada Chen', phone: '5125550101' }, TOMORROW);
    await signIn(page);

    await page.goto('/staff/call-down');
    await expect(page.getByText('Ada Chen')).toBeVisible();
    await expect(page.getByRole('link', { name: '5125550101' })).toHaveAttribute('href', 'tel:5125550101');
  });

  test('confirming from the list moves her off it', async ({ page }) => {
    await seed({ name: 'Ada Chen', phone: '5125550101' }, TOMORROW);
    await signIn(page);

    await page.goto('/staff/call-down');
    await page.getByRole('button', { name: 'Confirmed' }).click();
    await expect(page.getByText('Everybody tomorrow has confirmed, or there is nobody booked.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow();
      expect(appointment.status).toBe('confirmed');
      const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { type: 'status_changed' } });
      expect(event.actor).toBe('staff');
    } finally {
      await prisma.$disconnect();
    }
  });

  test('a client who already confirmed does not appear', async ({ page }) => {
    await seed({ name: 'Mei Chen', phone: '5125550102' }, TOMORROW, 'confirmed');
    await signIn(page);

    await page.goto('/staff/call-down');
    await expect(page.getByText('Everybody tomorrow has confirmed, or there is nobody booked.')).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await seed({ name: 'Ada Chen', phone: '5125550101' }, TOMORROW);
    await signIn(page);

    await page.goto('/staff/call-down');
    await expect(page.getByText('Ada Chen')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
