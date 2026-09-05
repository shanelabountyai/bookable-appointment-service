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
import {
  addDays,
  calendarDay,
  fromDate,
  instant,
  instantFromIso,
  resolve,
  toDate,
  toLabel,
  wallTime,
  weekdayOf,
  zoneId,
} from '@bookable/core/time';
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
  await expect(page).toHaveURL(/\/staff\/day/);
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

  /**
   * CLIENT-02 + A-040. The button used to link to the CUSTOMER's flow
   * carrying `serviceIds[0]`, so a two-service visit rebooked as one service
   * — and the desk went through the public rules on the surface it uses most.
   *
   * The whole visit, on the staff surface, attached to the record the desk was
   * already looking at.
   */
  test('rebook carries EVERY service, in order, onto the same client record', async ({ page }) => {
    const prisma = new PrismaClient();
    let clientId = '';
    let targetDay = '';
    let clientsBefore = 0;
    try {
      const business = await prisma.business.findFirstOrThrow();
      const zone = zoneId(business.timezone);

      // The next Tuesday the seeded roster works, and a last visit exactly the
      // default 28-day interval before it — so the suggested day IS that
      // Tuesday, in the future, with the same weekday and therefore hours.
      let day = calendarDay(toLabel(fromDate(new Date()), zone).day);
      do {
        day = addDays(day, 1);
      } while (weekdayOf(day) !== 2);
      targetDay = day;
      const lastVisitDay = addDays(day, -28);
      // Cut (45) + Blow-dry (30) = 75 minutes. Resolved as two wall times
      // rather than added as milliseconds — `appointment_end_after_start` is a
      // real CHECK and a zero-length fixture trips it.
      const lastVisitAt = resolve(lastVisitDay, wallTime('10:00'), zone);
      const lastVisitEnd = resolve(lastVisitDay, wallTime('11:15'), zone);
      if (lastVisitAt.kind !== 'unique' || lastVisitEnd.kind !== 'unique') {
        throw new Error('fixture day is not a unique instant');
      }

      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const cut = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const blowDry = await prisma.service.findFirstOrThrow({ where: { name: 'Blow-dry' } });
      const client = await prisma.client.findFirstOrThrow({ where: { name: 'Ada Chen' } });
      clientId = client.id;
      clientsBefore = await prisma.client.count({ where: { businessId: business.id } });

      // A TWO-LINE visit — the whole point. Cut then Blow-dry, in that order.
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          startAt: toDate(lastVisitAt.at),
          endAt: toDate(lastVisitEnd.at),
          blockedStart: toDate(lastVisitAt.at),
          blockedEnd: toDate(lastVisitEnd.at),
          startDay: lastVisitDay,
          startWallTime: '10:00',
          status: 'completed',
          lines: {
            create: [
              { businessId: business.id, serviceId: cut.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
              { businessId: business.id, serviceId: blowDry.id, ordinal: 1, priceCents: 4000, durationMinutes: 30 },
            ],
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/clients/${clientId}`);
    await expect(page.getByText(/Cut \+ Blow-dry with Dana/)).toBeVisible();
    await page.getByRole('link', { name: 'Rebook' }).click();

    // The STAFF surface, on the suggested day, with both services already
    // chosen in their visit order and her record already attached — no
    // retyping a name that would split her history (D-17).
    await expect(page).toHaveURL(new RegExp(`/staff/book\\?.*day=${targetDay}`));
    await expect(page.getByRole('button', { name: /^1\.\s*Cut/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: /^2\.\s*Blow-dry/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Ada Chen')).toBeVisible();

    // The time is the ONE thing a rebook does not carry: "six weeks on
    // Tuesday" names a day, never a time.
    await page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first().click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked.')).toBeVisible();

    const prisma2 = new PrismaClient();
    try {
      const booked = await prisma2.appointment.findFirstOrThrow({
        where: { status: 'booked' },
        include: { lines: { orderBy: { ordinal: 'asc' }, include: { service: true } } },
      });
      // BOTH services, in the original order — the defect this row exists for.
      expect(booked.lines.map((l) => l.service.name)).toEqual(['Cut', 'Blow-dry']);
      expect(booked.startDay).toBe(targetDay);
      // Attached to the record the desk was looking at, not a lookalike.
      expect(booked.clientId).toBe(clientId);
      // And no second "Ada Chen" was created on the way through.
      const business = await prisma2.business.findFirstOrThrow();
      expect(await prisma2.client.count({ where: { businessId: business.id } })).toBe(clientsBefore);
    } finally {
      await prisma2.$disconnect();
    }
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

  /**
   * A RECORD WITH A HISTORY ON IT, not an empty one — demo checkpoint 7.
   *
   * This test opened a client who had never been in, and was green while the
   * same page failed AA at 2.62:1 on a real record: the "Upcoming" and "Past"
   * headings are `text-zinc-400`, and NEITHER renders until she has a future
   * visit (`Past` is guarded on `upcoming.length > 0`). An axe run over a
   * screen with no data on it is an axe run over the chrome.
   *
   * The sibling instance is `day-grid.spec.ts`'s, which seeded one `booked`
   * appointment and never rendered a chip anybody had closed out. One rule,
   * found twice in one walk.
   */
  test('has no accessibility violations', async ({ page }) => {
    await visits('Ada Chen');
    await search(page, 'Ada');
    await page.getByRole('link', { name: /Ada Chen/ }).click();
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Past' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

/** One visit behind her and one ahead of her, which is what makes the record's
 *  two section headings render at all (demo checkpoint 7). Written straight to
 *  the database: the booking path has its own suite and refuses the past. */
async function visits(name: string) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.findFirstOrThrow({ where: { name } });
    const zone = zoneId(business.timezone);
    // Through the time module, never `toISOString().slice(0,10)` — the lint ban
    // is repo-wide and applies here for the reason CLAUDE.md gives.
    const today = toLabel(fromDate(new Date()), zone).day;
    for (const [offsetDays, status] of [[-30, 'completed'], [30, 'booked']] as const) {
      const day = addDays(today, offsetDays);
      const resolved = resolve(day, wallTime('10:00'), zone);
      if (resolved.kind !== 'unique') throw new Error(`ambiguous fixture day ${day}`);
      const start = toDate(resolved.at);
      const end = toDate(instant(resolved.at + 45 * 60_000));
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          startAt: start,
          endAt: end,
          blockedStart: start,
          blockedEnd: end,
          startDay: day,
          startWallTime: '10:00',
          status,
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}
