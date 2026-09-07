/**
 * A-010 — the customer booking flow (BOOK-01, D-4, D-10).
 *
 * Seeded through `seedSetup` rather than by driving the staff UI: this spec is
 * about the CUSTOMER's journey, and forty clicks of setup in front of it would
 * make every failure ambiguous about which half broke.
 *
 * The day list is deliberately not pinned to a fixed date. It is "the next
 * open days from today in the salon's zone", so the spec picks the first one
 * offered — pinning it would mean the suite passes in June and fails in July.
 */
import { expectNoAxeViolations } from './axe';
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
// Relative, not `@/lib/…`: this is the app's ONE customer-facing day
// formatter, and the spec clicks the day the fixture built by the name the
// page gives it. A hand-rolled "15 September" here would be a second copy of
// `readableDayParts` that goes quietly wrong the day the format changes.
import { readableDayParts } from '../lib/customer-format';
import { expect, test } from './fixtures';

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

/** The first option in whichever list is on screen. */
const firstOption = (page: Page) => page.locator('fieldset ul > li > button').first();

/** A-058 made the service step MULTI-select, so choosing is no longer the same
 *  thing as advancing — tap what you want, then Continue. */
async function chooseServiceAndProvider(page: Page) {
  await page.goto('/book');
  await page.getByRole('button', { name: /^Cut 45 min/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Dana', exact: true }).click();
  await expect(page.getByRole('group')).toContainText('Which day suits you?');
}

async function reachTheTimeList(page: Page) {
  await chooseServiceAndProvider(page);
  await firstOption(page).click();
  await expect(page.getByRole('group')).toContainText('What time on');
}

test.describe('customer booking flow (A-010)', () => {
  test('books an appointment end to end', async ({ page }) => {
    await reachTheTimeList(page);
    await firstOption(page).click();

    await page.getByLabel('Your name').fill('Ada Chen');
    await page.getByLabel('Phone').fill('(512) 555-0101');
    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

    // The appointment is real, and it went through the write path — a booked
    // row with a service line and an event, not a bare insert.
    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow({
        include: { lines: true, client: true },
      });
      expect(appointment.status).toBe('booked');
      expect(appointment.lines).toHaveLength(1);
      // Normalized on the way in, so the same person typing it either way is
      // one client (CLIENT-01).
      expect(appointment.client?.phone).toBe('5125550101');
      expect(await prisma.appointmentEvent.count()).toBeGreaterThan(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  // BOOK-01's two hard numbers.
  test('is five screens with two required text inputs', async ({ page }) => {
    await reachTheTimeList(page);
    await expect(page.getByRole('navigation', { name: 'Progress' })).toContainText('of 5');

    await firstOption(page).click();
    await expect(page.locator('input[required]')).toHaveCount(2);
  });

  test('a time can be chosen with the keyboard alone', async ({ page }) => {
    await reachTheTimeList(page);

    const time = firstOption(page);
    const label = ((await time.textContent()) ?? '').trim();
    await time.focus();
    await expect(time).toBeFocused();
    await page.keyboard.press('Enter');

    // Enter on the focused option advanced the flow and carried the choice.
    await expect(page.getByRole('button', { name: 'Confirm appointment' })).toBeVisible();
    expect(label.length).toBeGreaterThan(0);
    await expect(page.locator('form')).toContainText(label.split(/\s+/)[0]!);
  });

  test('announces the times politely when they change', async ({ page }) => {
    await reachTheTimeList(page);
    await expect(page.locator('[aria-live="polite"]')).toContainText(/appointment times? available on/);
  });

  /**
   * D-10: the customer sees the salon's language, never the system's. This
   * catches the ordinary leak — an enum, an id, or an entity name rendered
   * because it happened to be on the object being mapped.
   */
  test('shows the customer no internal vocabulary', async ({ page }) => {
    await reachTheTimeList(page);
    await firstOption(page).click();

    const body = (await page.locator('body').innerText()).toLowerCase();
    for (const leak of ['booked', 'cancelled_late', 'no_show', 'providerid', 'serviceid', 'slot', 'null', 'undefined']) {
      expect(body, `"${leak}" reached the customer`).not.toContain(leak);
    }
    // cuids: 25 characters of id, the shape that leaks from a careless map.
    expect(body).not.toMatch(/\bc[a-z0-9]{24}\b/);
  });

  test('has no accessibility violations on any screen', async ({ page }) => {
    await page.goto('/book');
    const scan = async (where: string) => {
      await expectNoAxeViolations(page, { where });
    };

    await scan('service');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    // A-058: the chosen-services summary and Continue appear in place, so the
    // service screen is scanned again in its selected state.
    await scan('service (chosen)');
    await page.getByRole('button', { name: 'Continue' }).click();
    await scan('who');
    await page.getByRole('button', { name: 'Dana', exact: true }).click();
    await scan('day');
    await firstOption(page).click();
    await scan('time');
    await firstOption(page).click();
    await scan('details');
  });

  test('refuses a missing name and phone without losing the chosen time', async ({ page }) => {
    await reachTheTimeList(page);
    await firstOption(page).click();

    // The browser's own required-field handling blocks submit; clearing it
    // proves the SERVER validation is there too, which is the one that counts.
    await page.getByLabel('Your name').fill('   ');
    await page.getByLabel('Phone').fill('123');
    await page.locator('form').evaluate((f) => f.querySelectorAll('input').forEach((i) => i.removeAttribute('required')));
    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    await expect(page.getByText('Please give us a name for the appointment.')).toBeVisible();
    await expect(page.getByText(/phone number we can reach you on/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm appointment' })).toBeVisible();
  });
});

/**
 * A-056 (SVC-02) — "No preference" on the customer's own flow.
 *
 * The step used to be mandatory with no such option, so a first-time client
 * who has never heard of Dana or Priya either picked the top name or left.
 * The operator's account of the utilization gap A-024 reports and cannot
 * explain: the senior is solid and the junior is at 40%.
 */
test.describe('booking with no preference (A-056)', () => {
  test('books end to end without ever choosing a stylist', async ({ page }) => {
    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('group')).toContainText('Who would you like to see?');
    // FIRST in the list, and that position is the point.
    await page.getByRole('button', { name: /No preference/ }).click();

    await expect(page.getByRole('group')).toContainText('Which day suits you?');
    await firstOption(page).click();
    await expect(page.getByRole('group')).toContainText('What time on');
    await firstOption(page).click();

    await page.getByLabel('Your name').fill('Ada Chen');
    await page.getByLabel('Phone').fill('(512) 555-0101');
    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

    const prisma = new PrismaClient();
    try {
      // A real appointment with a real stylist — SVC-02 chose her, and the
      // client never had to.
      const appointment = await prisma.appointment.findFirstOrThrow({ include: { provider: true } });
      expect(appointment.provider.displayName.length).toBeGreaterThan(0);
      expect(appointment.status).toBe('booked');
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * A-071 — she said she does not mind who, and the one the flow picked for
   * her is gone by the time she has typed her phone number.
   *
   * Sending her back to the time list throws away the one thing she DID
   * specify. She is a first-time client who has never heard of Dana or Priya,
   * and "sorry, pick again" is where a first-time client leaves.
   *
   * The race is made deterministic by STALENESS rather than a barrier: the
   * page is holding a row that was true when it was drawn, and the stylist is
   * taken out from under it. Time off rather than a booking, because it needs
   * no knowledge of which instant the flow chose — and it exercises the same
   * seam, since both refusals mean "not for HER".
   */
  test('re-offers the same time with somebody else, rather than dead-ending her', async ({ page }) => {
    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /No preference/ }).click();
    // THE SECOND DAY, NOT THE FIRST, AND THE REASON IS THIS TEST'S OWN
    // PRECONDITION. What A-071 re-offers is "the same time with SOMEBODY ELSE",
    // so the time this picks has to be one that more than one stylist can take.
    // Today's list is truncated by the booking lead time, and on a sweep begun
    // at 09:56 the first slot left was 12:00 — which only Tess can take,
    // because the other three have a 12:00–13:00 break and a 45-minute Cut runs
    // into it. Blocking Tess then leaves nobody, the product refuses correctly,
    // and the test fails on the CLOCK rather than on the behaviour. The second
    // day is a whole open day, so its first slot is 09:00 and every qualified
    // stylist is free at it whatever time of day the sweep runs.
    //
    // What the failure exposed on the product side is NOT covered by this test
    // and is its own backlog row (A-097): when nobody else is free at that
    // instant, a client who said "no preference" is shown the vanished
    // stylist's empty day rather than everybody's.
    await page.locator('fieldset ul > li > button').nth(1).click();
    await expect(page.getByRole('group')).toContainText('What time on');
    await firstOption(page).click();

    // The heading names the person the TIME carries — never "No preference",
    // which is not a sentence anybody wanted to read.
    const named = /with (\w+)/.exec((await page.getByRole('heading', { level: 2 }).textContent())!)![1]!;

    await page.getByLabel('Your name').fill('Ada Chen');
    await page.getByLabel('Phone').fill('(512) 555-0101');

    // …and while she is typing, that stylist stops being available.
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const gone = await prisma.provider.findFirstOrThrow({ where: { displayName: named } });
      await prisma.timeOff.create({
        data: {
          businessId: business.id,
          providerId: gone.id,
          // Via the boundary helpers: `new Date(<expr>)` is banned repo-wide,
          // because it is the exact call that crosses the calendar/instant
          // axis through the process timezone.
          startAt: toDate(instant(Date.now() - 60 * 60_000)),
          endAt: toDate(instant(Date.now() + 365 * 24 * 60 * 60_000)),
          reason: 'off sick',
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    // Named, at the SAME time — never "here are some other times". By TEXT
    // rather than by role: Next's own route announcer is an empty
    // `role="alert"` on every page, so the role resolves to two elements.
    await expect(page.getByText(/is free at the same time/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 })).not.toContainText(`with ${named}`);
    // Still on the details step, with what she typed still typed.
    await expect(page.getByLabel('Your name')).toHaveValue('Ada Chen');

    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

    const after = new PrismaClient();
    try {
      const appointment = await after.appointment.findFirstOrThrow({ include: { provider: true } });
      // Never silently re-assigned: she was told, and she pressed the button.
      expect(appointment.provider.displayName).not.toBe(named);
      expect(appointment.isOverride).toBe(false);
    } finally {
      await after.$disconnect();
    }
  });

  /**
   * A-097 — AND WHEN THERE IS NOBODY ELSE AT THAT INSTANT.
   *
   * A-071's re-offer is `null` exactly when no other qualified stylist is free
   * at the instant she was promised, and the flow then falls through to "here
   * are the other times". Those other times were the VANISHED STYLIST'S — a
   * person she never chose, whose column is empty by construction, because
   * what made her vanish is that she has gone. So a client who said she does
   * not mind who was shown one person's empty day and told to pick another,
   * on an open Tuesday with three stylists free from ten o'clock.
   *
   * THE FIXTURE IS THE ITEM, and it needs a room interesting enough for the
   * two answers to differ: an instant exactly ONE stylist can take, on a day
   * where the others can take plenty. The three seniors start late that
   * Tuesday, so 09:00 is Tess's alone and 10:00 onwards is everybody's — then
   * Tess goes, and the two questions ("what else can TESS do today" / "what
   * else can ANYONE do today") answer nothing and eight hours respectively.
   *
   * Built on a fixed weekday rather than the first day the list offers, for
   * the reason the test above carries in full: an hour-of-day-dependent
   * fixture fails on the CLOCK and says nothing about the product.
   */
  test('falls back to everybody\'s other times, not the vanished stylist\'s empty day', async ({ page }) => {
    const setup = new PrismaClient();
    let day: string;
    let zone: string;
    try {
      const business = await setup.business.findFirstOrThrow();
      zone = business.timezone;
      // The next Tuesday: a whole open day on the seeded roster, far enough
      // ahead that D-25's two-hour lead time cannot reach it.
      let target = calendarDay(toLabel(fromDate(new Date()), zoneId(zone)).day);
      do {
        target = addDays(target, 1);
      } while (weekdayOf(target) !== 2);
      day = target;

      const at = (time: string) => {
        const resolution = resolve(calendarDay(day), wallTime(time), zoneId(zone));
        if (resolution.kind !== 'unique') throw new Error(`${day} ${time} is not unique in ${zone}`);
        return toDate(resolution.at);
      };

      // The three seniors start at ten. A 45-minute Cut plus its 10-minute
      // after-buffer cannot fit before it, so the 09:00 the page offers is
      // Tess's and only Tess's — and every time from 10:00 is theirs.
      for (const displayName of ['Dana', 'Priya', 'Marcus']) {
        const provider = await setup.provider.findFirstOrThrow({ where: { displayName } });
        await setup.timeOff.create({
          data: {
            businessId: business.id,
            providerId: provider.id,
            startAt: at('09:00'),
            endAt: at('10:00'),
            reason: 'late start',
          },
        });
      }
    } finally {
      await setup.$disconnect();
    }

    const { weekday, date } = readableDayParts(day);

    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /No preference/ }).click();
    await page.getByRole('button', { name: `${weekday} ${date}` }).click();
    await expect(page.getByRole('group')).toContainText('What time on');
    await page.getByRole('button', { name: '09:00', exact: true }).click();

    // THE PRECONDITION, asserted rather than assumed: nine o'clock is the one
    // time on this day that exactly one stylist can take. If the fixture ever
    // stops producing that, this test stops being about A-097 and must fail
    // saying so — not pass for the wrong reason.
    await expect(page.getByRole('heading', { level: 2 })).toContainText('with Tess');

    await page.getByLabel('Your name').fill('Ada Chen');
    await page.getByLabel('Phone').fill('(512) 555-0101');

    // …and Tess goes home sick while she is typing.
    const sick = new PrismaClient();
    try {
      const business = await sick.business.findFirstOrThrow();
      const tess = await sick.provider.findFirstOrThrow({ where: { displayName: 'Tess' } });
      await sick.timeOff.create({
        data: {
          businessId: business.id,
          providerId: tess.id,
          startAt: toDate(instant(Date.now() - 60 * 60_000)),
          endAt: toDate(instant(Date.now() + 365 * 24 * 60 * 60_000)),
          reason: 'off sick',
        },
      });
    } finally {
      await sick.$disconnect();
    }

    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    // Back on the time list — and it is the SALON's day, not Tess's. Before
    // A-097 this said "No appointments left that day. Please choose another."
    await expect(page.getByRole('group')).toContainText('What time on');
    await expect(page.getByText('No appointments left that day.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '10:00', exact: true })).toBeVisible();
    // And 09:00 is gone for the RIGHT reason — the whole salon is unavailable
    // at it now, not merely the one stylist the page had named.
    await expect(page.getByRole('button', { name: '09:00', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '10:00', exact: true }).click();
    await page.getByLabel('Your name').fill('Ada Chen');
    await page.getByLabel('Phone').fill('(512) 555-0101');
    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();
    // A-097's second half: the confirmation names the person she is actually
    // seeing. `provider.name` on this path is the sentinel — "Cut with No
    // preference" is what she used to be sent away with.
    await expect(page.getByText(/Cut with (Dana|Priya|Marcus),/)).toBeVisible();

    const booked = new PrismaClient();
    try {
      const appointment = await booked.appointment.findFirstOrThrow({ include: { provider: true } });
      expect(appointment.provider.displayName).not.toBe('Tess');
      expect(appointment.status).toBe('booked');
      expect(appointment.isOverride).toBe(false);
    } finally {
      await booked.$disconnect();
    }
  });
});

/**
 * A-058 — the public flow books a VISIT, and refuses to sell what needs a
 * consultation first (BOOK-01, D-23).
 *
 * The defect had two halves and both were verified before the work started:
 * `booking-flow.tsx` held one `service` and posted one `serviceId`, while
 * D-23's own text says half the Saturday book is cut-and-colour — so she
 * booked "Colour" alone at two hours, arrived wanting a cut too, and 45
 * minutes had to come out of a column that was already full. And `Service`
 * had no bookable-online flag at all, so a first-time client could self-book
 * a full-head bleach with no consultation and no patch test.
 */
test.describe('a whole visit, and only what may be sold online (A-058)', () => {
  test('books two services as ONE appointment, in the order she tapped them', async ({ page }) => {
    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await page.getByRole('button', { name: /^Blow-dry 30 min/ }).click();

    // The COMPOSED visit, which is the number she is agreeing to: 45 + 30, and
    // $55.00 + $40.00. A line each would leave her adding it up herself.
    await expect(page.getByText('Cut + Blow-dry · 1 hr 15 min · $95.00')).toBeVisible();

    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Dana', exact: true }).click();
    await firstOption(page).click();
    await expect(page.getByRole('group')).toContainText('What time on');
    await firstOption(page).click();

    await page.getByLabel('Your name').fill('Ada Chen');
    await page.getByLabel('Phone').fill('(512) 555-0101');
    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

    const prisma = new PrismaClient();
    try {
      // ONE appointment with TWO lines — not two appointments, which is what
      // the workaround this replaces produced and what leaves her holding two
      // chairs and two manage links for one visit.
      expect(await prisma.appointment.count()).toBe(1);
      const appointment = await prisma.appointment.findFirstOrThrow({
        include: { lines: { orderBy: { ordinal: 'asc' }, include: { service: true } } },
      });
      expect(appointment.lines.map((l) => l.service.name)).toEqual(['Cut', 'Blow-dry']);
      // Tap order IS visit order (VISIT-01): the buffers come from the ends,
      // so "cut then blow-dry" is a different appointment from the reverse.
      expect(appointment.lines.map((l) => l.ordinal)).toEqual([0, 1]);
      // 75 minutes of body, and the envelope is what the constraint ranges
      // over — proof the two lines composed rather than the second replacing
      // the first.
      expect((appointment.endAt.getTime() - appointment.startAt.getTime()) / 60_000).toBe(75);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('shows the desk-only service and says to call, rather than hiding it', async ({ page }) => {
    await page.goto('/book');

    // Balayage is seeded desk-only (three hours, a chair, and a result that
    // depends on what is already on her hair). PRESENT: a salon that hides it
    // has told her it does not do balayage, and she books it somewhere else.
    await expect(page.getByText('Balayage')).toBeVisible();
    await expect(page.getByText(/Give us a call for this one/)).toBeVisible();
    // Not a button at all — a disabled control is skipped by a screen
    // reader's tab order, and the note beside it is the whole message.
    await expect(page.getByRole('button', { name: /Balayage/ })).toHaveCount(0);

    // ACTIVE, not deactivated — the desk sells it every week, and that
    // distinction is the entire reason this is its own column and not a third
    // value in `active` (SVC-03).
    const prisma = new PrismaClient();
    try {
      const balayage = await prisma.service.findFirstOrThrow({ where: { name: 'Balayage' } });
      expect(balayage.active).toBe(true);
      expect(balayage.bookableOnline).toBe(false);
    } finally {
      await prisma.$disconnect();
    }
  });
});
