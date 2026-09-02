/**
 * A-017 — booking from the desk (BOOK-04, BOOK-05, D-8, D-17, D-25).
 *
 * The day is pinned by `?day=` everywhere except the walk-in, which is about
 * "now" by definition and therefore uses today.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

/**
 * THE DAY IS COMPUTED, NOT PINNED — and it has to be in the FUTURE.
 *
 * A-016's grid spec pins a fixed Tuesday because rendering a past day is
 * perfectly valid. Booking one is not: the engine refuses it as `in-the-past`,
 * which is exactly what it should do and exactly what this spec hit when it
 * inherited that fixed date. So this walks forward to the next Tuesday the
 * seeded roster works (weekdays 2–6), which is always at least a day ahead
 * whenever the suite runs.
 */
let DAY: string;
let ZONE: string;

/** A wall-clock time on the test's day, as an INSTANT, through the one
 *  conversion module. Nothing here builds a `Date` from a string. */
function at(time: string): Date {
  const resolution = resolve(calendarDay(DAY), wallTime(time), zoneId(ZONE));
  if (resolution.kind !== 'unique') throw new Error(`${DAY} ${time} is not a unique instant in ${ZONE}`);
  return toDate(resolution.at);
}

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

async function today(): Promise<string> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    return toLabel(fromDate(new Date()), zoneId(business.timezone)).day;
  } finally {
    await prisma.$disconnect();
  }
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
    } while (weekdayOf(day) !== 2); // Tuesday, which the seeded roster works
    DAY = day;
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('staff booking (A-017)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/book?walkin=1');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  /** The gap A-016 deferred: it is a link now, and it carries the instant. */
  test('books from a gap in the day grid', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);

    const gap = page.getByRole('link', { name: /Book \d+ minutes free/ }).first();
    await expect(gap).toBeVisible();
    await gap.click();

    await expect(page.getByRole('heading', { name: /^Book with/ })).toBeVisible();
    await page.getByRole('button', { name: /^Cut\d/ }).click();
    await page.getByRole('button', { name: 'No name' }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    await expect(page.getByText('Booked.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow({ include: { lines: true } });
      // BOOK-04: a real appointment with no client record at all.
      expect(appointment.clientId).toBeNull();
      expect(appointment.isOverride).toBe(false);
      expect(appointment.lines).toHaveLength(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  /** A-039: the panel changes its OWN day rather than sending the desk back
   *  to the grid to pick again. */
  test('changes day inside the panel and books on the new day', async ({ page }) => {
    const prisma = new PrismaClient();
    let providerId = '';
    try {
      providerId = (await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } })).id;
    } finally {
      await prisma.$disconnect();
    }
    // A week ahead, same weekday, so the seeded roster still works there.
    const nextWeek = addDays(calendarDay(DAY), 7);

    await page.goto(`/staff/book?provider=${providerId}&day=${DAY}`);
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    await page.getByLabel('Which day?').fill(nextWeek);
    // A-054 (demo checkpoint 4): WAIT FOR THE NEW DAY'S TIMES before booking.
    //
    // Both the service tap and the day change ask the server for times, and
    // until this item nothing said which request an answer belonged to — so a
    // slow answer for the OLD day could arrive last and reselect a slot on it
    // while the panel's heading said the new one. This sweep caught it doing
    // exactly that: panel on 1 September, appointment written on 25 August.
    // The guard is in the panel; this assertion is what makes the spec able
    // to see it, instead of booking whichever day happened to win.
    await expect(page.getByRole('button', { name: /^\d\d:\d\d$/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'No name' }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked.')).toBeVisible();

    const prisma2 = new PrismaClient();
    try {
      const appointment = await prisma2.appointment.findFirstOrThrow();
      expect(appointment.startDay).toBe(nextWeek);
    } finally {
      await prisma2.$disconnect();
    }
  });

  test('finds an existing client by part of her number', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      await prisma.client.create({ data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' } });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: /Book \d+ minutes free/ }).first().click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    await page.getByLabel('Find a client by name or phone number').fill('0101');
    await page.getByRole('button', { name: /Ada Chen/ }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    await expect(page.getByText('Booked.')).toBeVisible();
    const prisma2 = new PrismaClient();
    try {
      const appointment = await prisma2.appointment.findFirstOrThrow({ include: { client: true } });
      expect(appointment.client?.name).toBe('Ada Chen');
    } finally {
      await prisma2.$disconnect();
    }
  });

  test('creates a client that does not exist yet', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: /Book \d+ minutes free/ }).first().click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    await page.getByLabel('Find a client by name or phone number').fill('Priya Nair');
    await page.getByRole('button', { name: /^New client/ }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    await expect(page.getByText('Booked.')).toBeVisible();
  });

  /**
   * BOOK-05 and D-8's hardest-won point: every platform the operator abandoned
   * died of a flat refusal. The refusal here is a STEP — it names the reason
   * and offers the override.
   */
  test('refuses, explains, and then overrides with a reason', async ({ page }) => {
    const startAt = at('18:00').toISOString(); // after the 17:00 close
    const prisma = new PrismaClient();
    let providerId = '';
    try {
      providerId = (await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } })).id;
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/book?provider=${providerId}&at=${encodeURIComponent(startAt)}&day=${DAY}`);
    await page.getByRole('button', { name: /^Cut\d/ }).click();
    await page.getByRole('button', { name: 'No name' }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    // Named, not a shrug — and reachable. A time outside every working window
    // is never an engine CANDIDATE, so it comes back with no reason list at
    // all; the override must still be on offer, or "book outside hours" is
    // the one BOOK-05 case with no way past.
    await expect(page.getByText('That time is not free.')).toBeVisible();
    await expect(page.getByText(/outside her working hours/)).toBeVisible();

    await page.getByLabel('Book it anyway').check();
    await page.getByLabel('Why?').fill('Wedding party, agreed with Dana');
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    await expect(page.getByText('Booked as an override, and recorded.')).toBeVisible();

    const prisma2 = new PrismaClient();
    try {
      const appointment = await prisma2.appointment.findFirstOrThrow();
      expect(appointment.isOverride).toBe(true);
      expect(appointment.overrideReason).toBe('Wedding party, agreed with Dana');
      // D-8's mechanics: the constraint is never weakened — the blocked range
      // is zero-width and the true range is kept for the day view.
      expect(appointment.blockedStart.toISOString()).toBe(appointment.blockedEnd.toISOString());

      const event = await prisma2.appointmentEvent.findFirstOrThrow({ where: { type: 'override_booked' } });
      expect(event.reason).toBe('Wedding party, agreed with Dana');
      expect(event.actor).toBe('staff');
    } finally {
      await prisma2.$disconnect();
    }
  });

  test('the override shows on the day grid as an override', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          startAt: at('10:00'),
          endAt: at('10:45'),
          blockedStart: at('10:00'),
          blockedEnd: at('10:45'),
          startDay: DAY,
          startWallTime: '10:00',
          isOverride: true,
          overrideReason: 'squeezed in',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/day?day=${DAY}`);
    await expect(page.getByText('override').first()).toBeVisible();
  });

  /** BOOK-04's walk-in, and D-25: with the seeded two-hour lead time, none of
   *  this is bookable by a customer — which is the whole point. */
  test('books a walk-in against whoever is free now', async ({ page }) => {
    const day = await today();
    await page.goto(`/staff/day?day=${day}`);
    await page.getByRole('link', { name: 'Walk-in' }).click();

    await expect(page.getByRole('heading', { name: 'Walk-in' })).toBeVisible();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    // WAIT FOR THE ANSWER BEFORE BRANCHING. The options load in a transition,
    // so counting them straight after choosing the service races the request:
    // an empty count means "still looking", not "nobody is free". This waits
    // for whichever of the two terminal states arrives — which is the honest
    // shape of a test about "right now", since whether anybody IS free depends
    // on the wall clock when the suite runs.
    const options = page.getByRole('button', { name: /at \d\d:\d\d$/ });
    const nobody = page.getByText(/Nobody is free for that today/);
    await expect(options.first().or(nobody)).toBeVisible();

    if (await options.count()) {
      await options.first().click();
      await page.getByRole('button', { name: 'No name' }).click();
      await page.getByRole('button', { name: 'Book', exact: true }).click();
      await expect(page.getByText('Booked.')).toBeVisible();
    } else {
      // Outside the seeded opening hours there is genuinely nobody free, and
      // saying so is the correct behaviour rather than a failure.
      await expect(nobody).toBeVisible();
    }
  });

  /** D-17: a NOTE, never a refusal. */
  test('warns that this client already has an appointment then', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const priya = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Priya' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const client = await prisma.client.create({
        data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' },
      });
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: priya.id,
          clientId: client.id,
          startAt: at('09:00'),
          endAt: at('09:45'),
          blockedStart: at('09:00'),
          blockedEnd: at('09:45'),
          startDay: DAY,
          startWallTime: '09:00',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    const dana = new PrismaClient();
    let danaId = '';
    try {
      danaId = (await dana.provider.findFirstOrThrow({ where: { displayName: 'Dana' } })).id;
    } finally {
      await dana.$disconnect();
    }

    // The same time Ada is already with Priya.
    const startAt = at('09:00').toISOString();
    await page.goto(`/staff/book?provider=${danaId}&at=${encodeURIComponent(startAt)}&day=${DAY}`);
    await page.getByRole('button', { name: /^Cut\d/ }).click();
    // The clash note is about the SELECTED time, so the time has to be
    // selected first — the times load once a service is chosen, and that is
    // the order the desk works in too.
    await expect(page.getByRole('button', { name: '09:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Find a client by name or phone number').fill('Ada');

    await expect(page.getByText(/already has 09:00 with Priya/)).toBeVisible();

    // And it does not stop the booking — mum and daughter share a number, and
    // even the same client twice is the salon's call (D-17).
    await page.getByRole('button', { name: /Ada Chen/ }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked.')).toBeVisible();
  });

  /**
   * A-042 — BOOK-05's override, reached the way the desk would reach it.
   *
   * The spec above ('refuses, explains, and then overrides') proves the
   * machinery works and proves nothing about whether anyone can get to it: it
   * hand-builds `?at=18:00`, a URL this product has never emitted. Every real
   * link into the panel carried either a gap's instant or nothing, and a gap
   * is by construction FREE time — so the override checkbox only ever appeared
   * after a refusal the desk had no way to cause.
   *
   * So: no `page.goto` with a hand-built query anywhere below. Day grid →
   * column header → an occupied time on the list → the refusal in the salon's
   * words → the override with its reason.
   */
  test('overrides onto an occupied time, entirely from the browser', async ({ page }) => {
    // Fill the time first, through the ordinary path, so the column really is
    // occupied rather than fixture-occupied.
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: 'Book with Dana' }).click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    // Offered chips are named by their time alone; a refused one carries its
    // reason in the same accessible name, so this regex picks a free one.
    const free = page.getByRole('button', { name: /^\d\d:\d\d$/ }).first();
    await expect(free).toBeVisible();
    const taken = (await free.textContent())!.trim();
    await free.click();
    await page.getByRole('button', { name: 'No name' }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked.')).toBeVisible();

    // Back in through the SAME door — the one that does not need a gap, which
    // is the point: a column with no gaps left still has a way in.
    await page.getByRole('link', { name: 'Back to the day' }).click();
    await page.getByRole('link', { name: 'Book with Dana' }).click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    // A-032's deferred half: the time is still listed, dimmed, saying WHY.
    const occupied = page.getByRole('button', { name: `${taken} — she already has a client then` });
    await expect(occupied).toBeVisible();
    await occupied.click();

    await page.getByRole('button', { name: 'No name' }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    // Refused in words, with the way past beside them (D-8).
    await expect(page.getByText('That time is not free.')).toBeVisible();
    // EXACT, because the chips on the list now say the same words: this has
    // to be the refusal's own sentence (which ends in a full stop), not the
    // annotation on the button that caused it.
    await expect(page.getByText('she already has a client then.', { exact: true })).toBeVisible();

    await page.getByLabel('Book it anyway').check();
    await page.getByLabel('Why?').fill('Wedding party, agreed with Dana');
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked as an override, and recorded.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const override = await prisma.appointment.findFirstOrThrow({
        where: { isOverride: true },
        include: { events: true, blocks: true },
      });
      expect(override.overrideReason).toBe('Wedding party, agreed with Dana');
      // D-8: a ZERO-WIDTH blocked range, so the exclusion constraint is
      // satisfied without being weakened — and the true range kept beside it
      // so the day view renders the real collision.
      expect(override.blockedStart.getTime()).toBe(override.blockedEnd.getTime());
      expect(override.blockedStart.getTime()).toBe(override.startAt.getTime());
      // `overriddenFromRange` is not asserted here because Prisma cannot
      // select an `Unsupported("tstzrange")` — and it does not need to be: the
      // `appointment_override_range_iff_override` CHECK makes a non-null value
      // on this row a condition of the INSERT having succeeded at all.
      expect(override.blocks).toHaveLength(1);
      expect(override.blocks[0]!.blockedStart.getTime()).toBe(override.blocks[0]!.blockedEnd.getTime());
      expect(override.events.map((e) => e.type)).toContain('override_booked');
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * A-042's other half: a time the grid CANNOT contain. Candidates are
   * anchored to window-open, so 18:00 on a day that shuts at 17:00 is never an
   * engine candidate and can never appear as a refused chip — it is the case
   * BOOK-05 names first and the one A-038 routes back here.
   *
   * The wall time is typed; the INSTANT is composed on the server (D-4).
   */
  test('books after closing from a typed time, with no hand-built URL', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: 'Book with Dana' }).click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    await page.getByLabel('Another time?').fill('18:00'); // after the 17:00 close
    await page.getByRole('button', { name: 'Use it' }).click();
    await expect(page.getByRole('button', { name: '18:00', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'No name' }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    await expect(page.getByText(/outside her working hours/)).toBeVisible();
    await page.getByLabel('Book it anyway').check();
    await page.getByLabel('Why?').fill('Staying late for the wedding party');
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked as an override, and recorded.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const override = await prisma.appointment.findFirstOrThrow({ where: { isOverride: true } });
      // The instant the SERVER composed, not one the browser built in its own
      // zone — the whole reason the wall time made a round trip.
      expect(override.startAt.getTime()).toBe(at('18:00').getTime());
      expect(override.startWallTime).toBe('18:00');
    } finally {
      await prisma.$disconnect();
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: /Book \d+ minutes free/ }).first().click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

/**
 * A-049 — STANDING APPOINTMENTS, THE SURFACE (D-34).
 *
 * Part 1 built the rule, the schema and the write path with 22 tests against
 * them; none of it was reachable from a browser. These specs are about the
 * half that was missing: the desk sets a repeat up in the flow it already
 * uses, reads back EVERY week including the ones that did not take, and finds
 * its way from one occurrence to the rest.
 *
 * No hand-built URL anywhere below — the same rule A-042's specs adopted, and
 * for the same reason: machinery that works and cannot be reached is not
 * built.
 */
test.describe('standing appointments (A-049)', () => {
  test('books her next three, a week apart, and links them to each other', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: 'Book with Dana' }).click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    // An offered chip is named by its time alone; a refused one carries its
    // reason in the same accessible name.
    await page.getByRole('button', { name: /^\d\d:\d\d$/ }).first().click();
    await page.getByRole('button', { name: 'No name' }).click();

    await page.getByLabel('How many appointments?').fill('3');
    await page.getByLabel('Every how many weeks?').fill('1');

    // The count is ON the button — six rows about to be written into the book
    // is not something the desk should discover afterwards.
    await page.getByRole('button', { name: 'Book 3 appointments' }).click();

    await expect(page.getByText('Booked all 3.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'booked' })).toHaveCount(3);

    const prisma = new PrismaClient();
    try {
      const series = await prisma.appointmentSeries.findFirstOrThrow();
      // THE RULE, on the calendar axis (D-34) — a day and a wall time, never
      // an instant and an offset.
      expect(series.anchorDay).toBe(DAY);
      expect(series.intervalWeeks).toBe(1);
      expect(series.requested).toBe(3);

      const occurrences = await prisma.appointment.findMany({
        where: { seriesId: series.id },
        orderBy: { startAt: 'asc' },
      });
      expect(occurrences).toHaveLength(3);
      expect(occurrences.map((o) => o.seriesOrdinal)).toEqual([0, 1, 2]);
      expect(occurrences.map((o) => o.startDay)).toEqual([DAY, addDays(calendarDay(DAY), 7), addDays(calendarDay(DAY), 14)]);
      // Every occurrence is the SAME wall time. The instants may differ by an
      // hour across a transition; the client's time may not.
      expect(new Set(occurrences.map((o) => o.startWallTime)).size).toBe(1);
      expect(occurrences.every((o) => o.isOverride)).toBe(false);
    } finally {
      await prisma.$disconnect();
    }

    // "2nd of 3, every week", and the rest of them one tap away — the question
    // asked in front of a client holding her diary.
    await page.getByRole('link', { name: 'booked' }).nth(1).click();
    await expect(page.getByRole('heading', { name: 'Standing appointment' })).toBeVisible();
    await expect(page.getByText('2nd of 3, every week.')).toBeVisible();
    await expect(page.getByText('— this one')).toBeVisible();
  });

  /**
   * A-057 (D-39) — THE UNDO THAT COSTS ONE ACTION, NOT THREE.
   *
   * The structural finding the operator review made: creating three
   * appointments is one action, and while undoing them was three the desk
   * would stop using the create. So this walks the whole thing from a cold
   * start — book the standing appointment, ring up on the second one, end it
   * there — and asserts the week she already had is STILL IN THE BOOK.
   */
  test('ends the series from one occurrence, and leaves the earlier one alone', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: 'Book with Dana' }).click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();
    await page.getByRole('button', { name: /^\d\d:\d\d$/ }).first().click();
    await page.getByRole('button', { name: 'No name' }).click();
    await page.getByLabel('How many appointments?').fill('3');
    await page.getByLabel('Every how many weeks?').fill('1');
    await page.getByRole('button', { name: 'Book 3 appointments' }).click();
    await expect(page.getByText('Booked all 3.')).toBeVisible();

    await page.getByRole('link', { name: 'booked' }).nth(1).click();
    // Scoped to the panel: the move panel on the same screen has its own
    // "Why?" box, and this action's one is not that one.
    const ending = page.locator('details').filter({ hasText: 'End this series here' });
    // The <details> summary carries the name, as with A-018's push.
    await page.getByText('End this series here').click();
    await ending.getByRole('button', { name: 'Show me what goes' }).click();

    // TWO, not three: "here" is this occurrence and the one after it, and the
    // week she has already had is not on the list at all.
    await expect(ending.getByRole('button', { name: 'Cancel 2 appointments' })).toBeVisible();

    await ending.getByLabel('Why?').fill('She is moving away');
    await ending.getByRole('button', { name: 'Cancel 2 appointments' }).click();
    await expect(ending.getByText(/Cancelled 2 appointments/)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
      expect(rows[0]!.status).toBe('booked');
      expect(rows.slice(1).every((r) => r.status.startsWith('cancelled'))).toBe(true);
      // The link survives as provenance (D-34): "she had a standing Tuesday
      // and ended it" is the fact the desk needs six months later.
      expect(rows.every((r) => r.seriesId !== null)).toBe(true);
      // One typed reason, one message per cancelled occurrence (D-32).
      expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.cancelled' } })).toBe(2);
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * The behaviour the whole item turns on: creation is PARTIAL (D-34), so a
   * week somebody else already has is NAMED rather than silently dropped. A
   * summary that showed only successes is the silent skip this product exists
   * to forbid.
   */
  test('names the week it could not book instead of skipping it', async ({ page }) => {
    const nextWeek = addDays(calendarDay(DAY), 7);
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      // Dana's 09:00 a week today is somebody else's — the fourth-Tuesday
      // problem, one week earlier so the spec stays short.
      // Both ends resolved through the ONE conversion module. Adding 45
      // minutes to a `Date` would be arithmetic on the instant axis with a
      // wall-clock intent — the axis-crossing the lint rule exists to catch.
      const on = (time: string) => {
        const resolution = resolve(calendarDay(nextWeek), wallTime(time), zoneId(ZONE));
        if (resolution.kind !== 'unique') throw new Error(`${nextWeek} ${time} is not unique in ${ZONE}`);
        return toDate(resolution.at);
      };
      const startAt = on('09:00');
      const endAt = on('09:45');
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          startAt,
          endAt,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: nextWeek,
          startWallTime: '09:00',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: 'Book with Dana' }).click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();
    await page.getByRole('button', { name: '09:00', exact: true }).click();
    await page.getByRole('button', { name: 'No name' }).click();

    await page.getByLabel('How many appointments?').fill('3');
    await page.getByLabel('Every how many weeks?').fill('1');
    await page.getByRole('button', { name: 'Book 3 appointments' }).click();

    await expect(page.getByText('Booked 2 of 3. The rest are below, with the reason.')).toBeVisible();
    // The REASON, in the salon's words, against the week it belongs to.
    await expect(page.getByText('not booked')).toBeVisible();
    await expect(page.getByText(/she already has a client then/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'booked' })).toHaveCount(2);

    const prisma2 = new PrismaClient();
    try {
      const series = await prisma2.appointmentSeries.findFirstOrThrow();
      // The RULE still asked for three. What was booked and what was asked for
      // are different facts and the row keeps both.
      expect(series.requested).toBe(3);
      const occurrences = await prisma2.appointment.findMany({
        where: { seriesId: series.id },
        orderBy: { startAt: 'asc' },
      });
      // The blocked week is ABSENT, not booked on top of somebody: ordinals 0
      // and 2, with 1 missing.
      expect(occurrences.map((o) => o.seriesOrdinal)).toEqual([0, 2]);
    } finally {
      await prisma2.$disconnect();
    }
  });
});

/**
 * A-056 — "ANYTHING THURSDAY? I DON'T MIND WHO." (SVC-02)
 *
 * The acceptance criterion is the operator's own, in desk terms: from a cold
 * start, answer "anything that day, anyone" on ONE screen and book it. Before
 * this the panel would not offer a time without a stylist, so one day was one
 * pass per column and the desk said "let me ring you back".
 */
test.describe('booking with anyone (A-056)', () => {
  test('answers the whole day in one screen, and books it', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: 'Anyone', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Book with anyone' })).toBeVisible();

    await page.getByRole('button', { name: /^Cut\d/ }).click();

    // One row per TIME, each naming who she would get — four stylists free at
    // two is one offer to the client, not four.
    const withSomeone = page.getByRole('button', { name: /^\d\d:\d\d with / });
    await expect(withSomeone.first()).toBeVisible();
    const label = (await withSomeone.first().textContent())!;
    await withSomeone.first().click();

    await page.getByRole('button', { name: 'No name' }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow({ include: { provider: true } });
      // Booked with the stylist the row NAMED — what the desk read is what it
      // booked, never a second assignment on submit.
      expect(label).toContain(appointment.provider.displayName);
      expect(appointment.isOverride).toBe(false);
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * A-071 — THE ANYONE ROW LOSES THE RACE.
   *
   * The row said 14:00 with Dana, three free. The desk takes a phone call,
   * comes back, submits — and the public flow has taken Dana in between. The
   * panel used to say "That time is not free" and offer an override that would
   * knowingly DOUBLE-BOOK her, while two other stylists were free at the very
   * same two o'clock. So the desk either took the override (wrong) or started
   * the search again with the client on the phone, and A-056's whole premise —
   * that at two o'clock the stylists are interchangeable — was thrown away at
   * the last step.
   *
   * The race is made deterministic by STALENESS rather than by a barrier: the
   * panel is holding a row that was true when it was drawn, and the booking is
   * written underneath it. That is exactly the operator's scene, and it needs
   * no concurrency at all.
   */
  test('offers the next free stylist by name, and never an override', async ({ page }) => {
    await page.goto(`/staff/book?provider=any&day=${DAY}`);
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    const row = page.getByRole('button', { name: /^\d\d:\d\d with / }).first();
    await expect(row).toBeVisible();
    const label = (await row.textContent())!;
    const named = /with (\w+)/.exec(label)![1]!;
    const time = /^(\d\d:\d\d)/.exec(label)![1]!;
    await row.click();
    await page.getByRole('button', { name: 'No name' }).click();

    // …and while the desk is on the phone, somebody else takes her.
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const taken = await prisma.provider.findFirstOrThrow({ where: { displayName: named } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const startAt = at(time);
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: taken.id,
          startAt,
          endAt: toDate(instant(fromDate(startAt) + 45 * 60_000)),
          blockedStart: startAt,
          blockedEnd: toDate(instant(fromDate(startAt) + 45 * 60_000)),
          startDay: DAY,
          startWallTime: time,
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.getByRole('button', { name: 'Book', exact: true }).click();

    // NAMES the person who has gone and the person who can do it, at the same
    // time — not "that time is not free".
    await expect(page.getByText(new RegExp(`${named} has just gone`))).toBeVisible();
    const offer = page.getByRole('button', { name: /^Book \w+ at \d\d:\d\d$/ });
    await expect(offer).toBeVisible();
    // THE DEFECT: an override here would knowingly double-book somebody while
    // two other stylists are free at the very same time.
    await expect(page.getByLabel('Book it anyway')).toHaveCount(0);

    // One tap, and it books the person the button NAMED — never a silent
    // re-assign (A-056: what you see is what you book).
    const offered = /^Book (\w+) at/.exec((await offer.textContent())!)![1]!;
    await offer.click();
    await expect(page.getByText('Booked.')).toBeVisible();

    const prisma2 = new PrismaClient();
    try {
      const booked = await prisma2.appointment.findFirstOrThrow({
        where: { isOverride: false, provider: { displayName: offered } },
        include: { provider: true },
      });
      expect(booked.provider.displayName).toBe(offered);
      expect(offered).not.toBe(named);
      expect(await prisma2.appointment.count({ where: { isOverride: true } })).toBe(0);
    } finally {
      await prisma2.$disconnect();
    }
  });

  /**
   * SVC-02's load balancing, end to end: the whole reason the rule exists
   * rather than "pick anyone free". Fill one stylist's morning and the offer
   * moves off her.
   */
  test('offers the stylist with the lighter day', async ({ page }) => {
    const prisma = new PrismaClient();
    let danaName = '';
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      danaName = dana.displayName;
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      // Three hours on Dana's day and nothing on anybody else's.
      for (const time of ['09:00', '10:00', '11:00']) {
        const startAt = at(time);
        const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
        await prisma.appointment.create({
          data: {
            businessId: business.id,
            providerId: dana.id,
            startAt,
            endAt,
            blockedStart: startAt,
            blockedEnd: endAt,
            startDay: DAY,
            startWallTime: time,
            lines: {
              create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
            },
          },
        });
      }
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/book?provider=any&day=${DAY}`);
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    const afternoon = page.getByRole('button', { name: /^1[4-6]:\d\d with / });
    await expect(afternoon.first()).toBeVisible();
    // Dana has three hours on the book; somebody else has none.
    expect((await afternoon.first().textContent())!).not.toContain(danaName);
  });

  test('says so plainly when nobody can take it that day', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      // Nobody works Sunday in the seeded roster.
      await prisma.weeklyWindow.deleteMany({});
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/book?provider=any&day=${DAY}`);
    await page.getByRole('button', { name: /^Cut\d/ }).click();
    await expect(page.getByText(/Nobody can take that on/)).toBeVisible();
  });
});
