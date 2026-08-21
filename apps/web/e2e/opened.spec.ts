/**
 * A-043 — what's opened up (WAIT-02's missing entry point).
 *
 * The scenario the row is about, and the reason the pre-existing waitlist spec
 * could not catch the gap: that one starts on the cancelled appointment's own
 * detail page, which is the one thing the desk cannot get to on a Saturday
 * when the cancellation came in through a manage link. This one starts where
 * the desk actually is — the day grid — and never visits the appointment.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
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
  await expect(page).toHaveURL(/\/staff$/);
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
    const tab = page.getByRole('link', { name: 'Opened up (1)' });
    await expect(tab).toBeVisible();
    await tab.click();

    await expect(page).toHaveURL(/\/staff\/opened$/);
    // 45 minutes of body plus Cut's 10-minute after-buffer: what the
    // constraint actually let go of, not the body.
    await expect(page.getByText(/10:00 · 55 min/)).toBeVisible();
    await expect(page.getByText(/Cut · Dana/)).toBeVisible();
    // The other half of the errand: ring the client who just gave it back.
    await expect(page.getByRole('link', { name: '5125550100' })).toHaveAttribute('href', 'tel:5125550100');

    // …and into the matcher that has existed since A-023 with one door.
    await page.getByRole('link', { name: 'Who wants this slot?' }).click();
    await expect(page.getByRole('heading', { name: 'Who wants this slot?' })).toBeVisible();
    await expect(page.getByText(/Cut with Dana/)).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await cancelledCut({ day: DAY, time: '10:00' });
    await page.goto('/staff/opened');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
