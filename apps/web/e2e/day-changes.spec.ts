/**
 * A-150 (C9, D-73) — "what changed on my column today", and how far the paper
 * has drifted.
 *
 * Events are written by hand with the DATABASE clock, which is the server's
 * "today" — so the marker shows whatever day is being viewed. The viewed day
 * is pinned by `?day=` like the grid and sheet specs.
 */
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { instantFromIso, toDate } from '@bookable/core/time';
import { expectNoAxeViolations } from './axe';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // a Tuesday the seeded roster works

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

async function withDb<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient();
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/** Ada's 10:00 Cut with Dana — the day-sheet spec's fixture. */
async function seedAda(): Promise<{ appointmentId: string; danaId: string }> {
  return withDb(async (prisma) => {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({ data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' } });
    const appointment = await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        startAt: at('2026-06-09T10:00:00-05:00'),
        endAt: at('2026-06-09T10:45:00-05:00'),
        blockedStart: at('2026-06-09T10:00:00-05:00'),
        blockedEnd: at('2026-06-09T10:45:00-05:00'),
        bufferBeforeMinutes: service.bufferBeforeMinutes,
        bufferAfterMinutes: service.bufferAfterMinutes,
        startDay: DAY,
        startWallTime: '10:00',
        lines: { create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 } },
      },
    });
    return { appointmentId: appointment.id, danaId: dana.id };
  });
}

/** An event as the writers would stamp it: the database clock, the signed-in staff user. */
async function logEvent(appointmentId: string, type: string, payload: object = {}) {
  await withDb(async (prisma) => {
    const staff = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
    await prisma.appointmentEvent.create({
      data: { businessId: staff.businessId, appointmentId, type, actor: 'staff', actorRef: staff.id, payload },
    });
  });
}

test.beforeEach(async ({ page }) => {
  await withDb((prisma) => seedSetup(prisma));
  await signIn(page);
});

test.describe('what changed on my column today (A-150)', () => {
  test('a move is marked on the chip and on the stylist’s list, and a status tap does not replace it', async ({ page }) => {
    const { appointmentId, danaId } = await seedAda();
    // From ANOTHER day: "Moved from another day" is the LONGEST short form,
    // so it is the one the chip-width assertion has to hold for.
    await logEvent(appointmentId, 'rescheduled', { from: '2026-06-08T15:00:00.000Z', to: '2026-06-09T15:00:00.000Z' });
    // OQ-24 (a): a status tap is not news, even when it is the newest event.
    await logEvent(appointmentId, 'checked_in');

    await page.goto(`/staff/day?day=${DAY}`);
    const chip = page.getByRole('link', { name: /Ada Chen/ });
    await expect(chip).toHaveAccessibleName(/Moved from Monday 8 June 10:00 · Front desk · \d{2}:\d{2}/);

    const marker = chip.getByTestId('chip-changed');
    await expect(marker).toHaveText('↻ Moved from another day');
    // A-120: `toBeVisible` is true of a clipped line; only widths can say it fits.
    const fit = await marker.evaluate((el) => ({ text: el.scrollWidth, room: el.clientWidth }));
    expect(fit.text, `the marker is cut off: ${fit.text} px in ${fit.room} px`).toBeLessThanOrEqual(fit.room);
    await expectNoAxeViolations(page);

    await page.goto(`/staff/day?day=${DAY}&provider=${danaId}`);
    await expect(page.getByText(/^↻ Moved from Monday 8 June 10:00 · Front desk · \d{2}:\d{2}$/)).toBeVisible();
  });

  test('nothing that counts, no marker', async ({ page }) => {
    const { appointmentId } = await seedAda();
    await logEvent(appointmentId, 'checked_in');

    await page.goto(`/staff/day?day=${DAY}`);
    await expect(page.getByRole('link', { name: /Ada Chen/ })).toBeVisible();
    await expect(page.getByTestId('chip-changed')).toHaveCount(0);
  });
});

test.describe('the paper and the screen (A-150)', () => {
  test('Print stamps the sheet, and the screen counts what changed after it', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __printed: number; print: () => void };
      w.__printed = 0;
      w.print = () => {
        w.__printed += 1;
      };
    });
    const { appointmentId, danaId } = await seedAda();
    await logEvent(appointmentId, 'booked');

    // Never printed: nothing claims a paper exists.
    await page.goto(`/staff/day?day=${DAY}&provider=${danaId}`);
    await expect(page.getByText(/^Printed/)).toHaveCount(0);

    await page.goto(`/staff/day?day=${DAY}&provider=${danaId}&sheet=1`);
    await page.getByRole('button', { name: 'Print' }).click();
    await expect(page.getByText(/Printed \d{2}:\d{2} by Front desk/)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);

    // The booking was before the print: the paper already has it.
    await page.goto(`/staff/day?day=${DAY}`);
    const dana = page.getByRole('region', { name: /Dana/ });
    await expect(dana.getByText(/^Printed \d{2}:\d{2}$/)).toBeVisible();
    await expect(dana.getByText(/changed since print/)).toHaveCount(0);

    // A move after it is a row the paper is now wrong about.
    await logEvent(appointmentId, 'column_pushed', { from: '2026-06-09T15:00:00.000Z', to: '2026-06-09T15:20:00.000Z', minutes: 20 });
    await page.reload();
    await expect(dana.getByText('· 1 changed since print')).toBeVisible();
  });
});
