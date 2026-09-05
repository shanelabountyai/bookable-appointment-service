/**
 * A-062 — the printable day sheet.
 *
 * The sheet is `?sheet=1` on the same route, so most of it is an ordinary
 * screen assertion. Only the last test switches media, because only the last
 * test is about what the print stylesheet does.
 *
 * The day is pinned by `?day=` for the same reason as the grid spec — a sheet
 * spec that trusts the wall clock passes on a Tuesday and fails on a Sunday.
 *
 * A-093 added the second describe. Every test above seeds ONE forthcoming
 * booking, which is the fixture a sheet looks perfect in — and is why nothing
 * here could see an override, a no-show, a stylist who is off, or a stylist
 * with more than a page of clients.
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
  await expect(page).toHaveURL(/\/staff\/day/);
}

async function seedAppointment(options: {
  status?: string;
  name?: string;
  clientNotes?: string;
  /** Local wall times on DAY, in the salon's zone. Defaults to the 10:00 Cut. */
  start?: string;
  end?: string;
  wallTime?: string;
  /** A-093. `[worked, gap, worked]` in minutes — what the trigger cuts blocks
   *  from, and the whole reason a colour is TWO busy intervals (D-29). */
  segmentPattern?: number[];
  isOverride?: boolean;
  overrideReason?: string;
  releasedAt?: string;
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
    const start = options.start ?? '2026-06-09T10:00:00-05:00';
    const end = options.end ?? '2026-06-09T10:45:00-05:00';
    return await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        startAt: at(start),
        endAt: at(end),
        // The trigger rewrites both — zero-width for an override (D-8), and one
        // row per worked part when there is a pattern.
        blockedStart: at(start),
        blockedEnd: at(end),
        startDay: DAY,
        startWallTime: options.wallTime ?? '10:00',
        ...(options.status ? { status: options.status as 'booked' } : {}),
        ...(options.segmentPattern ? { segmentPattern: options.segmentPattern } : {}),
        ...(options.isOverride ? { isOverride: true, overrideReason: options.overrideReason ?? 'because' } : {}),
        ...(options.releasedAt ? { releasedAt: at(options.releasedAt) } : {}),
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

/**
 * A-093 — WHAT A LIST HAS TO SAY THAT A GRID SAYS WITH GEOMETRY (§8.7, §5.4.4).
 *
 * The grid says WHEN with position and AT ONCE with overlap. A table can say
 * neither, so both have to become words — and the four tests here are the four
 * places they had not.
 */
test.describe('the day sheet as a document (A-093)', () => {
  /** A colour: 20 minutes applying, 25 developing, 15 finishing. The develop
   *  time is a gap the salon can sell (D-29), which is why the visit is TWO
   *  blocks — and why the day view had two chances to place it. */
  const COLOUR = [20, 25, 15];

  /**
   * THE DEFECT THIS ITEM WAS FOUND BY, and the only fixture that can see it:
   * a segmented visit whose LAST block starts after the next appointment does.
   *
   * The colour runs 09:00–10:00 and its second block starts at 09:45. The
   * override starts 09:30. Collapse the colour to its last block — which the
   * day view did — and the paper prints the 09:30 BEFORE the 09:00. On the
   * grid the same bug drew the chip 45 minutes low and three demo checkpoints
   * walked past it; on paper a stylist reads down the page and works the day
   * in the printed order.
   */
  test('prints in TIME ORDER, even when one visit is two blocks with a gap inside it', async ({ page }) => {
    await seedAppointment({
      name: 'Marcy Dunn',
      start: '2026-06-09T09:00:00-05:00',
      end: '2026-06-09T10:00:00-05:00',
      wallTime: '09:00',
      segmentPattern: COLOUR,
    });
    await seedAppointment({
      name: 'Tom Byrne',
      start: '2026-06-09T09:30:00-05:00',
      end: '2026-06-09T09:45:00-05:00',
      wallTime: '09:30',
      isOverride: true,
      overrideReason: 'squeezing him in before the wedding',
    });

    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}&sheet=1`);
    const times = await page.locator('tbody tr td:first-child').allInnerTexts();
    // Ascending, and the colour first. Comparing the printed strings rather
    // than asserting two names in order: this has to fail for a THIRD row out
    // of place too, not just the pair that found it.
    expect(times).toEqual([...times].sort());
    expect(times[0]).toBe('09:00–10:00');
  });

  /**
   * §5.4.11. Only an override can put two clients in one stylist's hour — D-8's
   * zero-width blocked range is what gets it past the exclusion constraint —
   * and on the grid the two chips visibly collide. In a table they are two
   * consecutive rows, which is the shape of SEQUENCE. So the marker and the
   * typed reason are on the paper, or the stylist reads it as a system fault
   * and rings the desk to ask.
   */
  test('says an override IS one, and prints the reason somebody typed', async ({ page }) => {
    await seedAppointment({
      name: 'Tom Byrne',
      start: '2026-06-09T10:15:00-05:00',
      end: '2026-06-09T10:30:00-05:00',
      wallTime: '10:15',
      isOverride: true,
      overrideReason: 'squeezing him in before the wedding',
    });
    await seedAppointment({ name: 'Ada Chen' });

    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}&sheet=1`);
    const row = page.locator('tbody tr').filter({ hasText: 'Tom Byrne' });
    await expect(row).toContainText('Override');
    await expect(row).toContainText('squeezing him in before the wedding');
    // And it stays RARE: the ordinary booking beside it carries no marker.
    await expect(page.locator('tbody tr').filter({ hasText: 'Ada Chen' })).not.toContainText('Override');
  });

  /**
   * D-7 + A-069. The sheet's filter is `occupiesTime`, which deliberately KEEPS
   * a no-show — her hour is still gone. So the page that calls itself "who is
   * coming" printed the one client who definitively is not, in the same ink as
   * everybody else; and once the desk gave her remaining time back, whoever
   * bought it prints against the same hour with nothing to separate them.
   */
  test('says who is NOT coming, and whose time went back on the market', async ({ page }) => {
    await seedAppointment({
      name: 'Ada Chen',
      status: 'no_show',
      releasedAt: '2026-06-09T10:05:00-05:00',
    });

    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}&sheet=1`);
    const row = page.locator('tbody tr').filter({ hasText: 'Ada Chen' });
    // The chip's own word, from the chip's own map — not a ninth copy of the
    // status list typed onto the printer.
    await expect(row).toContainText('No-show');
    await expect(row).toContainText('Time given back from 10:05.');
  });

  /**
   * TWO DIFFERENT FACTS THAT WERE ONE SENTENCE. A stylist with an empty day is
   * a day to sell; a stylist who is off is not. Both printed "Nothing in the
   * book." — and the hours line is the other half of the same fix, because on
   * paper there is no shaded band to read them off.
   */
  test('tells a stylist who is OFF from a stylist with an empty day', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      await prisma.dateOverride.create({
        data: { businessId: business.id, providerId: dana.id, day: DAY, isClosed: true, reason: 'holiday' },
      });
      // Priya is IN with an utterly empty day — and lunch is an ITEM on this
      // sheet, so a stylist who still has her break booked never reaches the
      // empty branch at all. Taking it off is what makes the OTHER sentence
      // reachable, and the two sentences are the whole subject of this test.
      const priya = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Priya' } });
      await prisma.windowBreak.deleteMany({ where: { weeklyWindow: { providerId: priya.id } } });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/day?day=${DAY}&sheet=1`);
    const danaPage = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Dana', level: 2 }) });
    await expect(danaPage).toContainText('Not working today.');
    await expect(danaPage).not.toContainText('Nothing in the book.');
    // And no hours: there are none. A page carrying "09:00–17:00" over "not
    // working" is the same lie in the other direction.
    await expect(danaPage).not.toContainText(/\d\d:\d\d–\d\d:\d\d/);

    // Her colleague is IN and free, which is a different sentence and a
    // sellable day — with the hours on it, since the paper has no shading.
    const priyaPage = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Priya', level: 2 }) });
    await expect(priyaPage).toContainText('Nothing in the book.');
    await expect(priyaPage).not.toContainText('Not working today.');
    await expect(priyaPage).toContainText(/\d\d:\d\d–\d\d:\d\d/);
  });

  /**
   * THE ONE THING A BROWSER REPEATS ON EVERY PRINTED PAGE IS `<thead>`.
   *
   * Priya's real Wednesday is fourteen clients; the list breaks mid-afternoon,
   * and page two used to arrive carrying the column headings and no name and
   * no date — under a comment in `day-sheet.tsx` swearing the date is on every
   * page. Proved on a real PDF, fixed by moving the identity into the `thead`.
   *
   * The assertion is structural because Playwright cannot paginate: what makes
   * page two right is that this heading is INSIDE the repeating group.
   */
  test('carries whose page it is inside the group a printer repeats', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}&sheet=1`);

    const identity = page.locator('table thead h2');
    await expect(identity.first()).toHaveText('Dana');
    // One per stylist, all inside a thead — not one loose header above the
    // first table.
    expect(await identity.count()).toBe(await page.getByRole('heading', { level: 2 }).count());
    await expect(page.locator('table thead').first()).toContainText(DAY);
  });

  /**
   * AXE, ON A SHEET THAT ACTUALLY CARRIES ALL OF IT, IN BOTH SCHEMES.
   *
   * The A-087/A-091/A-092 lesson, for the third time: the axe test above seeds
   * ONE forthcoming booking, so the override box, the status word and the
   * released line — every part of this page that only exists once the day has
   * been worked — had never been measured. And no run had ever been dark.
   */
  test('has no accessibility violations in either scheme, on a worked day', async ({ page }) => {
    await seedAppointment({ name: 'Ada Chen', clientNotes: 'Allergic to PPD.', status: 'no_show', releasedAt: '2026-06-09T10:05:00-05:00' });
    await seedAppointment({
      name: 'Tom Byrne',
      start: '2026-06-09T11:00:00-05:00',
      end: '2026-06-09T12:00:00-05:00',
      wallTime: '11:00',
      segmentPattern: COLOUR,
    });
    await seedAppointment({
      name: 'Marcy Dunn',
      start: '2026-06-09T11:30:00-05:00',
      end: '2026-06-09T11:45:00-05:00',
      wallTime: '11:30',
      isOverride: true,
      overrideReason: 'squeezing her in before the wedding',
    });

    const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}&sheet=1`);
    // Asserted present, so a fixture that stops rendering the interesting half
    // cannot make this pass for the wrong reason.
    await expect(page.getByText('Override')).toBeVisible();
    // The STATUS word, not the reliability flag — a client who has just been
    // marked a no-show has "1 no-show in the last 12 months" against her name
    // in the same cell, and the two are different facts.
    await expect(page.getByText('— No-show')).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);

    // RELOAD, not just `emulateMedia` — switching the media query on a live
    // page leaves the primitives mid-`transition-colors` and axe samples the
    // blend.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.getByText('— No-show')).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
  });
});
