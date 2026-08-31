/**
 * A-062 — the printable day sheet.
 *
 * The sheet is `?sheet=1` on the same route, so most of it is an ordinary
 * screen assertion. Only the last test switches media, because only the last
 * test is about what the print stylesheet does.
 *
 * The day is pinned by `?day=` for the same reason as the grid spec — a sheet
 * spec that trusts the wall clock passes on a Tuesday and fails on a Sunday.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { instantFromIso, toDate } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

const at = (iso: string) => toDate(instantFromIso(iso));

/** A Tuesday the seeded roster works. */
const DAY = '2026-06-09';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

async function seedAppointment(options: {
  status?: string;
  name?: string;
  clientNotes?: string;
}) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({
      where: { displayName: 'Dana' },
    });
    const service = await prisma.service.findFirstOrThrow({
      where: { name: 'Cut' },
    });
    const client = await prisma.client.create({
      data: {
        businessId: business.id,
        name: options.name ?? 'Ada Chen',
        phone: '5125550101',
        notes: options.clientNotes ?? null,
      },
    });
    // `return await` — a bare return lets the `finally` disconnect Prisma
    // before the write lands.
    return await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        startAt: at('2026-06-09T10:00:00-05:00'),
        endAt: at('2026-06-09T10:45:00-05:00'),
        blockedStart: at('2026-06-09T10:00:00-05:00'),
        blockedEnd: at('2026-06-09T10:45:00-05:00'),
        startDay: DAY,
        startWallTime: '10:00',
        ...(options.status ? { status: options.status as 'booked' } : {}),
        lines: {
          create: {
            businessId: business.id,
            serviceId: service.id,
            ordinal: 0,
            priceCents: 5500,
            durationMinutes: 45,
          },
        },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function danaId(): Promise<string> {
  const prisma = new PrismaClient();
  try {
    return (
      await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } })
    ).id;
  } finally {
    await prisma.$disconnect();
  }
}

test.beforeEach(async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('the printable day sheet (A-062)', () => {
  test('is one tap from the day, and carries the client, phone, service and duration', async ({ page }) => {
    await seedAppointment({ clientNotes: 'Allergic to PPD.' });
    await page.goto(`/staff/day?day=${DAY}`);

    await page.getByRole('link', { name: 'Print sheet' }).click();
    await expect(page).toHaveURL(/sheet=1/);

    await expect(page.getByText('Ada Chen')).toBeVisible();
    // Services AND the phone number: the sheet is what the stylist rings from
    // when the client has not turned up and the desk is on the other line.
    await expect(page.getByText(/Cut.*5125550101/)).toBeVisible();
    await expect(page.getByText('10:00–10:45')).toBeVisible();
    await expect(page.getByText('45', { exact: true })).toBeVisible();
    // CLIENT-03's pinned note follows onto the paper — an allergy is a safety
    // surface wherever the day is being read.
    await expect(page.getByText('⚑ Allergic to PPD.')).toBeVisible();

    // The grid is REPLACED, not hidden behind it: one copy of the day in the
    // DOM, so no locator on this page ever resolves to two elements.
    await expect(page.getByRole('link', { name: /Ada Chen/ })).toBeHidden();
  });

  test('names the day IN FULL, so yesterday cannot be mistaken for today', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}&sheet=1`);

    // The year is the point: "Tuesday 9 June" alone is on the bin's sheet too.
    await expect(page.getByText(`Tuesday 9 June · ${DAY}`).first()).toBeVisible();
  });

  test('one page per stylist, or just the one when ?provider= is set', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}&sheet=1`);

    await expect(page.getByRole('heading', { name: 'Dana', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Priya', level: 2 })).toBeVisible();

    // And the door carries the stylist through, so she prints her own.
    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}`);
    await page.getByRole('link', { name: 'Print sheet' }).click();

    await expect(page.getByRole('heading', { name: 'Dana', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Priya', level: 2 })).toBeHidden();
  });

  test('a cancelled appointment is NOT on the sheet', async ({ page }) => {
    await seedAppointment({ status: 'cancelled' });
    const dana = await danaId();

    // The screen still shows it — "she cancelled" is what the desk needs.
    await page.goto(`/staff/day?day=${DAY}&provider=${dana}`);
    await expect(page.getByText('Ada Chen')).toBeVisible();

    // The paper does not: the sheet is who is COMING, and the filter is
    // `occupiesTime`, the same reader the busy set and the constraint derive
    // from — so a ninth status cannot drift onto it unnoticed.
    await page.goto(`/staff/day?day=${DAY}&provider=${dana}&sheet=1`);
    await expect(page.getByText('Ada Chen')).toBeHidden();
  });

  test('on paper, the screen’s controls are gone', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}&sheet=1`);
    await expect(page.getByRole('link', { name: 'Walk-in' })).toBeVisible();

    await page.emulateMedia({ media: 'print' });

    // A printed "Walk-in" button is ink, and a printed day-navigation bar is
    // a row of underlined words nobody can tap.
    await expect(page.getByRole('link', { name: 'Walk-in' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Dana', level: 2 })).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await seedAppointment({ clientNotes: 'Allergic to PPD.' });
    await page.goto(`/staff/day?day=${DAY}&sheet=1`);
    await expect(page.getByText('Ada Chen')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
