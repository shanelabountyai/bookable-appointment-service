/**
 * A-023 — the waitlist, staff half (WAIT-01, WAIT-02).
 *
 * One scenario end to end: a client is waiting for a Cut with anyone on a
 * Tuesday; Dana's Tuesday Cut cancels; the front desk opens "who wants this
 * slot?" from the appointment, sees her, books her, and closes the entry out.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
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

/** Books Dana's 10:00 Cut, which the test then cancels. */
async function bookDanasCut(): Promise<string> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({ data: { businessId: business.id, name: 'Cameron Booked', phone: '5125550100' } });

    const startAt = at('10:00');
    const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
    const appointment = await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        startAt,
        endAt,
        // blockedStart/blockedEnd are TRIGGER-written from these buffer
        // columns (D-16) — Cut's own buffers, so the freed window the
        // trigger computes on cancel is the real 55-minute footprint, not
        // just the 45-minute body.
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 10,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: DAY,
        startWallTime: '10:00',
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

test.describe('the waitlist, staff half (A-023)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/waitlist');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('adds an entry, matches it against a freed slot, books and closes it out', async ({ page }) => {
    const appointmentId = await bookDanasCut();

    const beth = new PrismaClient();
    try {
      const business = await beth.business.findFirstOrThrow();
      await beth.client.create({ data: { businessId: business.id, name: 'Beth Waits', phone: '5125550199' } });
    } finally {
      await beth.$disconnect();
    }

    // A client waiting for a Cut with anyone, any Tuesday this month.
    await page.goto('/staff/waitlist');
    await page.getByPlaceholder('Name or phone number').fill('Beth');
    await page.getByRole('button', { name: /Beth Waits/ }).click();
    await page.getByLabel('Service').selectOption({ label: 'Cut' });
    // exact: true — "To" is otherwise a substring match of the Service
    // select's accessible name, which concatenates every option's text and
    // happens to include "touch-up" (Root touch-up).
    await page.getByLabel('From', { exact: true }).fill(DAY);
    await page.getByLabel('To', { exact: true }).fill(DAY);
    await page.getByRole('checkbox', { name: 'tuesday' }).check();
    await page.getByRole('button', { name: 'Add to waitlist' }).click();
    await expect(page.getByText('Added Beth Waits to the waitlist.')).toBeVisible();
    await expect(page.getByText(/^Waiting \(1\)/)).toBeVisible();

    // Dana's Cut cancels — the slot frees.
    await page.goto(`/staff/appointments/${appointmentId}`);
    await page.getByLabel('Reason').fill('Client rescheduled elsewhere');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // The success message and "cancelled, nothing more to do" both replace
    // the SAME form on the same render, so the message is a race — the link
    // only existing for a freeing status is the real signal cancelling
    // actually landed.
    const whoWants = page.getByRole('link', { name: 'Who wants this slot?' });
    await expect(whoWants).toBeVisible();
    await whoWants.click();

    await expect(page.getByText('Who wants this slot?')).toBeVisible();
    // She's named twice — once in the matched panel, once in the standing
    // queue below it (still active either way).
    await expect(page.getByText('Beth Waits').first()).toBeVisible();

    // She fits, and closing her entry out removes her from the standing queue.
    await page.getByRole('button', { name: 'Fulfilled' }).first().click();
    // Wait for the action to actually land — navigating away immediately
    // would abort the in-flight request.
    await expect(page.getByText('Nobody on the waitlist fits this one.')).toBeVisible();
    await page.goto('/staff/waitlist');
    await expect(page.getByText(/^Waiting \(0\)/)).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto('/staff/waitlist');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
