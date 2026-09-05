/**
 * A-033 — the front desk moves an appointment (APPT-05, D-6).
 *
 * The regression this spec exists for is not "the move works" — A-014's suite
 * already proves the write path. It is the SECOND assertion: a staff move
 * leaves no `cancelled_late` anywhere. Before this screen existed, the only
 * way for the desk to answer "push my 3 o'clock to 4" was cancel-and-rebook,
 * and A-012 correctly recorded that against a client who did nothing wrong.
 * A future refactor that quietly routes this through cancel-then-book would
 * pass every other test in the repo and fail here.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { addDays, calendarDay, fromDate, toLabel, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

/** A Tuesday well clear of anything the customer flow will pick for itself —
 *  so "move it" is genuinely a different day and can never collide with the
 *  `already-at-that-time` refusal. */
let TARGET_DAY: string;

test.beforeEach(async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
    const business = await prisma.business.findFirstOrThrow();
    let day = calendarDay(toLabel(fromDate(new Date()), zoneId(business.timezone)).day);
    do {
      day = addDays(day, 1);
    } while (weekdayOf(day) !== 2); // Tuesday, which the seeded roster works
    TARGET_DAY = addDays(day, 7);
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

/**
 * Books through the CUSTOMER flow, so the appointment has a real client and a
 * real manage link — the link is taken from the outbox row the salon actually
 * sent, never minted here (the discipline A-013's spec established).
 */
async function bookAsCustomer(page: Page): Promise<{ appointmentId: string; manageUrl: string; startAt: Date }> {
  await page.goto('/book');
  await page.getByRole('button', { name: /^Cut 45 min/ }).click();
  // A-058 made the service step multi-select, so choosing is no longer the
  // same thing as advancing.
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Dana', exact: true }).click();
  // SCOPED TO EACH STEP'S OWN FIELDSET, by its legend. A bare
  // `fieldset ul > li > button` matches the day list and the time list alike,
  // so the second click can land on a day button again before the times have
  // rendered — which failed one run in four here before this was pinned.
  await page.getByRole('group', { name: 'Which day suits you?' }).getByRole('button').first().click();
  await page.getByRole('group', { name: /^What time on/ }).getByRole('button').first().click();
  await page.getByLabel('Your name').fill('Ada Chen');
  await page.getByLabel('Phone').fill('(512) 555-0101');
  await page.getByRole('button', { name: 'Confirm appointment' }).click();
  await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

  const prisma = new PrismaClient();
  try {
    const appointment = await prisma.appointment.findFirstOrThrow();
    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'appointment.confirmed' },
    });
    return {
      appointmentId: appointment.id,
      manageUrl: (row.payload as { manageUrl: string }).manageUrl,
      startAt: appointment.startAt,
    };
  } finally {
    await prisma.$disconnect();
  }
}

/** Picks the LAST offered time on the target day and submits. Last rather
 *  than first for the same reason the target day is a week out: nothing here
 *  should depend on what the clock says when the suite runs. */
async function moveTo(page: Page, day: string) {
  await page.getByLabel('Move to which day?').fill(day);
  const times = page.locator('#move input[type="radio"]');
  await expect(times.first()).toBeVisible();
  await times.last().check();
  await page.getByRole('button', { name: 'Move this appointment' }).click();
}

test.describe('staff reschedule (A-033)', () => {
  test('moves the appointment, and records a reschedule rather than a late cancellation', async ({ page }) => {
    const booked = await bookAsCustomer(page);

    await page.goto(`/staff/appointments/${booked.appointmentId}`);
    await moveTo(page, TARGET_DAY);
    await expect(page.getByText(/^Moved\./)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const after = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.appointmentId } });
      expect(after.startDay).toBe(TARGET_DAY);
      expect(after.startAt.getTime()).not.toBe(booked.startAt.getTime());
      // THE ASSERTION THIS SPEC EXISTS FOR. Cancel-and-rebook was the
      // workaround; it must not be what the button does.
      expect(after.status).toBe('booked');
      const cancellations = await prisma.appointment.count({
        where: { status: { in: ['cancelled', 'cancelled_late'] } },
      });
      expect(cancellations).toBe(0);

      // One row, one history (D-6) — the appointment kept its id, so the event
      // log is where the old time still exists.
      const events = await prisma.appointmentEvent.findMany({ where: { appointmentId: booked.appointmentId } });
      expect(events.map((e) => e.type)).toContain('rescheduled');
      expect(await prisma.appointment.count()).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('the client’s existing link still works and shows the new time (TOKEN-02)', async ({ page }) => {
    const booked = await bookAsCustomer(page);

    await page.goto(`/staff/appointments/${booked.appointmentId}`);
    await moveTo(page, TARGET_DAY);
    await expect(page.getByText(/^Moved\./)).toBeVisible();

    // She is holding the message she was sent BEFORE the move. Re-pointing
    // rather than reissuing (TOKEN-02) is what keeps it working — reissuing
    // would kill her link at the exact moment she needs it.
    await page.goto(booked.manageUrl);
    await expect(page.getByRole('heading', { name: 'Your appointment' })).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const after = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.appointmentId } });
      await expect(page.getByText(after.startWallTime)).toBeVisible();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('offers no move for an appointment already in the chair', async ({ page }) => {
    const booked = await bookAsCustomer(page);

    const prisma = new PrismaClient();
    try {
      await prisma.appointment.update({ where: { id: booked.appointmentId }, data: { status: 'checked_in' } });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/appointments/${booked.appointmentId}`);
    // The panel is absent because the §7 table says so, not because this
    // screen has its own opinion — a second `if (status === ...)` on a surface
    // is the rental VERIFIED defect starting over.
    await expect(page.getByRole('heading', { name: 'Move this appointment' })).toHaveCount(0);
  });

  /**
   * A-038 (D-31) — the move that changes the stylist AND the time, which is
   * the one the two existing operations cannot compose between them.
   */
  test('moves her to another stylist and another time in one action', async ({ page }) => {
    const booked = await bookAsCustomer(page);

    await page.goto(`/staff/appointments/${booked.appointmentId}`);
    await page.getByLabel('With whom?').selectOption({ label: 'Priya' });
    await moveTo(page, TARGET_DAY);
    await expect(page.getByText(/^Moved\./)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const after = await prisma.appointment.findUniqueOrThrow({
        where: { id: booked.appointmentId },
        include: { provider: true },
      });
      expect(after.provider.displayName).toBe('Priya');
      expect(after.startDay).toBe(TARGET_DAY);

      // Both events, in one transaction — the log is what the desk reads back,
      // and the stylist change is the half the client rings about.
      const events = await prisma.appointmentEvent.findMany({ where: { appointmentId: booked.appointmentId } });
      expect(events.map((e) => e.type)).toContain('provider_changed');
      expect(events.map((e) => e.type)).toContain('rescheduled');
      expect(await prisma.appointment.count()).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    const booked = await bookAsCustomer(page);
    await page.goto(`/staff/appointments/${booked.appointmentId}`);
    await page.getByLabel('Move to which day?').fill(TARGET_DAY);
    await expect(page.locator('#move input[type="radio"]').first()).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
