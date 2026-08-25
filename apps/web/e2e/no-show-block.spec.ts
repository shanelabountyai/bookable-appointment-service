/**
 * A-020 — the no-show counters, the flags, and the block (CLIENT-04, D-27).
 *
 * The history is seeded RELATIVE TO TODAY rather than on fixed dates, because
 * the window is rolling: three no-shows pinned to March 2026 would drift out
 * of the last twelve months in March 2027 and this whole spec would quietly
 * stop testing the block while still passing the parts that do not need it.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

const OFFENDER = { name: 'Ada Chen', phone: '5125550101' };
/** Someone with a clean record, to prove the block is not simply "everybody". */
const REGULAR = { name: 'Mei Chen', phone: '5125550102' };

let ZONE: string;
let TODAY: string;
/** The next Tuesday the seeded roster works — where the staff booking half of
 *  this spec puts its appointment. */
let DAY: string;

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

/**
 * `count` missed appointments in the recent past, one a month, straight into
 * the database.
 *
 * Directly rather than through the write path on purpose: these are in the
 * past, which booking refuses by design (`in-the-past`), and marking them
 * through the UI would be forty clicks of setup in front of the thing under
 * test. Each lands on its own day — a no-show still OCCUPIES its time (D-7),
 * so three on one afternoon would collide with the exclusion constraint.
 */
async function seedMisses(client: { name: string; phone: string }, count: number, status = 'no_show') {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const provider = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const record = await prisma.client.create({
      data: { businessId: business.id, name: client.name, phone: client.phone },
    });

    for (let index = 1; index <= count; index += 1) {
      const day = addDays(calendarDay(TODAY), -30 * index);
      const resolved = resolve(day, wallTime('15:00'), zoneId(ZONE));
      // A gap day is not worth handling here: 15:00 exists on every day of
      // the year in a salon's zone. Failing loudly beats silently seeding
      // nothing and reporting "not blocked".
      if (resolved.kind !== 'unique') throw new Error(`15:00 is not unique on ${day}`);
      const startAt = toDate(resolved.at);
      // 45 minutes as a DURATION on the physical axis, never a wall-clock
      // label arithmetic'd by hand.
      const endAt = toDate(instant(resolved.at + 45 * 60_000));

      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: provider.id,
          clientId: record.id,
          status: status as 'no_show',
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
    }
    return record.id;
  } finally {
    await prisma.$disconnect();
  }
}

/** An ordinary future appointment, so she appears on a day grid at all. */
async function bookOn(day: string, clientId: string) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const provider = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const resolved = resolve(calendarDay(day), wallTime('10:00'), zoneId(ZONE));
    if (resolved.kind !== 'unique') throw new Error(`10:00 is not unique on ${day}`);
    const startAt = toDate(resolved.at);
    const endAt = toDate(instant(resolved.at + 45 * 60_000));

    return await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: provider.id,
        clientId,
        startAt,
        endAt,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: day,
        startWallTime: '10:00',
        lines: {
          create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
        },
      },
    });
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
    TODAY = toLabel(fromDate(new Date()), zoneId(ZONE)).day;
    let day = calendarDay(TODAY);
    do {
      day = addDays(day, 1);
    } while (weekdayOf(day) !== 2);
    DAY = day;
  } finally {
    await prisma.$disconnect();
  }
});

test.describe('the flag on the staff surfaces (CLIENT-04)', () => {
  test('the client record names the count, the window and every appointment behind it', async ({ page }) => {
    await seedMisses(OFFENDER, 2);
    await seedMisses(REGULAR, 0);
    await signIn(page);

    await page.goto('/staff/clients?q=Ada');
    // On the SEARCH RESULT, before anybody clicks in.
    await expect(page.getByText(/⚑ 2 no-shows in the last 12 months/)).toBeVisible();

    await page.getByRole('link', { name: /Ada Chen/ }).click();

    const missed = page.getByRole('region', { name: 'Missed appointments' });
    await expect(missed).toBeVisible();
    // The working, not just the number: two references, each a link to the
    // appointment whose log says who marked it (APPT-06).
    await expect(missed.getByRole('link')).toHaveCount(2);
  });

  test('says so on the appointment itself, and links to her record', async ({ page }) => {
    const clientId = await seedMisses(OFFENDER, 3);
    await signIn(page);

    const prisma = new PrismaClient();
    let appointmentId: string;
    try {
      appointmentId = (
        await prisma.appointment.findFirstOrThrow({ where: { clientId }, orderBy: { startAt: 'desc' } })
      ).id;
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/appointments/${appointmentId}`);
    const flag = page.getByRole('link', { name: /3 no-shows in the last 12 months/ });
    await expect(flag).toBeVisible();
    await flag.click();
    await expect(page).toHaveURL(new RegExp(`/staff/clients/${clientId}$`));
  });

  /** The day grid is a client surface too — and the one where the desk decides
   *  who to ring this morning. */
  test('carries the flag on the day-grid chip', async ({ page }) => {
    const clientId = await seedMisses(OFFENDER, 3);
    await bookOn(DAY, clientId);
    await signIn(page);

    await page.goto(`/staff/day?day=${DAY}`);
    const chip = page.getByRole('link', { name: /Ada Chen/ });
    // In the chip's accessible NAME as well as on its face: the flag must
    // reach a screen reader, not only an eye scanning for amber.
    await expect(chip).toHaveAttribute('aria-label', /3 no-shows in the last 12 months/);
    await expect(page.getByText(/⚑ 3 no-shows in the last 12 months/)).toBeVisible();
  });

  test('shows nothing at all for a client with a clean record', async ({ page }) => {
    await seedMisses(REGULAR, 0);
    await signIn(page);

    await page.goto('/staff/clients?q=Mei');
    await expect(page.getByRole('link', { name: /Mei Chen/ })).toBeVisible();
    // Absence asserted on the WORDING, not on a count of amber elements: a
    // "no flag" test that passes because the selector is wrong is worthless.
    await expect(page.getByText(/no-shows in the last 12 months/)).toHaveCount(0);
  });

  test('has no accessibility violations with the flag showing', async ({ page }) => {
    const clientId = await seedMisses(OFFENDER, 3);
    await signIn(page);

    await page.goto(`/staff/clients/${clientId}`);
    await expect(page.getByRole('region', { name: 'Missed appointments' })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('the self-serve block (CLIENT-04)', () => {
  /** The whole point of the lever: she is sent to the phone, not refused a
   *  time and left to try another one. */
  test('tells a blocked client to call the salon, and books nothing', async ({ page }) => {
    await seedMisses(OFFENDER, 3);

    await bookAsCustomer(page, OFFENDER);

    await expect(page.getByText(/call the salon/i)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      expect(await prisma.appointment.count({ where: { status: 'booked' } })).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('lets a client one below the threshold book as normal', async ({ page }) => {
    await seedMisses(OFFENDER, 2);

    await bookAsCustomer(page, OFFENDER);

    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();
  });
});

test.describe('the staff bypass (D-27)', () => {
  test('books her from the desk anyway, and the log says it was over the flag', async ({ page }) => {
    await seedMisses(OFFENDER, 3);
    await signIn(page);

    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: /Book \d+ minutes free/ }).first().click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    await page.getByLabel('Find a client by name or phone number').fill('0101');
    // The flag is on the picker itself — the moment the desk is choosing her,
    // not one screen later.
    await expect(page.getByText(/⚑ 3 no-shows in the last 12 months\. She cannot book online/)).toBeVisible();
    await page.getByRole('button', { name: /Ada Chen/ }).click();

    // One tap. No reason to type: the desk is on the phone with her (D-27).
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow({ where: { status: 'booked' } });
      await page.goto(`/staff/appointments/${appointment.id}`);
    } finally {
      await prisma.$disconnect();
    }

    await expect(page.getByText(/Booked over the no-show flag \(3 in the last 12 months\)/)).toBeVisible();
  });
});

/** The customer flow, end to end, with a given identity. */
/**
 * The customer flow, WAITING FOR EACH STEP TO ARRIVE before clicking the next.
 *
 * Every step of `/book` draws the same `fieldset ul > li > button` list, so
 * clicking straight through resolves the selector against whichever step is on
 * screen at that instant — and a click sent while React is swapping steps is
 * simply lost. This failed intermittently on the time click, with the page
 * left sitting on "Step 4 of 5" and no error anywhere.
 *
 * NOT fixed with a retry: a click that is re-sent until it lands is a test
 * that passes for the wrong reason. `booking.spec.ts` and `manage.spec.ts`
 * have waited on the step heading since A-048 and this file never learned to
 * — the same omission A-048 recorded as still outstanding, found here.
 */
async function bookAsCustomer(page: Page, who: { name: string; phone: string }) {
  await page.goto('/book');
  await page.getByRole('button', { name: /^Cut 45 min/ }).click();
  // A-058 made the service step multi-select, so choosing is no longer the
  // same thing as advancing.
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Dana', exact: true }).click();
  const firstOption = () => page.locator('fieldset ul > li > button').first();

  await expect(page.getByRole('group')).toContainText('Which day suits you?');
  await firstOption().click();
  await expect(page.getByRole('group')).toContainText('What time on');
  await firstOption().click();

  await page.getByLabel('Your name').fill(who.name);
  await page.getByLabel('Phone').fill(who.phone);
  await page.getByRole('button', { name: 'Confirm appointment' }).click();
}
