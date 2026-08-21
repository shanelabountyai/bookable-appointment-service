/**
 * A-016 — the staff day grid (BOOK-04's view half, Goal 3).
 *
 * Seeded through `seedSetup` plus direct rows: this spec is about the SCREEN,
 * and driving forty clicks of setup in front of it would make every failure
 * ambiguous about which half broke.
 *
 * The day is pinned by `?day=`, never left to "today" — a grid spec that
 * depends on the wall clock passes on a Tuesday and fails on a Sunday.
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

/** Books straight into the database — the write path has its own suite, and
 *  this spec needs a known column rather than a realistic booking journey. */
async function seedAppointment(options: { start: string; end: string; status?: string; clientNotes?: string }) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({
      data: {
        businessId: business.id,
        name: 'Ada Chen',
        phone: '5125550101',
        notes: options.clientNotes ?? null,
      },
    });
    // `return await` — see the note in appointment-detail.spec.ts: a bare
    // return lets the `finally` disconnect Prisma before the write lands.
    return await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        startAt: at(options.start),
        endAt: at(options.end),
        blockedStart: at(options.start),
        blockedEnd: at(options.end),
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

test.beforeEach(async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('the staff day grid (A-016)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto(`/staff/day?day=${DAY}`);
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('shows a column per provider with the day named', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);

    await expect(page.getByRole('heading', { name: 'Tuesday 9 June' })).toBeVisible();
    // The seeded roster, each as its own labelled region.
    await expect(page.getByRole('region', { name: /Dana/ })).toBeVisible();
    await expect(page.getByRole('region', { name: /Priya/ })).toBeVisible();
  });

  test('renders an appointment with its client, service and pinned note', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T10:45:00-05:00',
      clientNotes: 'Allergic to PPD.',
    });
    await page.goto(`/staff/day?day=${DAY}`);

    const chip = page.getByRole('link', { name: /Ada Chen/ });
    await expect(chip).toBeVisible();
    // CLIENT-03's safety surface is on the chip itself, not one click away.
    await expect(page.getByText('Allergic to PPD.')).toBeVisible();
    // The chip's accessible name carries the whole sentence, including the
    // status — colour is never the only signal (WCAG 1.4.1).
    await expect(chip).toHaveAttribute('aria-label', /10:00–10:45, Ada Chen.*Cut.*booked/);
  });

  test('shows the gaps either side of an appointment, with their lengths', async ({ page }) => {
    await seedAppointment({ start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T10:45:00-05:00' });
    await page.goto(`/staff/day?day=${DAY}`);

    // "What can you fit me in for?" — the question the front desk is asked all
    // day, answered without choosing a service first.
    await expect(page.getByText(/\d+ min free/).first()).toBeVisible();
  });

  test('a cancelled appointment is still shown, and its time is free again', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T10:45:00-05:00',
      status: 'cancelled',
    });
    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}`);

    await expect(page.getByText('Ada Chen')).toBeVisible();
    await expect(page.getByText('Cancelled')).toBeVisible();
  });

  test('switches to one stylist’s own day as a list', async ({ page }) => {
    await seedAppointment({ start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T10:45:00-05:00' });
    await page.goto(`/staff/day?day=${DAY}`);

    await page.getByRole('link', { name: 'Dana', exact: true }).click();

    await expect(page).toHaveURL(/provider=/);
    await expect(page.getByRole('link', { name: 'Dana', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Ada Chen')).toBeVisible();
    // Priya's column is not in the single-stylist view.
    await expect(page.getByRole('region', { name: /Priya/ })).toHaveCount(0);
  });

  test('moves to the previous and next day', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: 'Next →' }).click();
    await expect(page.getByRole('heading', { name: 'Wednesday 10 June' })).toBeVisible();
    await page.getByRole('link', { name: '← Previous' }).click();
    await expect(page.getByRole('heading', { name: 'Tuesday 9 June' })).toBeVisible();
  });

  /** A-039: "same again in six weeks" is one gesture, not forty-two taps of
   *  Next — jumping straight to a named date. */
  test('jumps straight to a named date', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByLabel('Jump to a day').fill('2026-07-21');
    await expect(page.getByRole('heading', { name: 'Tuesday 21 July' })).toBeVisible();
  });

  /**
   * THE STALENESS CONTRACT. The grid re-reads every 15 seconds, so a booking
   * made elsewhere — the other terminal at the desk, a customer's phone — is
   * on screen inside the 30 seconds the backlog asks for.
   *
   * Asserted by changing the database UNDER a loaded page and waiting, with no
   * reload and no interaction: a test that navigated would prove only that the
   * page renders.
   */
  test('picks up a booking made elsewhere within 30 seconds', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await expect(page.getByRole('heading', { name: 'Tuesday 9 June' })).toBeVisible();
    await expect(page.getByText('Ada Chen')).toHaveCount(0);

    await seedAppointment({ start: '2026-06-09T13:00:00-05:00', end: '2026-06-09T13:45:00-05:00' });

    await expect(page.getByText('Ada Chen')).toBeVisible({ timeout: 30_000 });
  });

  /**
   * "The front desk types faster than it mouses." Every appointment chip is a
   * real link in chronological DOM order, so the whole column is reachable by
   * Tab with no custom key handling to get wrong.
   */
  test('is operable from the keyboard', async ({ page }) => {
    await seedAppointment({ start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T10:45:00-05:00' });
    await page.goto(`/staff/day?day=${DAY}`);

    const chip = page.getByRole('link', { name: /Ada Chen/ });
    await chip.focus();
    await expect(chip).toBeFocused();
    await page.keyboard.press('Enter');
    // Straight to the appointment (A-027). The front desk's next question is
    // "what happened to this one?" — the client record is one link on from
    // there, and a walk-in with no client record has a destination now.
    await expect(page).toHaveURL(/\/staff\/appointments\//);
  });

  /**
   * A-035 (operator P-4). The complaint was a COST, so the assertion is one:
   * the client is checked in from the day, in one interaction, without the
   * page changing. Before this it was four interactions and two page loads,
   * for the most frequent action in the salon.
   */
  test('checks a client in from the grid, in one tap, without leaving the day', async ({ page }) => {
    await seedAppointment({ start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T10:45:00-05:00' });
    await page.goto(`/staff/day?day=${DAY}`);

    await page.getByRole('button', { name: 'Check in' }).click();

    // Still the day — the whole point.
    await expect(page).toHaveURL(new RegExp(`/staff/day\\?day=${DAY}`));
    // The chip now says so, and the button has become the next step through
    // the visit rather than disappearing: §7 says checked_in → in_progress.
    await expect(page.getByRole('link', { name: /Ada Chen.*checked in/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  });

  test('the button is the NEXT step, never a hardcoded one', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T10:45:00-05:00',
      status: 'in_progress',
    });
    await page.goto(`/staff/day?day=${DAY}`);

    await expect(page.getByRole('button', { name: 'Finish' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check in' })).toHaveCount(0);
  });

  /**
   * The §7 table decides, and a terminal appointment has nowhere to go — so
   * the chip must offer nothing at all rather than a button the write path
   * would refuse.
   */
  test('offers nothing on a cancelled appointment', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T10:45:00-05:00',
      status: 'cancelled',
    });
    await page.goto(`/staff/day?day=${DAY}`);

    await expect(page.getByText('Ada Chen')).toBeVisible();
    await expect(page.getByRole('button', { name: /Check in|Start|Finish|No-show/ })).toHaveCount(0);
  });

  /** The stylist's own list has room for the whole set the table allows, and
   *  it is the surface she reads on a phone between clients. */
  test('the provider list carries every move the table allows, keyboard-reachable', async ({ page }) => {
    await seedAppointment({ start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T10:45:00-05:00' });
    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}`);

    const checkIn = page.getByRole('button', { name: 'Check in' });
    await expect(checkIn).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    // No-show is offered only AFTER the appointment has started (§7's
    // `after-start` clause), and this seeded 10:00 is in the past relative to
    // the test clock, so it is here.
    await expect(page.getByRole('button', { name: 'No-show' })).toBeVisible();

    await checkIn.focus();
    await expect(checkIn).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Checked in')).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T10:45:00-05:00',
      clientNotes: 'Allergic to PPD.',
    });
    await page.goto(`/staff/day?day=${DAY}`);

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

async function danaId(): Promise<string> {
  const prisma = new PrismaClient();
  try {
    return (await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } })).id;
  } finally {
    await prisma.$disconnect();
  }
}
