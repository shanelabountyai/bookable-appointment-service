/**
 * A-019 — the impact workflow (AVAIL-05, operator R-7, operator S-2).
 *
 * The whole spec is one scenario: Dana calls in sick with clients booked, and
 * nothing may happen to them that a person did not choose.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { createTimeOff } from '@bookable/db/availability';
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

let DAY: string;
let ZONE: string;

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
  await expect(page).toHaveURL(/\/staff\/day/);
}

/** Books Dana's morning, then sends her home sick. */
async function danaCallsInSick(times: string[] = ['10:00', '11:30']) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });

    for (const [index, time] of times.entries()) {
      const client = await prisma.client.create({
        data: { businessId: business.id, name: `Client ${index + 1}`, phone: `512555010${index}` },
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

    await prisma.timeOff.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        startAt: at('09:00'),
        endAt: at('17:00'),
        reason: 'off sick',
        createdByActor: 'staff',
        actorRef: 'staff-1',
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

test.describe('the impact workflow (A-019)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/conflicts');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  /**
   * The headline: recording the sick day ALWAYS succeeds, and the clients are
   * still booked afterwards. Nothing is silently cancelled, moved or hidden.
   */
  test('lists everyone stranded, with their phone numbers, all still booked', async ({ page }) => {
    await danaCallsInSick();
    await page.goto(`/staff/conflicts?day=${DAY}`);

    await expect(page.getByText('Client 1')).toBeVisible();
    await expect(page.getByText('Client 2')).toBeVisible();
    await expect(page.getByRole('link', { name: '5125550100' })).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const rows = await prisma.appointment.findMany();
      expect(rows.every((r) => r.status === 'booked')).toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('keeps one flagged, with the reason on the row', async ({ page }) => {
    await danaCallsInSick(['10:00']);
    await page.goto(`/staff/conflicts?day=${DAY}`);

    await page.getByLabel('Keep — why?').fill('Called her, coming anyway');
    await page.getByRole('button', { name: 'Keep' }).click();

    await expect(page.getByText('Kept — Called her, coming anyway')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findFirstOrThrow();
      expect(row.conflictAckAt).not.toBeNull();
      // Still booked: "keep-flagged" keeps it.
      expect(row.status).toBe('booked');
    } finally {
      await prisma.$disconnect();
    }
  });

  /** Operator R-7: the acknowledgment must not outlive the thing it
   *  acknowledged, or the next person re-rings clients already sorted. */
  test('drops the flag when the absence changes underneath it', async ({ page }) => {
    await danaCallsInSick(['10:00']);
    await page.goto(`/staff/conflicts?day=${DAY}`);
    await page.getByLabel('Keep — why?').fill('Called her');
    await page.getByRole('button', { name: 'Keep' }).click();
    await expect(page.getByText('Kept — Called her')).toBeVisible();

    // She is off for longer than we thought.
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      await createTimeOff(
        prisma,
        {
          businessId: business.id,
          providerId: dana.id,
          startAt: at('08:00'),
          endAt: at('18:00'),
          reason: 'still off',
        },
        { createdByActor: 'staff', actorRef: 'staff-1' },
      );
    } finally {
      await prisma.$disconnect();
    }

    await page.reload();
    await expect(page.getByText(/^Kept —/)).toHaveCount(0);
  });

  /** "Three reassigned to Priya, six kept-flagged" — partial by design. */
  test('reassigns the selected where qualified, and says what it could not move', async ({ page }) => {
    await danaCallsInSick(['10:00', '11:30']);
    await page.goto(`/staff/conflicts?day=${DAY}`);

    await page.getByRole('checkbox', { name: /Select Client 1/ }).check();
    await page.getByRole('checkbox', { name: /Select Client 2/ }).check();
    await page.getByLabel('To').selectOption({ label: 'Priya' });
    await page.getByLabel('Why move them?').fill('Dana off sick');
    await page.getByRole('button', { name: /^Move 2 where qualified$/ }).click();

    // THE PAGE IS THE FEEDBACK. Both moved, so there is nothing stranded any
    // more and the list — including the form that held the summary message —
    // is replaced by the empty state. Asserting the message would be a race
    // against that re-render.
    await expect(page.getByText(/Nothing stranded on/)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const priya = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Priya' } });
      const moved = await prisma.appointment.count({ where: { providerId: priya.id } });
      expect(moved).toBe(2);
      // APPT-07: a provider change is its own kind of event.
      expect(await prisma.appointmentEvent.count({ where: { type: 'provider_changed' } })).toBe(moved);
      // And nothing was cancelled to achieve it.
      expect(await prisma.appointment.count({ where: { status: 'booked' } })).toBe(2);
      // A-036: two clients moved to a different stylist, two clients told.
      expect(
        await prisma.notificationOutbox.count({ where: { template: 'appointment.provider_changed' } }),
      ).toBe(moved);
    } finally {
      await prisma.$disconnect();
    }
  });

  /** A-036 / D-32: the box is UNTICKED by default, so the silent cancellation
   *  needs a deliberate act. This is that act — the desk already rang her. */
  test('sends nothing when the desk says it already rang her', async ({ page }) => {
    await danaCallsInSick(['10:00']);
    await page.goto(`/staff/conflicts?day=${DAY}`);

    await page.getByLabel('Cancel — why?').fill('Salon closed, rebooking her');
    await page.getByLabel('Already rung her').check();
    await page.getByRole('button', { name: 'Cancel it' }).click();

    const prisma = new PrismaClient();
    try {
      await expect(async () => {
        const row = await prisma.appointment.findFirstOrThrow();
        expect(row.status).toBe('cancelled');
      }).toPass({ timeout: 10_000 });
      expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.cancelled' } })).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('cancels one, with a reason, and refuses to without one', async ({ page }) => {
    await danaCallsInSick(['10:00']);
    await page.goto(`/staff/conflicts?day=${DAY}`);

    await page.getByRole('button', { name: 'Cancel it' }).click();
    await expect(page.getByText(/Say why/)).toBeVisible();

    await page.getByLabel('Cancel — why?').fill('Salon closed, rebooking her');
    await page.getByRole('button', { name: 'Cancel it' }).click();

    const prisma = new PrismaClient();
    try {
      await expect(async () => {
        const row = await prisma.appointment.findFirstOrThrow();
        expect(row.status).toBe('cancelled');
      }).toPass({ timeout: 10_000 });
      const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { type: 'status_changed' } });
      expect(event.reason).toBe('Salon closed, rebooking her');
      // A-036: and she was told, with the desk's own words.
      const notice = await prisma.notificationOutbox.findFirstOrThrow({
        where: { template: 'appointment.cancelled' },
      });
      expect(notice.payload).toMatchObject({ reason: 'Salon closed, rebooking her' });
    } finally {
      await prisma.$disconnect();
    }
  });

  test('says so plainly when nothing is stranded', async ({ page }) => {
    await page.goto(`/staff/conflicts?day=${DAY}`);
    await expect(page.getByText(/Nothing stranded on/)).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await danaCallsInSick(['10:00']);
    await page.goto(`/staff/conflicts?day=${DAY}`);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
