/**
 * A-018 — running late and pushing the column (APPT-03, APPT-04, D-22).
 *
 * The day is computed forward to the next Tuesday the seeded roster works:
 * pushing a column rewrites `startAt`, and a past day would be refused for the
 * same reason booking one is.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

let DAY: string;
let ZONE: string;

/** A wall-clock time on the test's day, as an instant, through the one
 *  conversion module. */
function at(time: string): Date {
  const resolution = resolve(calendarDay(DAY), wallTime(time), zoneId(ZONE));
  if (resolution.kind !== 'unique') throw new Error(`${DAY} ${time} is not unique in ${ZONE}`);
  return toDate(resolution.at);
}

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

async function seedAppointments(times: string[]) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    for (const [index, time] of times.entries()) {
      const client = await prisma.client.create({
        data: { businessId: business.id, name: `Client ${index + 1}`, phone: `51255501${index}0` },
      });
      const startAt = at(time);
      const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          startAt,
          endAt,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: DAY,
          startWallTime: time,
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

test.beforeEach(async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
    const business = await prisma.business.findFirstOrThrow();
    ZONE = business.timezone;
    let day = calendarDay(toLabel(fromDate(new Date()), zoneId(ZONE)).day);
    do {
      day = addDays(day, 1);
    } while (weekdayOf(day) !== 2);
    DAY = day;
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('running late (A-018)', () => {
  /**
   * The Milestone 1 operator review's headline (R-1): the system could record
   * that an appointment RAN late but not that the day IS late — so the website
   * kept selling slots while the client sat in the waiting area.
   */
  test('marks a column behind, and the delta shows on the header', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('40');
    await dana.getByRole('button', { name: 'Set' }).click();

    await expect(page.getByText('+40 min')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.providerRunningLate.findFirstOrThrow();
      expect(row.minutes).toBe(40);
      // D-9: a claim somebody made, with their name on it.
      expect(row.setByActor).toBe('staff');
    } finally {
      await prisma.$disconnect();
    }
  });

  test('clears in one tap', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByText('+30 min')).toBeVisible();

    await page.getByRole('button', { name: 'Back on time' }).click();
    await expect(page.getByText('+30 min')).toHaveCount(0);

    const prisma = new PrismaClient();
    try {
      expect(await prisma.providerRunningLate.count()).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  /** APPT-03: the projected start, BESIDE the scheduled one — the client was
   *  booked for 14:00 and her confirmation still says so. */
  test('projects revised starts down the column without moving anything', async ({ page }) => {
    await seedAppointments(['14:00']);
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();

    await expect(page.getByText('→ likely 14:30')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow();
      // The delta is a claim, not a rewrite (D-22).
      expect(appointment.startWallTime.trim()).toBe('14:00');
    } finally {
      await prisma.$disconnect();
    }
  });
});

test.describe('pushing the column (A-018)', () => {
  test('previews what would move, then moves it and tells the clients', async ({ page }) => {
    await seedAppointments(['14:00', '15:00']);
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    // The <details> summary, which is what carries the name — the group
    // element around it is unnamed.
    await dana.getByText('Push the column').click();
    await dana.getByLabel('Push by').fill('30');
    await dana.getByRole('button', { name: 'Preview' }).click();

    // Named before anything moves.
    await expect(dana.getByText(/14:00 → 14:30/)).toBeVisible();
    await expect(dana.getByText(/15:00 → 15:30/)).toBeVisible();

    await dana.getByLabel('Why?').fill('Dana is running behind');
    await dana.getByRole('button', { name: /^Move 2 and tell them$/ }).click();

    await expect(dana.getByText(/Moved 2 appointments\. 2 clients told\./)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
      expect(rows.map((r) => r.startWallTime.trim())).toEqual(['14:30', '15:30']);
      // APPT-04's notice: a column that moved without anybody being told is
      // the silent change Goal 2 forbids.
      expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.running_late' } })).toBe(2);
      // And it is on the record, with a reason.
      const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { type: 'column_pushed' } });
      expect(event.reason).toBe('Dana is running behind');
    } finally {
      await prisma.$disconnect();
    }
  });

  /** APPT-04 refuses silently-lossy shifts: all or nothing. */
  test('refuses the whole push when something would fall past closing', async ({ page }) => {
    await seedAppointments(['16:30']); // ends 17:15; Dana closes at 17:00... and a push makes it worse
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    // The <details> summary, which is what carries the name — the group
    // element around it is unnamed.
    await dana.getByText('Push the column').click();
    await dana.getByLabel('Push by').fill('60');
    await dana.getByRole('button', { name: 'Preview' }).click();

    await expect(dana.getByText(/would fall past closing/)).toBeVisible();
    // The confirm is unavailable, rather than available and then refused.
    await expect(dana.getByRole('button', { name: /^Move \d+ and tell them$/ })).toBeDisabled();

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow();
      expect(appointment.startWallTime.trim()).toBe('16:30');
    } finally {
      await prisma.$disconnect();
    }
  });

  test('has no accessibility violations with a column running late', async ({ page }) => {
    await seedAppointments(['14:00']);
    await page.goto(`/staff/day?day=${DAY}`);
    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByText('+30 min')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
