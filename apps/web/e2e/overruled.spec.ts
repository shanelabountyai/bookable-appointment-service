/**
 * A-060's list, and A-104's shape (RPT-01, APPT-06).
 *
 * `/staff/dashboard/overruled` was the ONE staff route with no e2e spec at
 * all, which is why A-087's fix — "no range is not an empty result" — was
 * applied to the room it was standing in and not to this one, eleven items
 * ago. The empty-state pair below is the assertion that keeps it shut: the
 * screen must say which question produced the zero, and must never answer a
 * question nobody asked in the reassuring direction.
 *
 * THE POPULATED CASE IS A GENUINE OVERRULE, written by `transitionAppointment`
 * with `cancellation: 'override'` inside the cutoff — the same call the escape
 * button makes. Scanning this route with an empty list is scanning the chrome.
 */
import { expectNoAxeViolations } from './axe';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { bookAppointment } from '@bookable/db/booking';
import { transitionAppointment } from '@bookable/db/appointments';
import { weekOf } from '@bookable/core/reports';
import { staffActor } from '@bookable/core/auth';
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

let DAY: string;
let ZONE: string;
/** The Monday–Sunday the dashboard's own link would carry (`weekOf`), so the
 *  range this spec types is the range the product produces. */
let FROM: string;
let TO: string;

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

/**
 * One cancellation the cutoff WOULD have called late, that somebody decided
 * not to. `now` is half an hour before the start and the seeded business asks
 * two hours' notice, so `'derive'` alone would write `cancelled_late` — which
 * is what makes `'override'` an overrule with something to overrule, and what
 * makes the event carry `overruled: 'cancelled_late'`.
 */
async function letOneOff(reason: string) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { businessId: business.id, displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { businessId: business.id, name: 'Cut' } });
    const owner = await prisma.staffUser.findFirstOrThrow({ where: { businessId: business.id } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' },
    });

    const start = at('10:00');
    const appointment = await bookAppointment(prisma, {
      businessId: business.id,
      providerId: dana.id,
      serviceIds: [service.id],
      clientId: client.id,
      startAt: start,
      now: toDate(instant(fromDate(start) - 3 * 60 * 60_000)),
      actor: staffActor(owner.id),
      audience: 'staff',
    });

    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      cancellation: 'override',
      actor: staffActor(owner.id),
      now: toDate(instant(fromDate(start) - 30 * 60_000)),
      reason,
    });
    return appointment;
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
    } while (weekdayOf(day) !== 2); // Tuesday, which the seeded roster works.
    DAY = day;
    ({ fromDay: FROM, toDay: TO } = weekOf(calendarDay(DAY)));
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('who was let off the late count (A-060)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/dashboard/overruled');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('lists the overrule with its reason, and who typed it', async ({ page }) => {
    await letOneOff('we moved her twice already');

    await page.goto(`/staff/dashboard/overruled?from=${FROM}&to=${TO}`);

    await expect(page.getByRole('link', { name: 'Ada Chen' })).toBeVisible();
    await expect(page.getByText('we moved her twice already')).toBeVisible();
    // The name is the whole point of the row: an escape nobody signs is a
    // cutoff that quietly stopped applying.
    await expect(page.getByText(/Let off by Front desk/)).toBeVisible();
    // And the reassurance is NOT on a screen that has a row on it.
    await expect(page.getByText(/None that week/)).toHaveCount(0);
  });

  test('reached with no week, it asks for one instead of answering about one', async ({ page }) => {
    // A-104. The whole defect: with a real overrule sitting in the book, the
    // bare URL said "None that week" underneath "Pick a week from the
    // dashboard" — reassurance about a week nobody had chosen, and a claim
    // about a query that was never run.
    await letOneOff('we moved her twice already');

    await page.goto('/staff/dashboard/overruled');

    await expect(page.getByText('Pick a week from the dashboard.')).toBeVisible();
    await expect(page.getByText(/None that week/)).toHaveCount(0);
    // The header sentence names a range too, so it goes with it.
    await expect(page.getByText(/Cancellations inside the cutoff/)).toHaveCount(0);
  });

  test('reached with a week and nothing let off, it says so about THAT week', async ({ page }) => {
    await page.goto(`/staff/dashboard/overruled?from=${FROM}&to=${TO}`);

    await expect(page.getByText(/None that week/)).toBeVisible();
    await expect(page.getByText('Pick a week from the dashboard.')).toHaveCount(0);
  });

  test('has no accessibility violations', async ({ page }) => {
    await letOneOff('we moved her twice already');
    await page.goto(`/staff/dashboard/overruled?from=${FROM}&to=${TO}`);

    // A-096: assert the interesting content is on screen BEFORE scanning. A
    // green run over an empty list is a green run over the chrome.
    await expect(page.getByRole('link', { name: 'Ada Chen' })).toBeVisible();
    await expectNoAxeViolations(page, { where: '/staff/dashboard/overruled' });
  });
});
