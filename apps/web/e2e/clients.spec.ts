/**
 * A-015 — the client record (CLIENT-01..03, D-17, operator R-10).
 *
 * Driven through the staff UI, because the interesting failures here are
 * interface failures: a lookup that silently collapses a household into one
 * person, or a merge whose direction is guessed from which page you opened.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { instantFromIso, toDate } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

/** Through the one conversion module, like everything else in this repo — the
 *  lint ban on `new Date(string)` applies to specs too, and for the same
 *  reason: it reads the string in the PROCESS timezone, and CI runs the suite
 *  under two. */
const at = (iso: string) => toDate(instantFromIso(iso));

const SHARED_PHONE = '5125550101';

test.beforeEach(async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
    const business = await prisma.business.findFirstOrThrow();
    // THE HOUSEHOLD (D-17): one number, two people.
    await prisma.client.createMany({
      data: [
        { businessId: business.id, name: 'Ada Chen', phone: SHARED_PHONE },
        { businessId: business.id, name: 'Mei Chen', phone: SHARED_PHONE },
      ],
    });
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
  await expect(page).toHaveURL(/\/staff$/);
}

async function search(page: Page, query: string) {
  await page.goto('/staff/clients');
  await page.getByLabel('Search by name or phone number').fill(query);
  await page.getByRole('button', { name: 'Search' }).click();
}

test.describe('the client record (A-015)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/clients');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  /**
   * D-17's whole reason for existing. A unique phone index would have made
   * these two one client — merged allergy notes and one shared no-show
   * counter — and the screen must show both.
   */
  test('a shared household number finds BOTH people', async ({ page }) => {
    await search(page, SHARED_PHONE);
    await expect(page.getByRole('link', { name: /Ada Chen/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Mei Chen/ })).toBeVisible();
  });

  test('finds someone by a partial name and by the last digits of a number', async ({ page }) => {
    await search(page, 'ada');
    await expect(page.getByRole('link', { name: /Ada Chen/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Mei Chen/ })).toHaveCount(0);

    await search(page, '0101');
    await expect(page.getByRole('link', { name: /Chen/ })).toHaveCount(2);
  });

  test('saves the pinned note (CLIENT-03)', async ({ page }) => {
    await search(page, 'Ada');
    await page.getByRole('link', { name: /Ada Chen/ }).click();

    await page.getByLabel('Pinned note').fill('Allergic to PPD. Bleach only.');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect(page.getByText('Note saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Pinned note')).toHaveValue('Allergic to PPD. Bleach only.');
  });

  /**
   * CLIENT-01's merge plus R-10's tombstone, end to end: the history moves,
   * both notes survive, and the losing record's number still lands on the
   * survivor afterwards.
   */
  test('merges a duplicate, keeps both notes, and the old number still finds her', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const duplicate = await prisma.client.create({
        data: { businessId: business.id, name: 'Ada Chenn', phone: '5125559999', notes: 'Allergic to PPD.' },
      });
      // A visit on the DUPLICATE, so "history follows the merge" is observable.
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: duplicate.id,
          startAt: at('2026-06-09T15:00:00.000Z'),
          endAt: at('2026-06-09T16:00:00.000Z'),
          blockedStart: at('2026-06-09T15:00:00.000Z'),
          blockedEnd: at('2026-06-09T16:00:00.000Z'),
          startDay: '2026-06-09',
          startWallTime: '10:00',
          status: 'no_show',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await search(page, 'Ada Chen');
    await page.getByRole('link', { name: /^Ada Chen /, exact: false }).first().click();

    await page.getByLabel('Pinned note').fill('Prefers the 2pm chair.');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect(page.getByText('Note saved.')).toBeVisible();

    await page.getByLabel('Find a duplicate record').fill('Chenn');
    await page.getByRole('button', { name: /^Merge into/ }).click();
    await expect(page.getByText(/Merged\. 1 appointment moved across/)).toBeVisible();

    await page.reload();
    // History followed the merge — including the no-show, which CLIENT-02
    // requires to be visible rather than tidied away.
    //
    // Scoped to the history section: A-020 put a "missed appointments" panel
    // on this page, so the same no-show now appears twice and BOTH are wanted.
    // The assertion says which one it means rather than the UI losing one.
    await expect(page.getByRole('region', { name: 'History' }).getByText('no show')).toBeVisible();
    // The safety note came across instead of being replaced.
    await expect(page.getByLabel('Pinned note')).toHaveValue(/Prefers the 2pm chair/);
    await expect(page.getByLabel('Pinned note')).toHaveValue(/Allergic to PPD/);

    // R-10: the merged-away number still finds the survivor.
    await search(page, '5125559999');
    await expect(page.getByText('Found through an old number that was merged into this record.')).toBeVisible();
  });

  /** CLIENT-02: prefills provider + service and starts the day list at her own
   *  interval, rather than at tomorrow. */
  test('rebook last visit opens the booking flow already filled in', async ({ page }) => {
    const prisma = new PrismaClient();
    let clientId = '';
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const client = await prisma.client.findFirstOrThrow({ where: { name: 'Ada Chen' } });
      clientId = client.id;
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          startAt: at('2026-06-09T15:00:00.000Z'),
          endAt: at('2026-06-09T15:45:00.000Z'),
          blockedStart: at('2026-06-09T15:00:00.000Z'),
          blockedEnd: at('2026-06-09T15:45:00.000Z'),
          startDay: '2026-06-09',
          startWallTime: '10:00',
          status: 'completed',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/clients/${clientId}`);
    await expect(page.getByText(/Cut with Dana/)).toBeVisible();
    await page.getByRole('link', { name: 'Rebook' }).click();

    // Straight to the day list: the service and the stylist are already
    // chosen, so the flow opens on step 3 rather than step 1.
    await expect(page.getByRole('group')).toContainText('Which day suits you?');
  });

  /**
   * A-039: Mrs. Hall rings to move an appointment she can see right here —
   * this used to be plain text with nowhere to click, so the desk had to
   * read the date off the screen and walk the day grid to it one day at a
   * time. Split into Upcoming/Past, and every row links to the appointment.
   */
  test('the future appointment is separated from the past and links to it', async ({ page }) => {
    const prisma = new PrismaClient();
    let clientId = '';
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const client = await prisma.client.findFirstOrThrow({ where: { name: 'Ada Chen' } });
      clientId = client.id;
      // One appointment behind "now" and one ahead of it — a decade in
      // either direction, so the split cannot pass by accident of when the
      // suite happens to run.
      await prisma.appointment.createMany({
        data: [
          {
            businessId: business.id,
            providerId: dana.id,
            clientId: client.id,
            startAt: at('2016-06-09T15:00:00.000Z'),
            endAt: at('2016-06-09T15:45:00.000Z'),
            blockedStart: at('2016-06-09T15:00:00.000Z'),
            blockedEnd: at('2016-06-09T15:45:00.000Z'),
            startDay: '2016-06-09',
            startWallTime: '10:00',
            status: 'completed',
          },
          {
            businessId: business.id,
            providerId: dana.id,
            clientId: client.id,
            startAt: at('2036-06-09T15:00:00.000Z'),
            endAt: at('2036-06-09T15:45:00.000Z'),
            blockedStart: at('2036-06-09T15:00:00.000Z'),
            blockedEnd: at('2036-06-09T15:45:00.000Z'),
            startDay: '2036-06-09',
            startWallTime: '10:00',
            status: 'booked',
          },
        ],
      });
      // `createMany` writes no lines, and the page reads `lines` for the
      // service list — a real visit always has at least one.
      const [past, future] = await prisma.appointment.findMany({
        where: { businessId: business.id, clientId: client.id },
        orderBy: { startAt: 'asc' },
      });
      await prisma.appointmentServiceLine.createMany({
        data: [past!, future!].map((appointment) => ({
          businessId: business.id,
          appointmentId: appointment.id,
          serviceId: service.id,
          ordinal: 0,
          priceCents: 5500,
          durationMinutes: 45,
        })),
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/clients/${clientId}`);

    const upcoming = page.getByRole('heading', { name: 'Upcoming' }).locator('..');
    await expect(upcoming.getByRole('link', { name: 'Details' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Past' })).toBeVisible();

    await upcoming.getByRole('link', { name: 'Details' }).click();
    await expect(page).toHaveURL(/\/staff\/appointments\//);
  });

  test('has no accessibility violations', async ({ page }) => {
    await search(page, 'Ada');
    await page.getByRole('link', { name: /Ada Chen/ }).click();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
