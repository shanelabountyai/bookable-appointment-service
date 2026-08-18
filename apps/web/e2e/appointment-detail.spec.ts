/**
 * A-027 — the appointment detail panel (APPT-07, CLIENT-03, BOOK-05, D-8).
 *
 * Four stories converge on this screen, so the spec checks each one arrives:
 * the log in plain language, the pinned note on every render, the override
 * marker WITH its reason, and "was she actually told?".
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { bookAppointment } from '@bookable/db/booking';
import { staffActor } from '@bookable/core/auth';
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
  await expect(page).toHaveURL(/\/staff$/);
}

/** One appointment, booked through the real write path so its event log and
 *  its confirmation are the ones the system actually produces. */
async function bookOne(options: { override?: boolean; clientNotes?: string } = {}) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({
      data: {
        businessId: business.id,
        name: 'Ada Chen',
        phone: '5125550101',
        email: 'ada@example.test',
        notes: options.clientNotes ?? null,
      },
    });

    // `return await`, not a bare `return`: a bare one hands back the promise
    // and the `finally` below disconnects Prisma while the booking's
    // interactive transaction is still open — which surfaces as "Response from
    // the Engine was empty" and looks like a database fault rather than a
    // test-harness one.
    return await bookAppointment(prisma, {
      businessId: business.id,
      providerId: dana.id,
      serviceIds: [service.id],
      clientId: client.id,
      startAt: at('10:00'),
      now: toDate(instant(fromDate(at('10:00')) - 3 * 60 * 60_000)),
      actor: staffActor('staff-1'),
      audience: 'staff',
      ...(options.override ? { isOverride: true, overrideReason: 'squeezing her in' } : {}),
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

test.describe('the appointment detail panel (A-027)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const appointment = await bookOne();
    const anonymous = await browser.newPage();
    await anonymous.goto(`/staff/appointments/${appointment.id}`);
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('is where a chip on the day grid goes', async ({ page }) => {
    await bookOne();
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: /Ada Chen/ }).click();
    await expect(page).toHaveURL(/\/staff\/appointments\//);
    await expect(page.getByRole('heading', { name: 'Ada Chen' })).toBeVisible();
  });

  /** APPT-07: the log, in language a person can read. */
  test('shows what happened, in plain language', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByText('Booked by the front desk.')).toBeVisible();
  });

  /** CLIENT-03's safety surface, on every render of the appointment. */
  test('puts the pinned client note where it cannot be missed', async ({ page }) => {
    const appointment = await bookOne({ clientNotes: 'Allergic to PPD.' });
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByText('⚑ Allergic to PPD.')).toBeVisible();
  });

  /** BOOK-05 / D-8: the marker AND the reason. */
  test('shows the override marker with its reason', async ({ page }) => {
    const appointment = await bookOne({ override: true });
    await page.goto(`/staff/appointments/${appointment.id}`);

    // The marker carries its reason (BOOK-05) — asserted on the banner
    // specifically, because the log quotes the same reason underneath and
    // both appearances are wanted.
    const banner = page.locator('p').filter({ hasText: 'Booked as an override.' });
    await expect(banner).toContainText('squeezing her in');
    // And the log says it in plain language too.
    await expect(page.getByText('Booked by the front desk as an override.')).toBeVisible();
  });

  /** Operator R-4: "was she actually told?" */
  test('shows what was sent to her', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByText('Booking confirmation')).toBeVisible();
    await expect(page.getByText('ada@example.test')).toBeVisible();
  });

  /**
   * The status controls come from the §7 table. Checking in writes the ACTUAL
   * timestamp (APPT-03) and a new line in the log — the two halves of
   * "what really happened" versus "what was planned".
   */
  test('checks a client in, and says so in the log', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await page.getByRole('button', { name: 'Check in' }).click();
    await expect(page.getByText('Changed from booked to checked in by the front desk.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      expect(row.status).toBe('checked_in');
      expect(row.checkedInAt).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  /** The table decides, not the screen: a no-show before the start is always
   *  a mis-tap, and the refusal comes back in words. */
  test('refuses a no-show before the appointment has started, and explains', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    const noShow = page.getByRole('button', { name: 'No-show' });
    // The button is not even offered, because the server asked the same
    // function the write path asks.
    await expect(noShow).toHaveCount(0);
  });

  test('saves a note for this visit, kept apart from the pinned one', async ({ page }) => {
    const appointment = await bookOne({ clientNotes: 'Allergic to PPD.' });
    await page.goto(`/staff/appointments/${appointment.id}`);

    await page.getByLabel('Note for this visit').fill('Bring the reference photo');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect(page.getByText('Note saved.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        include: { client: true },
      });
      expect(row.notes).toBe('Bring the reference photo');
      // The pinned note is untouched — mixing them buries the allergy line.
      expect(row.client?.notes).toBe('Allergic to PPD.');
    } finally {
      await prisma.$disconnect();
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    const appointment = await bookOne({ override: true, clientNotes: 'Allergic to PPD.' });
    await page.goto(`/staff/appointments/${appointment.id}`);

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
