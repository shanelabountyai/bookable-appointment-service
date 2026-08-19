/**
 * A-024 — the owner dashboard (RPT-01, RPT-02, RPT-03).
 *
 * The exact frozen utilization constant is asserted at the DB layer
 * (`packages/db/reports/dashboard.test.ts`, against the real density seed);
 * this spec is about the screen — the tiles show the right numbers and every
 * one of them actually drills to the list it claims to.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { bookAppointment } from '@bookable/db/booking';
import { transitionAppointment } from '@bookable/db/appointments';
import { staffActor } from '@bookable/core/auth';
import { addDays, calendarDay, fromDate, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

let DAY: string; // a Tuesday, at least a day out
let ZONE: string;
let businessId: string;
let danaId: string;
let priyaId: string;
let cutId: string;
let clientId: string;

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

test.beforeEach(async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    const setup = await seedSetup(prisma);
    businessId = setup.businessId;
    const business = await prisma.business.findFirstOrThrow();
    ZONE = business.timezone;
    let day = calendarDay(toLabel(fromDate(new Date()), zoneId(ZONE)).day);
    do {
      day = addDays(day, 1);
    } while (weekdayOf(day) !== 2);
    DAY = day;

    const dana = await prisma.provider.findFirstOrThrow({ where: { businessId, displayName: 'Dana' } });
    const priya = await prisma.provider.findFirstOrThrow({ where: { businessId, displayName: 'Priya' } });
    const cut = await prisma.service.findFirstOrThrow({ where: { businessId, name: 'Cut' } });
    danaId = dana.id;
    priyaId = priya.id;
    cutId = cut.id;
    clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;

    const now = at('09:00');
    const book = (time: string, providerId: string) =>
      bookAppointment(prisma, {
        businessId,
        providerId,
        serviceIds: [cutId],
        clientId,
        startAt: at(time),
        now,
        actor: staffActor('seed'),
        audience: 'staff',
        idempotencyKey: `${DAY}-${time}-${providerId}`,
      });

    const completed = await book('09:00', danaId);
    for (const to of ['checked_in', 'in_progress', 'completed'] as const) {
      await transitionAppointment(prisma, { appointmentId: completed.id, to, actor: staffActor('seed'), now });
    }
    const cancelledLate = await book('11:00', danaId);
    await transitionAppointment(prisma, { appointmentId: cancelledLate.id, to: 'cancelled_late', actor: staffActor('seed'), now });
    const noShow = await book('09:00', priyaId);
    await transitionAppointment(prisma, { appointmentId: noShow.id, to: 'no_show', actor: staffActor('seed'), now: at('18:00') });
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('the owner dashboard (A-024)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/dashboard');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('shows the week\'s numbers, and every tile drills to the appointments behind it', async ({ page }) => {
    await page.goto(`/staff/dashboard?week=${DAY}`);

    await expect(page.getByText('Bookings')).toBeVisible();
    await expect(page.getByText('3', { exact: true })).toBeVisible(); // 3 booked this week
    await expect(page.getByText('0 on time · 1 late')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Priya: 1', exact: true })).toBeVisible();

    // The no-shows tile names Priya, and drills to exactly her no-show.
    await page.getByRole('link', { name: 'Priya: 1', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'no-show' })).toBeVisible();
    await expect(page.getByText('1 appointment', { exact: true })).toBeVisible();
    await expect(page.getByText('Ada Chen')).toBeVisible();

    // The cancellations tile drills to both the normal and the late one —
    // one row, which happened to be the late one.
    await page.goto(`/staff/dashboard?week=${DAY}`);
    await page.getByRole('link', { name: 'Cancellations' }).click();
    await expect(page.getByRole('heading', { name: 'cancelled, cancelled late' })).toBeVisible();
    await expect(page.getByText('1 appointment', { exact: true })).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto(`/staff/dashboard?week=${DAY}`);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
