import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { PrismaClient } from '@bookable/db';
import { resetDatabase } from '@bookable/db/testing';
import { seedSetup } from '@bookable/db/settings';

/**
 * THE PUBLIC SITE (home, services, stylists, visit).
 *
 * What these actually guard is that nothing on the site is TYPED: the price
 * list, the roster, the qualification chips and the hours all come from the
 * same rows the desk works from. A marketing page that hardcodes "$55" passes
 * a screenshot review and lies the first Monday after a price rise, so every
 * assertion below reads the database and then asserts the page agrees with it.
 */
const prisma = new PrismaClient();

test.beforeEach(async () => {
  await seedSetup(prisma);
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the home page states the room it can actually promise', async ({ page }) => {
  const chairs = await prisma.resource.count({ where: { active: true } });
  const stylists = await prisma.provider.count({ where: { active: true } });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `${chairs} chairs, ${stylists} stylists, and nobody double-booked.`,
  );
});

test('the price list is the catalogue, not a copy of it', async ({ page }) => {
  const service = await prisma.service.findFirstOrThrow({
    where: { active: true, bookableOnline: true },
    orderBy: { displayOrder: 'asc' },
  });

  await page.goto('/services');
  const row = page.getByRole('listitem').filter({ hasText: service.name }).first();
  await expect(row).toContainText(`$${(service.priceCents / 100).toFixed(2)}`);
});

test('a desk-only service is offered, but not bookable online (A-058)', async ({ page }) => {
  const deskOnly = await prisma.service.findFirstOrThrow({ where: { bookableOnline: false } });

  await page.goto('/services');
  // Present — a catalogue without it tells the visitor we do not do it at all.
  const row = page.getByRole('listitem').filter({ hasText: deskOnly.name }).first();
  await expect(row).toContainText('Call us');
  // ...and NOT wearing a Book button, which is the whole meaning of the flag.
  await expect(row.getByRole('link', { name: 'Book' })).toHaveCount(0);
});

test('a stylist is listed with the services she is actually qualified for', async ({ page }) => {
  // Tess is the junior in the seed: cuts and blow-dries, no colour. If the site
  // listed her as a colourist the booking flow would refuse the visit (SVC-02)
  // and the client would have read the wrong thing here first.
  const tess = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Tess' } });
  const qualified = await prisma.serviceProvider.findMany({
    where: { providerId: tess.id },
    select: { service: { select: { name: true } } },
  });
  const names = qualified.map((q) => q.service.name);

  await page.goto('/stylists');
  const card = page.getByRole('listitem').filter({ hasText: 'Tess' }).first();
  for (const name of names) {
    await expect(card.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(card.getByText('Colour', { exact: true })).toHaveCount(0);
});

test('the visit page shows the real week, closed days included', async ({ page }) => {
  await page.goto('/visit');
  // The seed's business hours are Tue–Sat; Sunday and Monday are closed, and
  // "Closed" is a real answer the visitor standing at the door needs to read.
  await expect(page.getByRole('term').filter({ hasText: 'Sunday' })).toBeVisible();
  await expect(page.getByText('Closed').first()).toBeVisible();

  const closure = await prisma.dateOverride.findFirst({ where: { isClosed: true } });
  if (closure?.reason) await expect(page.getByText(closure.reason)).toBeVisible();
});

test('every marketing page carries one route to booking and no dead ends', async ({ page }) => {
  for (const path of ['/', '/services', '/stylists', '/visit']) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: 'Book a chair' }).first()).toBeVisible();
  }

  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Book a chair' }).click();
  await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();
});

test('the address and phone are the salon\u2019s row, and the tel: link dials', async ({ page }) => {
  const business = await prisma.business.findFirstOrThrow();
  // The seed gives the sample salon real-looking details; a site that typed
  // them would keep showing the old ones the week after the salon moves.
  await page.goto('/visit');
  await expect(page.getByRole('heading', { name: 'Where we are' })).toBeVisible();

  // Scoped to the <address> block: the footer carries the same street and the
  // same number on every page, so an unscoped locator resolves to two — the
  // A-062 failure again, this time in the spec rather than the page.
  const where = page.locator('address');
  await expect(where.getByText(business.addressLine!)).toBeVisible();

  // Digits only in the href, so "(312) 555-0184" is actually dialable.
  const tel = where.getByRole('link', { name: business.phone! });
  await expect(tel).toHaveAttribute('href', `tel:${business.phone!.replace(/[^\d+]/g, '')}`);
});

test('the front door answers on an install with no salon at all', async ({ page }) => {
  // THE REGRESSION THIS PINS: `/` is also Playwright's webServer readiness
  // probe, and the probe runs before any seed. A front door that threw on an
  // empty database returned 500, which the probe reads as "server not up" —
  // the whole sweep timed out after five minutes without running one test.
  // It is the right product behaviour independently: the first visitor to a
  // fresh install should read a sentence, not a stack trace.
  await resetDatabase(prisma);

  const response = await page.goto('/');
  expect(response?.status(), 'the front door must answer 2xx with no salon row').toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('not set up yet');
});

test('the site pages have no serious accessibility violations', async ({ page }) => {
  for (const path of ['/services', '/stylists', '/visit']) {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, `${path} has serious axe violations`).toEqual([]);
  }
});
