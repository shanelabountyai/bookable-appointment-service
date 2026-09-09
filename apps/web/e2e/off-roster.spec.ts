/**
 * A-098 — SHE HAS LEFT, AND HER CLIENTS ARE STILL COMING.
 *
 * The unit suite (`packages/db/settings/off-roster.test.ts`) asks every reader
 * the same question in one process. This spec walks the journey the salon
 * actually takes, through the real button, because the two halves of the
 * defect only meet on screen: A-041 refuses the first click and prints the
 * list of everybody still booked WITH PHONE NUMBERS, and then — before this
 * item — that list was the last time anyone in the salon saw those clients.
 *
 * So the assertion that matters is the one made AFTER the confirm: the same
 * names A-041 just showed are still on the day, still on the conflicts screen,
 * and the column offering them is visibly not a column anybody can book into.
 * A spec that stopped at the confirm dialog — which is what `settings.spec.ts`
 * correctly does, because that is A-041's item — passes against the bug.
 */
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import {
  addDays,
  calendarDay,
  fromDate,
  instant,
  resolve,
  toDate,
  toLabel,
  wallTime,
  weekdayOf,
  zoneId,
} from '@bookable/core/time';
import { expectNoAxeViolations } from './axe';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

let DAY: string;
let ZONE: string;

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
 * Books Dana's Tuesday afternoon.
 *
 * DANA AND NOT "any stylist": the seed's roster all work the same hours, and
 * on a book where everybody is interchangeable a wrong answer here looks
 * exactly like a right one. Dana is the one who leaves, and Priya beside her
 * is the control — every assertion below distinguishes "Dana is missing" from
 * "the page rendered nothing".
 */
async function danasAfternoon() {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });

    for (const [index, time] of ['14:00', '15:30'].entries()) {
      const client = await prisma.client.create({
        data: { businessId: business.id, name: `Left Behind ${index + 1}`, phone: `512555020${index}` },
      });
      const startAt = at(time);
      const endAt = toDate(instant(fromDate(startAt) + service.durationMinutes * 60_000));
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          startAt,
          endAt,
          // THE BUFFERS ARE COLUMNS ON THE ROW, and a trigger derives the
          // envelope from them — writing `blockedStart`/`blockedEnd` here by
          // hand is overwritten on the way in. A fixture that omits them
          // stores an envelope equal to the body, and the freed span it later
          // yields is then too short for its own service to fit back into:
          // `matchFreedSlot` measures the whole footprint, buffers included,
          // so the matcher silently finds nobody.
          bufferBeforeMinutes: service.bufferBeforeMinutes,
          bufferAfterMinutes: service.bufferAfterMinutes,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: DAY,
          startWallTime: time,
          status: 'booked',
          lines: {
            create: {
              businessId: business.id,
              serviceId: service.id,
              ordinal: 0,
              priceCents: service.priceCents,
              durationMinutes: service.durationMinutes,
            },
          },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** The one action the product offers for "she has left", through the real
 *  button and past A-041's refusal — which is the point: the refusal is
 *  correct and it is not a substitute for anything below it. */
async function takeDanaOffTheRoster(page: Page) {
  await page.goto('/staff/providers');
  const row = page.getByRole('listitem').filter({ hasText: 'Dana' });
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText('Left Behind 1')).toBeVisible();
  await page.getByRole('button', { name: 'Deactivate anyway' }).click();
  await expect(row.getByText('Not taking bookings')).toBeVisible();
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
    } while (weekdayOf(day) !== 2);
    DAY = day;
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('a stylist off the roster (A-098)', () => {
  test('keeps her column, marks it, and offers nothing in it', async ({ page }) => {
    await danasAfternoon();
    await takeDanaOffTheRoster(page);

    await page.goto(`/staff/day?day=${DAY}`);
    // The URL actually measured, not the one asked for — A-096's lesson: a
    // green run over the login page looks exactly like a green run.
    await expect(page).toHaveURL(new RegExp(`/staff/day\\?day=${DAY}`));

    // The accessible name carries it, so the fact is asserted where a screen
    // reader hears it rather than only where a sighted eye does.
    const column = page.getByRole('region', { name: /^Dana, off the roster/ });
    await expect(column).toBeVisible();
    // Both clients still on the day. This is the assertion the whole item is:
    // before it, this column did not exist and neither did they.
    await expect(column.getByText('Left Behind 1')).toBeVisible();
    await expect(column.getByText('Left Behind 2')).toBeVisible();
    // …and the words on screen send the desk to the one place that can act.
    await expect(column.getByRole('link', { name: 'still booked' })).toBeVisible();

    // AND NOTHING IS OFFERED IN IT. Her hours are untouched by the departure,
    // so every free minute between those two visits would otherwise draw a
    // gap chip carrying a booking link the write refuses.
    await expect(column.getByRole('link', { name: /^Book with Dana/ })).toHaveCount(0);
    await expect(column.getByRole('link', { name: /minutes free/ })).toHaveCount(0);

    // Priya is the control: the grid has not simply stopped offering things.
    const priya = page.getByRole('region', { name: /^Priya/ });
    await expect(priya.getByRole('link', { name: /^Book with Priya/ })).toBeVisible();

    await expectNoAxeViolations(page, { where: 'day grid, a stylist off the roster' });
  });

  /**
   * A-107 — SHE IS WORKING HER NOTICE, AND THE DESK CANNOT TELL THE SCREEN SO.
   *
   * The test above asserts what is GONE from her column, and an absent control
   * looks exactly like a correctly-absent booking link — which is why four
   * green runs of this file could not see that "Behind by · Set" and "Push the
   * column" had gone with it. So this one asserts what is THERE.
   *
   * THE DELTA IS SET WHILE SHE IS STILL ON THE ROSTER, on purpose: with the
   * control hidden afterwards, a stored delta had no control on any screen
   * able to clear it, and every chip in her column read `→ likely` for the
   * rest of the day. Setting it after the departure would prove the door is
   * open but not that the stranded row can be got at, and the stranding is the
   * half nobody could recover from.
   */
  test('still runs her day, and clears a delta set before she left', async ({ page }) => {
    await danasAfternoon();

    await page.goto(`/staff/day?day=${DAY}`);
    const onRoster = page.getByRole('region', { name: /^Dana/ });
    await onRoster.getByLabel('Behind by').fill('25');
    await onRoster.getByRole('button', { name: 'Set' }).click();
    await expect(onRoster.getByText('+25 min')).toBeVisible();

    await takeDanaOffTheRoster(page);

    await page.goto(`/staff/day?day=${DAY}`);
    await expect(page).toHaveURL(new RegExp(`/staff/day\\?day=${DAY}`));
    const column = page.getByRole('region', { name: /^Dana, off the roster/ });

    // The delta is still applied to her clients — the reason it has to be
    // reachable: this is what the desk tells them on the phone.
    await expect(column.getByText('→ likely 14:25')).toBeVisible();

    // BOTH CONTROLS, on a column the write has never refused: neither
    // `running-late.ts` nor `push-column.ts` looks at `Provider.active`.
    await expect(column.getByText('Push the column')).toBeVisible();
    await expect(column.getByRole('button', { name: 'Back on time' })).toBeVisible();

    await column.getByRole('button', { name: 'Back on time' }).click();
    await expect(column.getByText('+25 min')).toHaveCount(0);
    await expect(column.getByText('→ likely 14:25')).toHaveCount(0);

    // And she can be marked late again — the door is open both ways, not just
    // long enough to undo something.
    await expect(column.getByLabel('Behind by')).toBeVisible();

    // Priya is the control, as above: this distinguishes "Dana's controls are
    // there" from "the grid draws these on everything".
    const priya = page.getByRole('region', { name: /^Priya/ });
    await expect(priya.getByLabel('Behind by')).toBeVisible();
  });

  test('strands her clients where the desk can work them', async ({ page }) => {
    await danasAfternoon();
    await takeDanaOffTheRoster(page);

    await page.goto(`/staff/conflicts?day=${DAY}`);
    // There is no absence and no hours change on this day — deactivation
    // writes neither — so both of AVAIL-05's original causes see nothing here.
    await expect(page.getByText('Left Behind 1')).toBeVisible();
    await expect(page.getByText('Left Behind 2')).toBeVisible();
    // With the number, because the resolution to this is a phone call.
    await expect(page.getByRole('link', { name: '5125550200' })).toBeVisible();

    // Nothing has been done TO them: AVAIL-05's rule is that the system never
    // cancels, moves or hides quietly, and a departure is not an exception.
    const prisma = new PrismaClient();
    try {
      const rows = await prisma.appointment.findMany();
      expect(rows.every((r) => r.status === 'booked')).toBe(true);
    } finally {
      await prisma.$disconnect();
    }

    await expectNoAxeViolations(page, { where: 'conflicts, a stylist off the roster' });
  });

  test('still sells the time she gives back', async ({ page }) => {
    await danasAfternoon();
    await takeDanaOffTheRoster(page);

    // The desk works the stranded list and one client says "no, leave it" —
    // the ordinary next step, and the one that frees a Tuesday afternoon.
    const prisma = new PrismaClient();
    try {
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const doomed = await prisma.appointment.findFirstOrThrow({
        where: { providerId: dana.id },
        orderBy: { startAt: 'asc' },
      });
      await prisma.appointment.update({ where: { id: doomed.id }, data: { status: 'cancelled' } });

      // Somebody waiting for that afternoon, so the matcher has a row and the
      // Book button below actually exists. Without her the panel renders
      // "nobody fits this one" and the href assertion would be vacuous — a
      // conditional assertion is an assertion that never runs.
      const business = await prisma.business.findFirstOrThrow();
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const waiting = await prisma.client.create({
        data: { businessId: business.id, name: 'Wants It', phone: '5125550299' },
      });
      await prisma.waitlistEntry.create({
        data: {
          businessId: business.id,
          clientId: waiting.id,
          serviceId: service.id,
          // She asked for DANA — the case that matters, because the person on
          // the list is exactly the one whose stylist has just gone.
          providerIds: [dana.id],
          fromDay: DAY,
          toDay: DAY,
          dayParts: [],
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto('/staff/opened');
    const row = page.getByRole('listitem').filter({ hasText: 'Dana' });
    await expect(row).toBeVisible();
    // The span is sellable; she is not the one who can sell it, and the row
    // says which — because the errand ends in a booking.
    await expect(row).toContainText('off the roster');

    await row.getByRole('link', { name: 'Who wants this slot?' }).click();
    await expect(page).toHaveURL(/\/staff\/waitlist/);

    // THE PANEL EXISTS AT ALL. `freedSlotFrom` resolved the provider against
    // an active-only roster, so naming a departed stylist returned `null` and
    // this whole section silently disappeared — the page rendering exactly as
    // though it had been opened with no parameters.
    await expect(page.getByRole('heading', { name: 'Who wants this slot?' })).toBeVisible();
    await expect(page.getByText('off the roster — this goes to somebody else')).toBeVisible();

    // And the offer leads somewhere the write will honour: `provider=any`,
    // never her id. A-071's whole class of defect is an offer whose fallback
    // quietly names somebody who has gone.
    // SCOPED TO THE MATCHER, not to the page. She is also in the standing
    // queue at the bottom of this screen, so a page-level assertion on her
    // name passes whether or not she was matched to the span — which is what
    // it did on the first run, one line above an assertion that then failed.
    const panel = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Who wants this slot?' }) });
    await expect(panel.getByText('Wants It')).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Book', exact: true })).toHaveAttribute('href', /provider=any/);
  });
});
