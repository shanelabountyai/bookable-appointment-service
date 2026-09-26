/**
 * A-043 — what's opened up (WAIT-02's missing entry point).
 *
 * The scenario the row is about, and the reason the pre-existing waitlist spec
 * could not catch the gap: that one starts on the cancelled appointment's own
 * detail page, which is the one thing the desk cannot get to on a Saturday
 * when the cancellation came in through a manage link. This one starts where
 * the desk actually is — the day grid — and never visits the appointment.
 *
 * A-067 added the second half: a cancellation was never the only thing that
 * frees time. The last scenario below is the one A-055's row claimed came for
 * free, and did not.
 */
import { expectNoAxeViolations } from './axe';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { changeVisitServices } from '@bookable/db/appointments';
import { staffActor } from '@bookable/core/auth';
import { seedSetup } from '@bookable/db/settings';
import {
  addDays,
  calendarDay,
  fromDate,
  instant,
  resolve,
  toDate,
  toLabel,
  wallTime,
  weekdayOf,
  zoneId,
} from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

let DAY: string;
let ZONE: string;

function at(day: string, time: string): Date {
  const resolution = resolve(calendarDay(day), wallTime(time), zoneId(ZONE));
  if (resolution.kind !== 'unique') throw new Error(`${day} ${time} is not unique in ${ZONE}`);
  return toDate(resolution.at);
}

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

/**
 * A Cut with Dana, on a future Tuesday, already CANCELLED — written straight
 * to the row's terminal state on purpose. The desk in this scenario did not do
 * the cancelling and has never seen this appointment; the whole point is that
 * the list finds it anyway.
 */
async function cancelledCut(options: { day: string; time: string }): Promise<string> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Cameron Gone', phone: '5125550100' },
    });

    const startAt = at(options.day, options.time);
    const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
    const appointment = await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        status: 'cancelled',
        startAt,
        endAt,
        // blockedStart/blockedEnd are TRIGGER-written from these buffers, so
        // the freed footprint the list reports is the real 55 minutes.
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 10,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: options.day,
        startWallTime: options.time,
        lines: {
          create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
        },
      },
    });
    return appointment.id;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A-067. A Cut + Colour with Dana that has just become a Cut — the add-on
 * dropped at the chair, exactly what A-055 built and what nothing then told
 * this screen about.
 *
 * Body 165 minutes and a 20-minute after-buffer means she HELD 10:00–13:05;
 * a Cut is 10:00–10:55. What that let go of is 10:55–13:05 — 130 minutes.
 */
async function shortenedColour(options: { day: string; time: string }): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const cut = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const colour = await prisma.service.findFirstOrThrow({ where: { name: 'Colour' } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Mrs Hall', phone: '5125550188' },
    });

    const startAt = at(options.day, options.time);
    const appointment = await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        status: 'booked',
        startAt,
        endAt: toDate(instant(fromDate(startAt) + 165 * 60_000)),
        // The FIRST line's before and the LAST line's after (VISIT-01), and
        // blockedStart/blockedEnd are trigger-written from them.
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 20,
        blockedStart: startAt,
        blockedEnd: toDate(instant(fromDate(startAt) + 165 * 60_000)),
        startDay: options.day,
        startWallTime: options.time,
        lines: {
          create: [
            { businessId: business.id, serviceId: cut.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
            { businessId: business.id, serviceId: colour.id, ordinal: 1, priceCents: 14000, durationMinutes: 120 },
          ],
        },
      },
    });

    // Through the real mutator, so the event this screen reads is the one
    // A-055 actually writes — a hand-written payload would prove nothing.
    await changeVisitServices(prisma, {
      businessId: business.id,
      appointmentId: appointment.id,
      serviceIds: [cut.id],
      now: new Date(),
      actor: staffActor('e2e'),
      audience: 'staff',
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A-124. A long visit with Dana, cancelled — the balayage-shaped hole the
 * operator measured. Body 165 with a 20-minute after-buffer, so it held
 * 10:00–13:05 and gave 185 minutes back.
 */
async function cancelledLongVisit(options: { day: string; time: string }): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const colour = await prisma.service.findFirstOrThrow({ where: { name: 'Colour' } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Marcy Dunn', phone: '5125550177' },
    });
    const startAt = at(options.day, options.time);
    await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        status: 'cancelled',
        startAt,
        endAt: toDate(instant(fromDate(startAt) + 165 * 60_000)),
        // A-098's rule: the buffers are set and the TRIGGER derives the
        // envelope. Writing `blockedEnd` by hand produces a row the product
        // cannot make.
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 20,
        blockedStart: startAt,
        blockedEnd: toDate(instant(fromDate(startAt) + 165 * 60_000)),
        startDay: options.day,
        startWallTime: options.time,
        lines: {
          create: { businessId: business.id, serviceId: colour.id, ordinal: 0, priceCents: 14000, durationMinutes: 165 },
        },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** A-124. The blow-dry the desk sold into the front of it — a live booking,
 *  because only a real row makes the remainder shorter than the range. */
async function soldInto(options: { day: string; time: string }): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const cut = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Wendy Soon', phone: '5125550166' },
    });
    const startAt = at(options.day, options.time);
    await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        status: 'booked',
        startAt,
        endAt: toDate(instant(fromDate(startAt) + 45 * 60_000)),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 10,
        blockedStart: startAt,
        blockedEnd: toDate(instant(fromDate(startAt) + 45 * 60_000)),
        startDay: options.day,
        startWallTime: options.time,
        lines: {
          create: { businessId: business.id, serviceId: cut.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
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
    const business = await prisma.business.findFirstOrThrow();
    ZONE = business.timezone;
    let day = calendarDay(toLabel(fromDate(new Date()), zoneId(ZONE)).day);
    do {
      day = addDays(day, 1);
    } while (weekdayOf(day) !== 2); // Tuesday, same as the roster's regular hours.
    DAY = day;
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe("what's opened up (A-043)", () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/opened');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('reaches the freed slot from the day grid without knowing which appointment cancelled', async ({ page }) => {
    await cancelledCut({ day: DAY, time: '10:00' });

    // TODAY's grid — never the Tuesday the slot is on. That is the whole
    // finding: the hole is drawn on Thursday, and nobody opens Thursday.
    await page.goto('/staff/day');
    const tab = page.getByRole('link', { name: 'Opened up 1' });
    await expect(tab).toBeVisible();
    await tab.click();

    await expect(page).toHaveURL(/\/staff\/opened$/);
    // 45 minutes of body plus Cut's 10-minute after-buffer: what the
    // constraint actually let go of, not the body.
    await expect(page.getByText(/10:00 · 55 min/)).toBeVisible();
    await expect(page.getByText(/Cut · Dana/)).toBeVisible();
    // The other half of the errand: ring the client who just gave it back.
    await expect(page.getByRole('link', { name: '+15125550100' })).toHaveAttribute('href', 'tel:+15125550100');

    // …and into the matcher that has existed since A-023 with one door.
    await page.getByRole('link', { name: 'Who wants this slot?' }).click();
    await expect(page.getByRole('heading', { name: 'Who wants this slot?' })).toBeVisible();
    // D-56 — THE SPAN, NOT THE SERVICE THAT FREED IT. This read "Cut with
    // Dana", which was the service the matcher filtered the waitlist on; it
    // filters on nothing of the sort now, and what is for sale is
    // fifty-five minutes of Dana's Tuesday. The minutes carried across from
    // the row on the previous screen are the assertion that matters — the
    // two halves have to agree, and the URL no longer carries a service for
    // them to agree about.
    await expect(page.getByText(/55 min free with Dana/)).toBeVisible();
  });

  /**
   * A-067. The claim in A-055's own backlog row was that this arrived "for
   * free, because it derives". It did not — the list asked the STATUS column
   * what had been freed, and a shortened visit is still `booked`. Ninety
   * minutes of a Saturday afternoon was invisible.
   */
  test('shows the tail of a visit shortened at the chair, in the desk\'s words', async ({ page }) => {
    await shortenedColour({ day: DAY, time: '10:00' });

    await page.goto('/staff/day');
    await page.getByRole('link', { name: 'Opened up 1' }).click();

    await expect(page).toHaveURL(/\/staff\/opened$/);
    // A-124/D-60 — 10:55 to 12:00, not to 13:05. She let go of 130 minutes
    // on paper, but Dana's lunch is 12:00–13:00 (the seed's mid-window break)
    // and lunch is not for sale; what came back that anybody can BUY is the
    // 65 minutes before it. The old 130 counted the break. The other half of
    // the note that follows:
    // what she let go of, buffer and all, not the 120
    // minutes of body the colour was worth.
    await expect(page.getByText(/10:55 · 65 min/)).toBeVisible();
    // WHAT freed it, because the phone call is a different call: you do not
    // offer Mrs Hall another time, she is still coming.
    await expect(page.getByText('Mrs Hall dropped the Colour')).toBeVisible();
    await expect(page.getByRole('link', { name: '+15125550188' })).toHaveAttribute('href', 'tel:+15125550188');

    // …and the span to ring the waitlist about is the one she GAVE BACK.
    // D-56: "Colour with Dana" is what this said, and naming the dropped
    // service was the matcher's filter. Two hours and ten minutes of a
    // Saturday is the thing being sold; who fits it is the fit's business.
    await page.getByRole('link', { name: 'Who wants this slot?' }).click();
    await expect(page.getByText(/1 hr 5 min free with Dana/)).toBeVisible();
  });

  /**
   * A-124 / D-60 — THE PARTIAL SALE, which is the move the desk makes RIGHT
   * and which took the rest of the afternoon off this screen.
   *
   * Cancel a long visit; sell a short one into the FRONT of what it gave back.
   * Before D-60 the row vanished entirely — `busy.length === 0` is
   * all-or-nothing, and one booking inside the range made "still empty" false
   * for the whole of it — while the day grid two tabs over drew the remaining
   * gap correctly and the write happily booked into it. On the operator's own
   * book that is a $180-class appointment lost to earn a $45 one, most
   * Saturdays.
   */
  test('keeps a partly sold row, and reports what is LEFT of it', async ({ page }) => {
    // 10:00, 165 minutes of body plus a 20-minute after-buffer: she held
    // 10:00–13:05, and cancelling gave all 185 minutes back.
    await cancelledLongVisit({ day: DAY, time: '10:00' });
    // …then a 45-minute Cut is sold into 10:00–10:55 (45 + the 10-minute
    // after-buffer). 10:55–12:00 is still Dana's to sell: the cancelled
    // colour ran across her 12:00 lunch, and lunch is not sellable time.
    await soldInto({ day: DAY, time: '10:00' });

    await page.goto('/staff/opened');
    // THE ROW IS STILL HERE, and it names the remainder rather than the
    // 185 minutes the cancelled row measures.
    await expect(page.getByText(/10:55 · 65 min/)).toBeVisible();
    await expect(page.getByText(/10:00 · 185 min/)).toHaveCount(0);

    await page.getByRole('link', { name: 'Who wants this slot?' }).click();
    await expect(page.getByText(/1 hr 5 min free with Dana/)).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await cancelledCut({ day: DAY, time: '10:00' });
    await page.goto('/staff/opened');
    await expectNoAxeViolations(page);
  });
});
