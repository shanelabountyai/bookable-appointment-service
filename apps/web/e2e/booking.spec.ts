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
import { bookAppointment } from '@bookable/db/booking';
import { staffActor } from '@bookable/core/auth';
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
      // Stored CANONICALLY (D-55) — a different string from the one typed.
      // Whether that makes her one client is the next test's question, and it
      // needs a second person typing.
      expect(appointment.client?.phone).toBe('+15125550101');
      expect(await prisma.appointmentEvent.count()).toBeGreaterThan(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * A-114 / D-55 — TWO PEOPLE TYPING. The desk wrote her with a +1 and her
   * accents; she types brackets and no accents. One client, and the booking is
   * on it. The assertion above used to type a number and read the same number
   * back — one person typing twice — and passed while this made a second client.
   */
  test('books onto the record the desk wrote, however she types her number and name', async ({ page }) => {
    const seed = new PrismaClient();
    let deskId: string;
    try {
      const business = await seed.business.findFirstOrThrow();
      deskId = (
        await seed.client.create({ data: { businessId: business.id, name: 'Rae Núñez', phone: '+1 512 555 0104' } })
      ).id;
    } finally {
      await seed.$disconnect();
    }

    await reachTheTimeList(page);
    await firstOption(page).click();
    await page.getByLabel('Your name').fill('rae nunez');
    await page.getByLabel('Phone').fill('(512) 555-0104');
    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

    const prisma = new PrismaClient();
    try {
      expect(await prisma.client.count({ where: { phone: '+15125550104' } })).toBe(1);
      expect((await prisma.appointment.findFirstOrThrow()).clientId).toBe(deskId);
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

/**
 * A-105 — THE RESCUE ASKS THE ROOM ABOUT A STRANGER, AND SHE IS SITTING IN IT.
 *
 * `confirmAppointment` resolves her client row, hands that row's id to
 * `bookAppointment` as A-063's holder, and then — in its own `catch`, twenty
 * lines further down — asked the room "who else could take this?" and "what
 * else is free that day?" with no holder at all. `null` is the question you
 * ask a stranger, and it is STRICTER: one client's own overlapping envelopes
 * may share a single chair, so the chair she is physically sitting in reads as
 * taken. Measured over the future book: 472 comparisons, 23 instants the named
 * question offers that the anonymous one refuses, none the other way.
 *
 * A refusal handler does not read like a caller of the room's question, which
 * is why A-083 threaded every other caller and walked past these three —
 * A-097's rule one door on, the fallback arm is a reader too and it inherited
 * the default instead of the answer it already had.
 *
 * THE FIXTURE IS THE ITEM. On a book where nobody is seated the two questions
 * agree, so a spec written the obvious way passes against the bug. Both tests
 * below need a room where every chair is held at the contested instant and one
 * of the holders is HER: two chairs, her Cut ending at 13:45 in one of them,
 * somebody else across the other.
 */
test.describe('the chair she is already in (A-105)', () => {
  /** Typed into the form as a different string from the seeded row: a client is
   *  reused on the same CANONICAL (phone, name) (D-55), and the row it finds is
   *  the whole of this item. */
  const HER = { name: 'Marcy Dunn', typed: '(512) 555-0177', stored: '5125550177' };

  /** Her Cut: body 13:00–13:45, envelope 13:00–13:55 with the after-buffer.
   *  A Blow-dry at 13:45 therefore shares her ENVELOPE and not her BODY, which
   *  is exactly A-063's shareable chair. */
  const CONTESTED = '13:45';

  const threeHoursBefore = (when: Date) => toDate(instant(fromDate(when) - 3 * 60 * 60_000));

  /**
   * The next open Tuesday, a two-chair room, and her already in chair one.
   *
   * Tuesday because the seeded roster is uniform on it — Marcus's split shift
   * is Thursday — and computed rather than pinned because the public flow
   * refuses a past day and only lists 28 ahead.
   */
  async function herAfternoon() {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const zone = zoneId(business.timezone);
      let day = calendarDay(toLabel(fromDate(new Date()), zone).day);
      do {
        day = addDays(day, 1);
      } while (weekdayOf(day) !== 2);

      const at = (time: string) => {
        const resolution = resolve(calendarDay(day), wallTime(time), zone);
        if (resolution.kind !== 'unique') throw new Error(`${day} ${time} is not unique in ${zone}`);
        return toDate(resolution.at);
      };

      // TWO chairs: a room that cannot bind cannot disagree with anything, and
      // a fixture with no room in it is what let A-069 through (CLAUDE.md).
      const spare = await prisma.resource.findMany({
        where: { businessId: business.id, active: true },
        orderBy: { name: 'asc' },
        skip: 2,
      });
      await prisma.resource.updateMany({
        where: { id: { in: spare.map((r) => r.id) } },
        data: { active: false },
      });

      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const cut = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const her = await prisma.client.create({
        data: { businessId: business.id, name: HER.name, phone: HER.stored },
      });
      // Through `bookAppointment`, never a hand-written row: the trigger
      // derives `blockedStart`/`blockedEnd` from the appointment's own buffer
      // columns, which default to 0, and an envelope equal to its body is a
      // row the product cannot produce (CLAUDE.md, A-098).
      await bookAppointment(prisma, {
        businessId: business.id,
        providerId: dana.id,
        serviceIds: [cut.id],
        clientId: her.id,
        startAt: at('13:00'),
        now: threeHoursBefore(at('13:00')),
        actor: staffActor('staff-1'),
        audience: 'staff',
      });

      return { businessId: business.id, day, at, clientId: her.id };
    } finally {
      await prisma.$disconnect();
    }
  }

  /** Somebody who is not her, in the other chair, for one Blow-dry. */
  async function somebodyElseTakes(providerName: string, at: Date, name: string) {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const provider = await prisma.provider.findFirstOrThrow({ where: { displayName: providerName } });
      const blowDry = await prisma.service.findFirstOrThrow({ where: { name: 'Blow-dry' } });
      const stranger = await prisma.client.create({ data: { businessId: business.id, name } });
      await bookAppointment(prisma, {
        businessId: business.id,
        providerId: provider.id,
        serviceIds: [blowDry.id],
        clientId: stranger.id,
        startAt: at,
        now: threeHoursBefore(at),
        actor: staffActor('staff-1'),
        audience: 'staff',
      });
    } finally {
      await prisma.$disconnect();
    }
  }

  /**
   * THE PRECONDITION, asserted rather than assumed: at the contested instant
   * every chair in the room is held, and one of the holders is her. That is
   * what makes the two questions differ — a stranger sees no free chair, she
   * sees the one she is sitting in. If the fixture ever stops producing it,
   * these tests stop being about A-105 and must say so rather than pass.
   */
  async function expectTheRoomFullExceptHers(clientId: string, from: Date, to: Date) {
    const prisma = new PrismaClient();
    try {
      const holds = await prisma.appointmentResourceHold.findMany({
        where: {
          status: { notIn: ['cancelled', 'cancelled_late'] },
          blockedStart: { lt: to },
          blockedEnd: { gt: from },
        },
        select: { resourceId: true, holderKey: true },
      });
      expect(new Set(holds.map((h) => h.resourceId)).size).toBe(2);
      expect(holds.map((h) => h.holderKey)).toContain(clientId);
    } finally {
      await prisma.$disconnect();
    }
  }

  /** Her two appointments, in ONE chair — the offer was right about which
   *  chair too, not merely that some chair existed. */
  async function expectOneChairForBoth(clientId: string) {
    const prisma = new PrismaClient();
    try {
      const holds = await prisma.appointmentResourceHold.findMany({
        where: { holderKey: clientId, status: { notIn: ['cancelled', 'cancelled_late'] } },
        select: { resourceId: true },
      });
      expect(holds).toHaveLength(2);
      expect(new Set(holds.map((h) => h.resourceId)).size).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  }

  /**
   * The row's own story: she books a blow-dry straight after her cut, said she
   * does not mind who, and the stylist the flow named is taken while she types
   * — taking the last chair with her. The rescue that exists precisely so she
   * is not dead-ended came back `null`, because it asked about a stranger.
   */
  test('re-offers the same time with somebody else, in the chair she is already in', async ({ page }) => {
    const { day, at, clientId } = await herAfternoon();
    const { weekday, date } = readableDayParts(day);

    await page.goto('/book');
    await page.getByRole('button', { name: /^Blow-dry 30 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /No preference/ }).click();
    await page.getByRole('button', { name: `${weekday} ${date}` }).click();
    await expect(page.getByRole('group')).toContainText('What time on');
    // Offered while the other chair is still free — which is how she can be
    // holding this row at all.
    await page.getByRole('button', { name: CONTESTED, exact: true }).click();

    const named = /with (\w+)/.exec((await page.getByRole('heading', { level: 2 }).textContent())!)![1]!;
    // Never the stylist whose chair-mate she is: Dana's after-buffer runs to
    // 13:55, so Dana cannot be the one offered at 13:45.
    expect(named).not.toBe('Dana');

    await page.getByLabel('Your name').fill(HER.name);
    await page.getByLabel('Phone').fill(HER.typed);

    // …and while she is typing, that stylist takes the last free chair at the
    // same time. One write, and it does both: the race is lost AND the room is
    // full for anybody who is not already in it.
    await somebodyElseTakes(named, at(CONTESTED), 'Ben Rios');
    await expectTheRoomFullExceptHers(clientId, at(CONTESTED), at('14:20'));

    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    // Named, at the SAME time. Before A-105 the rescue found nobody — every
    // chair is taken to a stranger — and she was sent back to the time list.
    await expect(page.getByText(/is free at the same time/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 })).not.toContainText(`with ${named}`);
    await expect(page.getByLabel('Your name')).toHaveValue(HER.name);

    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const booked = await prisma.appointment.findFirstOrThrow({
        where: { clientId, startAt: at(CONTESTED) },
        include: { provider: true },
      });
      // Never silently re-assigned, and never an override: the write took the
      // chair for real (D-30 overrides hold none).
      expect(booked.provider.displayName).not.toBe(named);
      expect(booked.isOverride).toBe(false);
    } finally {
      await prisma.$disconnect();
    }
    await expectOneChairForBoth(clientId);
  });

  /**
   * The same handler's OTHER arm, and the same defect: when the rescue is not
   * reached — she asked for a stylist by name — the fall-through offers "the
   * other times still free". Built from the stranger's question, that list
   * withheld the one time this very write would have accepted.
   *
   * No staleness in the room here: the other chair is taken up front, so 13:45
   * is correctly absent while she browses anonymously and correctly present
   * the moment she has said who she is. The only stale thing is her stylist's
   * three o'clock.
   */
  test('and the other times it falls back to are asked about her too', async ({ page }) => {
    const { day, at, clientId } = await herAfternoon();
    // Chair two, across 13:45, before she ever opens the page.
    await somebodyElseTakes('Priya', at(CONTESTED), 'Ben Rios');
    await expectTheRoomFullExceptHers(clientId, at(CONTESTED), at('14:20'));

    const { weekday, date } = readableDayParts(day);
    await page.goto('/book');
    await page.getByRole('button', { name: /^Blow-dry 30 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Marcus', exact: true }).click();
    await page.getByRole('button', { name: `${weekday} ${date}` }).click();
    await expect(page.getByRole('group')).toContainText('What time on');

    // Browsing, she is nobody yet — and 13:45 is rightly not on offer. This is
    // the strict question being CORRECT, and it is why the page cannot simply
    // be made permissive everywhere.
    await expect(page.getByRole('button', { name: CONTESTED, exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '15:00', exact: true }).click();
    await page.getByLabel('Your name').fill(HER.name);
    await page.getByLabel('Phone').fill(HER.typed);

    // …and Marcus's three o'clock goes while she types. Late enough that its
    // chair cannot touch 13:45 — the fixture must stay interesting after it.
    await somebodyElseTakes('Marcus', at('15:00'), 'Iris Patel');

    await page.getByRole('button', { name: 'Confirm appointment' }).click();

    // Back on the time list, and 13:45 is on it. Before A-105 it was not, and
    // she was shown a shorter day than the salon could actually sell her.
    await expect(page.getByRole('group')).toContainText('What time on');
    const hers = page.getByRole('button', { name: CONTESTED, exact: true });
    await expect(hers).toBeVisible();

    await hers.click();
    await page.getByLabel('Your name').fill(HER.name);
    await page.getByLabel('Phone').fill(HER.typed);
    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

    // The offer was not merely permissive — the write agrees, in her chair.
    await expectOneChairForBoth(clientId);
  });
});
