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
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
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
  await expect(page).toHaveURL(/\/staff\/day/);
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

/**
 * A-073 — THE CLIENTS WHO HAVE STOPPED COMING (RPT-01, CLIENT-02).
 *
 * Tuesday is at 45% and the owner has no list to ring. Three hundred clients,
 * eighty of them on a six-week cycle who have not been in for fourteen weeks,
 * and the only way to find them before this page was to read the client list
 * one record at a time.
 */
test.describe('the clients who have stopped coming (A-073)', () => {
  /** A client whose last visit was months ago and who has nothing booked. */
  async function lapsedClient(name: string, weeksAgo: number) {
    const prisma = new PrismaClient();
    try {
      const client = await prisma.client.create({
        data: { businessId, name, phone: '5125550188' },
      });
      const startAt = toDate(instant(Math.floor(fromDate(new Date()) / 60_000 - weeksAgo * 7 * 24 * 60) * 60_000));
      await prisma.appointment.create({
        data: {
          businessId,
          providerId: danaId,
          clientId: client.id,
          status: 'completed',
          startAt,
          endAt: toDate(instant(fromDate(startAt) + 45 * 60_000)),
          blockedStart: startAt,
          blockedEnd: toDate(instant(fromDate(startAt) + 45 * 60_000)),
          startDay: toLabel(fromDate(startAt), zoneId(ZONE)).day,
          startWallTime: toLabel(fromDate(startAt), zoneId(ZONE)).time,
          lines: {
            create: { businessId, serviceId: cutId, ordinal: 0, priceCents: 14000, durationMinutes: 45 },
          },
        },
      });
      return client.id;
    } finally {
      await prisma.$disconnect();
    }
  }

  test('lists who to ring, with the money and the number, and remembers the call', async ({ page }) => {
    await lapsedClient('Olive Gone', 30);

    await page.goto('/staff/dashboard');
    await page.getByRole('link', { name: /Clients who have stopped coming/ }).click();

    await expect(page).toHaveURL(/\/staff\/dashboard\/lapsed$/);
    await expect(page.getByRole('link', { name: 'Olive Gone' })).toBeVisible();
    // What the call is about: how long, what she had, and what she was worth.
    await expect(page.getByText(/30 weeks/)).toBeVisible();
    await expect(page.getByText(/Cut · Dana · \$140\.00/)).toBeVisible();
    await expect(page.getByRole('link', { name: '5125550188' })).toHaveAttribute('href', 'tel:5125550188');

    // A-072's marks, reused — thirty calls do not happen in one sitting.
    await page.getByRole('button', { name: 'Left a message' }).click();
    await expect(page.getByText('Noted.')).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Left a message —/)).toBeVisible();
  });

  /** N is a number ON the report, not a setting nobody will tune. */
  test('the cutoff is a number on the page, and it is a URL', async ({ page }) => {
    await lapsedClient('Recent Rita', 5);

    await page.goto('/staff/dashboard/lapsed');
    await expect(page.getByText('Nobody has been away that long — try a shorter gap.')).toBeVisible();

    await page.getByLabel('Away for more than (weeks)').fill('4');
    await page.getByRole('button', { name: 'Show' }).click();

    await expect(page).toHaveURL(/weeks=4/);
    await expect(page.getByRole('link', { name: 'Recent Rita' })).toBeVisible();
  });

  test('refuses a member of staff who is not the owner (D-36)', async ({ page }) => {
    // SEEDED FIRST, deliberately: without a row on the list, "her name is not
    // on the page" passes for an empty list as readily as for a refusal, which
    // is a test that cannot fail.
    await lapsedClient('Olive Gone', 30);
    await page.goto('/staff/dashboard/lapsed');
    await expect(page.getByRole('link', { name: 'Olive Gone' })).toBeVisible();

    const prisma = new PrismaClient();
    try {
      await prisma.staffUser.updateMany({ where: { businessId }, data: { role: 'staff' } });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto('/staff/dashboard/lapsed');
    // The commercially sensitive half is the NAMES, so that is what is
    // asserted gone — not merely that the heading is missing, which a layout
    // that declined to render would also produce while the data streamed out
    // beside it (CLAUDE.md's layout-only trap).
    await expect(page.getByRole('link', { name: 'Olive Gone' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Not been in for a while' })).toHaveCount(0);
  });

  /**
   * A-077 — the mark says WHEN, and an old one reads as worth ringing again.
   *
   * A-072's marks were designed for a freed slot that dies on Thursday at 2.
   * The lapsed round is quarterly, so without a date the owner reads "left a
   * message — Priya" in October about a call made in June, and skips her.
   */
  test('says when the call was made, and flags one older than the window', async ({ page }) => {
    const clientId = await lapsedClient('Olive Gone', 30);

    await page.goto('/staff/dashboard/lapsed');
    await page.getByRole('button', { name: 'Left a message' }).click();
    await expect(page.getByText('Noted.')).toBeVisible();
    await page.reload();

    // Fresh: what, who, and WHEN — the field that was already in the payload
    // and was not being rendered.
    await expect(page.getByText(/Left a message —/)).toBeVisible();
    await expect(page.getByText(/worth ringing again/)).toHaveCount(0);

    // …and the same mark, backdated past the window on the report, reads as
    // stale rather than as handled. Derived on every read; the mark itself is
    // never deleted, because somebody did make that call.
    const prisma = new PrismaClient();
    try {
      await prisma.clientCallMark.updateMany({
        where: { clientId, subject: 'lapsed' },
        data: { updatedAt: toDate(instant(fromDate(new Date()) - 20 * 7 * 24 * 60 * 60_000)) },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.reload();
    await expect(page.getByText(/worth ringing again/)).toBeVisible();
  });

  /**
   * A-092 — IN BOTH SCHEMES, ON ROWS SOMEBODY HAS ALREADY WORKED.
   *
   * The version this replaces seeded ONE client with NO call mark and ran axe
   * in Playwright's default light scheme — so it measured the half of the row
   * that exists before anybody starts ringing, on the one of two palettes the
   * salon's tablet is not necessarily on. Both halves of that were wrong here:
   * `text-zinc-500` on the back link is **4.1:1 on #0a0a0a** (checkpoint 7's
   * value, this page's turn), and the mark line — including the stale one,
   * which is the only place this screen uses an intent ink — had never been
   * rendered under axe at all.
   *
   * RELOADED between schemes, not just `emulateMedia`'d: switching the media
   * query on a live page samples every control mid-`transition-colors`, which
   * is 583 nodes of blended colour and not a palette anybody ships.
   */
  test('has no accessibility violations, in both schemes, on a list already worked', async ({ page }) => {
    const fresh = await lapsedClient('Olive Gone', 30);
    const staleId = await lapsedClient('Rowan Stale', 40);

    await page.goto('/staff/dashboard/lapsed');
    // A mark made just now, and one older than the report's own window — the
    // two states of A-077's staleness rule, on the screen at the same time.
    await page
      .getByRole('button', { name: 'Left a message — Olive Gone' })
      .click();
    await expect(page.getByText('Noted.')).toBeVisible();
    await page.getByRole('button', { name: 'No answer — Rowan Stale' }).click();
    await expect(page.getByText('Noted.').first()).toBeVisible();

    const prisma = new PrismaClient();
    try {
      await prisma.clientCallMark.updateMany({
        where: { clientId: staleId, subject: 'lapsed' },
        data: { updatedAt: toDate(instant(fromDate(new Date()) - 20 * 7 * 24 * 60 * 60_000)) },
      });
    } finally {
      await prisma.$disconnect();
    }
    expect(fresh).toBeTruthy();

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.reload();
      // The states are actually on the screen before axe looks at them: a
      // green run over a row that never rendered its mark is what this test
      // used to be.
      await expect(page.getByText(/worth ringing again/)).toBeVisible();
      await expect(page.getByText(/Left a message —/)).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations, `${colorScheme} scheme`).toEqual([]);
    }
  });

  /**
   * A-092 — §4's 44px desk target, on the control every row exists for.
   *
   * Measured on this screen before the fix: the number was **16px tall and
   * 3.9px from the client-record link**, on a list that measured 5044px — 6.6
   * screens on a 1024×768 tablet — so the mis-tap navigated away and lost the
   * reader's place in it. Seven of the eight staff `tel:` links were that size;
   * `PhoneLink` is the one component they are all built from now, and
   * `packages/design/phone-link.test.ts` is what stops a ninth being written.
   */
  test('the number is a 44px target and does not share a line with the client record', async ({ page }) => {
    await lapsedClient('Olive Gone', 30);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/staff/dashboard/lapsed');

    const row = page.getByRole('listitem').filter({ hasText: 'Olive Gone' });
    const phone = row.getByRole('link', { name: '5125550188' });
    const box = await phone.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);

    const name = await row.getByRole('link', { name: 'Olive Gone' }).boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(name!.y + name!.height);
  });
});
