/**
 * A-029 — segmented durations, modeled and visible (SEG-01..03).
 *
 * The whole item in one arc: the owner splits a service into parts, the parts
 * carry the total with them, an override that would eat the processing gap is
 * refused, and a booked colour shows its free minutes on the day grid.
 *
 * What is deliberately NOT asserted: that the gap is bookable. It is not, in
 * A-029 — the exclusion constraint still defends the whole footprint, and a
 * constraint test (packages/db/constraint.test.ts) pins that. A-030, gated on
 * OQ-7, is where it changes.
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

function at(time: string): Date {
  const resolution = resolve(calendarDay(DAY), wallTime(time), zoneId(ZONE));
  if (resolution.kind !== 'unique') throw new Error(`${DAY} ${time} is not unique in ${ZONE}`);
  return toDate(resolution.at);
}

/**
 * A service's card, found by its name EXACTLY.
 *
 * `hasText: 'Colour'` is a substring match and case-insensitive, so it matches
 * every card on the page — the parts editor's own help text says "colour
 * developing". The services spec has the same warning about "Cut" matching
 * "Cancellation cutoff"; this is that trap a second time, from a string this
 * item added.
 */
function cardFor(page: Page, name: string) {
  return page.locator('li').filter({ has: page.getByText(name, { exact: true }) });
}

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

/** Dana's 10:00 Colour — the seeded three-part service (50 / 40 gap / 30). */
async function bookDanasColour(): Promise<string> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Colour' } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Robin Colour', phone: '5125550142' },
    });

    const startAt = at('10:00');
    const endAt = toDate(instant(fromDate(startAt) + 120 * 60_000));
    const appointment = await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        startAt,
        endAt,
        // blockedStart/blockedEnd are TRIGGER-written from these (D-16).
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 20,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: DAY,
        startWallTime: '10:00',
        lines: {
          create: {
            businessId: business.id,
            serviceId: service.id,
            ordinal: 0,
            priceCents: 14000,
            // D-18's snapshot. The segments are re-timed to THIS, not to the
            // service's current duration.
            durationMinutes: 120,
          },
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
    } while (weekdayOf(day) !== 2); // Tuesday, the roster's regular hours.
    DAY = day;
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('segmented durations (A-029)', () => {
  test('the seeded colour arrives already split, and says how much of it is a gap', async ({ page }) => {
    await page.goto('/staff/services');
    // "Parts (3, 40 min of it a gap)" — the summary is the fact at a glance.
    await expect(page.getByText('Parts (3, 40 min of it a gap)')).toBeVisible();
    // A cut is one duration and stays that way.
    await expect(page.getByText('Parts (one, 45 min)')).toBeVisible();
  });

  test('splitting a service writes the parts AND moves its total', async ({ page }) => {
    await page.goto('/staff/services');

    // Root touch-up is 90 minutes, unsegmented. Split it 30 / 25 gap / 30 —
    // which comes to 85, so the service's own duration has to follow.
    const card = cardFor(page, 'Root touch-up');
    await card.getByText('Parts (one, 90 min)').click();
    for (let i = 0; i < 3; i++) await card.getByRole('button', { name: 'Add a part' }).click();

    const minutes = card.getByRole('spinbutton', { name: /^Part \d minutes for Root touch-up$/ });
    await minutes.nth(0).fill('30');
    await minutes.nth(1).fill('25');
    await minutes.nth(2).fill('30');
    await card.getByRole('checkbox').nth(1).check();
    await card.getByRole('button', { name: 'Save parts' }).click();

    await expect(card.getByText('Parts saved.')).toBeVisible();
    await page.reload();
    const saved = cardFor(page, 'Root touch-up');
    await expect(saved.getByText('Parts (3, 25 min of it a gap)')).toBeVisible();
    // The total followed the parts — 85, not the 90 it was created with.
    await saved.getByText('Edit').click();
    await expect(saved.getByLabel('Duration (minutes)')).toHaveValue('85');
  });

  test('refuses a leading gap, in the words the owner needs', async ({ page }) => {
    await page.goto('/staff/services');
    const card = cardFor(page, 'Blow-dry');
    await card.getByText('Parts (one, 30 min)').click();
    for (let i = 0; i < 2; i++) await card.getByRole('button', { name: 'Add a part' }).click();
    await card.getByRole('checkbox').first().check();
    await card.getByRole('button', { name: 'Save parts' }).click();

    await expect(card.getByText(/cannot start or end with a gap/)).toBeVisible();
  });

  // SEG-02's rule, at the surface where it bites: the gap is chemistry and
  // never scales, so an override has to leave room for it.
  test('refuses a duration override that would eat the processing gap', async ({ page }) => {
    await page.goto('/staff/services');
    const card = cardFor(page, 'Colour');
    await card.getByText(/^Qualified providers/).click();

    const row = card.locator('li').filter({ has: page.getByText('Tess', { exact: true }) });
    await row.getByLabel('Duration override for Tess').fill('35');
    await row.getByRole('button', { name: 'Qualify' }).click();

    await expect(card.getByText(/40 minutes of processing time that never shortens/)).toBeVisible();
  });

  test('a booked colour shows its free minutes on the day grid and on the appointment', async ({ page }) => {
    const appointmentId = await bookDanasColour();

    await page.goto(`/staff/day?day=${DAY}`);
    // 50 minutes in, for 40 — the stripe and its label.
    await expect(page.getByText('40 min free').first()).toBeVisible();
    // And in the accessible name, which is the half a screen reader gets.
    await expect(page.getByRole('link', { name: /40 min free from 10:50/ })).toBeVisible();

    await page.goto(`/staff/appointments/${appointmentId}`);
    await expect(page.getByText('40 min of processing time — she is not needed for it')).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await bookDanasColour();
    for (const url of ['/staff/services', `/staff/day?day=${DAY}`]) {
      await page.goto(url);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    }
  });
});
