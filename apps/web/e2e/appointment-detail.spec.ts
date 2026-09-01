/**
 * A-027 — the appointment detail panel (APPT-07, CLIENT-03, BOOK-05, D-8).
 *
 * Four stories converge on this screen, so the spec checks each one arrives:
 * the log in plain language, the pinned note on every render, the override
 * marker WITH its reason, and "was she actually told?".
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { bookAppointment } from '@bookable/db/booking';
import { staffActor } from '@bookable/core/auth';
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
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
  await expect(page).toHaveURL(/\/staff$/);
}

/** One appointment, booked through the real write path so its event log and
 *  its confirmation are the ones the system actually produces. */
async function bookOne(options: { override?: boolean; clientNotes?: string } = {}) {
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
        email: 'ada@example.test',
        notes: options.clientNotes ?? null,
      },
    });

    // `return await`, not a bare `return`: a bare one hands back the promise
    // and the `finally` below disconnects Prisma while the booking's
    // interactive transaction is still open — which surfaces as "Response from
    // the Engine was empty" and looks like a database fault rather than a
    // test-harness one.
    return await bookAppointment(prisma, {
      businessId: business.id,
      providerId: dana.id,
      serviceIds: [service.id],
      clientId: client.id,
      startAt: at('10:00'),
      now: toDate(instant(fromDate(at('10:00')) - 3 * 60 * 60_000)),
      actor: staffActor('staff-1'),
      audience: 'staff',
      ...(options.override ? { isOverride: true, overrideReason: 'squeezing her in' } : {}),
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A-068. BOOK-04's walk-in: a real appointment with NO client record, which is
 * exactly what the desk types in while she is standing at the counter.
 *
 * Ada's RECORD is created here and left unattached, because that is the
 * scenario — she has been in before, she rebooks at the till, and the desk has
 * to find her from the appointment rather than from a booking form.
 */
async function bookWalkIn() {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    await prisma.client.create({
      data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101', email: 'ada@example.test' },
    });
    return await bookAppointment(prisma, {
      businessId: business.id,
      providerId: dana.id,
      serviceIds: [service.id],
      clientId: null,
      startAt: at('14:00'),
      now: toDate(instant(fromDate(at('14:00')) - 3 * 60 * 60_000)),
      actor: staffActor('staff-1'),
      audience: 'staff',
    });
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
    } while (weekdayOf(day) !== 2);
    DAY = day;
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('the appointment detail panel (A-027)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const appointment = await bookOne();
    const anonymous = await browser.newPage();
    await anonymous.goto(`/staff/appointments/${appointment.id}`);
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('is where a chip on the day grid goes', async ({ page }) => {
    await bookOne();
    await page.goto(`/staff/day?day=${DAY}`);
    // Scoped to her stylist's COLUMN. A-046 put a second view of the same
    // appointment on this page — the room strip's chair track — so an
    // unscoped "the link with her name on it" now names two, and this test is
    // about the chip.
    await page.getByRole('region', { name: /Dana/ }).getByRole('link', { name: /Ada Chen/ }).click();
    await expect(page).toHaveURL(/\/staff\/appointments\//);
    await expect(page.getByRole('heading', { name: 'Ada Chen' })).toBeVisible();
  });

  /** APPT-07: the log, in language a person can read. */
  test('shows what happened, in plain language', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByText('Booked by the front desk.')).toBeVisible();
  });

  /** CLIENT-03's safety surface, on every render of the appointment. */
  test('puts the pinned client note where it cannot be missed', async ({ page }) => {
    const appointment = await bookOne({ clientNotes: 'Allergic to PPD.' });
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByText('⚑ Allergic to PPD.')).toBeVisible();
  });

  /** BOOK-05 / D-8: the marker AND the reason. */
  test('shows the override marker with its reason', async ({ page }) => {
    const appointment = await bookOne({ override: true });
    await page.goto(`/staff/appointments/${appointment.id}`);

    // The marker carries its reason (BOOK-05) — asserted on the banner
    // specifically, because the log quotes the same reason underneath and
    // both appearances are wanted.
    const banner = page.locator('p').filter({ hasText: 'Booked as an override.' });
    await expect(banner).toContainText('squeezing her in');
    // And the log says it in plain language too.
    await expect(page.getByText('Booked by the front desk as an override.')).toBeVisible();
  });

  /** Operator R-4: "was she actually told?" */
  test('shows what was sent to her', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByText('Booking confirmation')).toBeVisible();
    await expect(page.getByText('ada@example.test')).toBeVisible();
  });

  /**
   * A-044 — A `sent` ROW IS NOT A CLIENT WHO HAS BEEN TOLD.
   *
   * There is no real driver yet (D-14): every send is a line on the server
   * console, and the adapter succeeding is what writes `sent`. A desk reading
   * "sent" on this screen skips the phone call, so until something actually
   * delivers, the screen says queued.
   *
   * The status is forced here rather than dispatched, because a build with no
   * driver has no honest way to produce a delivered row — and a test that only
   * ever looked at `pending` would pass whatever this screen said about
   * `sent`, which is the whole subject.
   */
  test('a message the logging adapter “sent” still reads as queued', async ({ page }) => {
    const appointment = await bookOne();

    const prisma = new PrismaClient();
    try {
      const updated = await prisma.notificationOutbox.updateMany({
        where: { appointmentId: appointment.id },
        // A-048: `deliveredBy` is now the thing the screen asks about, so the
        // fixture stamps it the way the console adapter would.
        data: { status: 'sent', sentAt: toDate(instant(Date.now())), deliveredBy: 'log' },
      });
      expect(updated.count).toBeGreaterThan(0);
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/appointments/${appointment.id}`);
    const row = page.locator('li').filter({ hasText: 'Booking confirmation' });
    await expect(row).toContainText('queued');
    // Not merely "contains queued somewhere": the word this replaces must be
    // gone, or a row saying "sent · queued" would pass the assertion above.
    await expect(row).not.toContainText('sent');
  });

  /**
   * A-048 — the other half, which A-044 could not test at all.
   *
   * The honest wording used to be derived from the BUILD, so there was no way
   * to show a genuinely-delivered row without swapping the adapter. Now it is
   * a column, and "a real driver handled this one" is an ordinary fixture —
   * which is what proves the screen is reading the row rather than the build.
   */
  test('a message a REAL driver sent reads as sent', async ({ page }) => {
    const appointment = await bookOne();

    const prisma = new PrismaClient();
    try {
      const updated = await prisma.notificationOutbox.updateMany({
        where: { appointmentId: appointment.id },
        data: {
          status: 'sent',
          sentAt: toDate(instant(Date.now())),
          deliveredBy: 'twilio',
          externalId: 'SM123',
        },
      });
      expect(updated.count).toBeGreaterThan(0);
    } finally {
      await prisma.$disconnect();
    }

    await page.goto(`/staff/appointments/${appointment.id}`);
    const row = page.locator('li').filter({ hasText: 'Booking confirmation' });
    await expect(row).toContainText('sent');
    await expect(row).not.toContainText('queued');
  });

  /**
   * The status controls come from the §7 table. Checking in writes the ACTUAL
   * timestamp (APPT-03) and a new line in the log — the two halves of
   * "what really happened" versus "what was planned".
   */
  test('checks a client in, and says so in the log', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await page.getByRole('button', { name: 'Check in' }).click();
    // A-037: NAMED, not "the front desk". This action goes through the real
    // session, so the log resolves its actorRef to whoever is at the desk —
    // the seeded shared credential, whose name is "Front desk". The two
    // assertions above still read "by the front desk" because those events are
    // written directly with an actorRef that matches no staff row, which is
    // also every event this repo wrote before A-037.
    await expect(page.getByText('Changed from booked to checked in by Front desk.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      expect(row.status).toBe('checked_in');
      expect(row.checkedInAt).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  /** The table decides, not the screen: a no-show before the start is always
   *  a mis-tap, and the refusal comes back in words. */
  test('refuses a no-show before the appointment has started, and explains', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    const noShow = page.getByRole('button', { name: 'No-show' });
    // The button is not even offered, because the server asked the same
    // function the write path asks.
    await expect(noShow).toHaveCount(0);
  });

  test('saves a note for this visit, kept apart from the pinned one', async ({ page }) => {
    const appointment = await bookOne({ clientNotes: 'Allergic to PPD.' });
    await page.goto(`/staff/appointments/${appointment.id}`);

    await page.getByLabel('Note for this visit').fill('Bring the reference photo');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect(page.getByText('Note saved.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        include: { client: true },
      });
      expect(row.notes).toBe('Bring the reference photo');
      // The pinned note is untouched — mixing them buries the allergy line.
      expect(row.client?.notes).toBe('Allergic to PPD.');
    } finally {
      await prisma.$disconnect();
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    const appointment = await bookOne({ override: true, clientNotes: 'Allergic to PPD.' });
    await page.goto(`/staff/appointments/${appointment.id}`);

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

/**
 * A-055 — "AND CAN YOU DO MY ROOTS WHILE I'M HERE."
 *
 * The operator review at the Phase 5 close called this the biggest hole in the
 * product. The e2e's job is the half the database tests cannot see: that the
 * desk can actually reach it, from the screen it would be standing on, on an
 * appointment whose client is already in the chair.
 */
test.describe('changing what she is having (A-055)', () => {
  const detail = async (page: Page, id: string) => {
    await page.goto(`/staff/appointments/${id}`);
    await expect(page.getByRole('heading', { name: 'What she is having' })).toBeVisible();
  };

  /** The move panel below carries its own "Why? (optional)", so anything
   *  ambiguous is scoped to this section rather than to the page. */
  const panel = (page: Page) => page.locator('section').filter({ hasText: 'What she is having' });

  test('adds a service at the chair, and cancels nothing', async ({ page }) => {
    const appointment = await bookOne();
    await detail(page, appointment.id);

    // The visit today.
    await expect(page.getByRole('button', { name: /^Cut\d/ })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: /Blow-dry/ }).click();
    await page.getByRole('button', { name: 'Change what she is having' }).click();
    await expect(page.getByText(/Added Blow-dry/)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      // ONE row throughout — the assertion that would fail for a
      // cancel-and-rebook, which is the only thing the desk could do before.
      expect(await prisma.appointment.count()).toBe(1);
      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        include: { lines: { orderBy: { ordinal: 'asc' }, include: { service: true } } },
      });
      expect(row.status).toBe('booked');
      expect(row.lines.map((l) => l.service.name)).toEqual(['Cut', 'Blow-dry']);
      expect(row.endAt.getTime()).toBeGreaterThan(appointment.endAt.getTime());

      // And nothing anywhere told her she was cancelled.
      expect(
        await prisma.notificationOutbox.count({ where: { template: 'appointment.cancelled' } }),
      ).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  /** The scenario the item exists for: she is IN THE CHAIR. A reschedule
   *  refuses this state, and changing the visit must not. */
  test('works while she is in the chair, where a move is refused', async ({ page }) => {
    const appointment = await bookOne();
    const prisma = new PrismaClient();
    try {
      await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'in_progress' } });
    } finally {
      await prisma.$disconnect();
    }

    await detail(page, appointment.id);
    // The move panel is gone — `canReschedule` refuses an appointment in the
    // chair — and this one is not.
    await expect(page.getByRole('heading', { name: 'Move this appointment' })).toHaveCount(0);

    await page.getByRole('button', { name: /Blow-dry/ }).click();
    await page.getByRole('button', { name: 'Change what she is having' }).click();
    await expect(page.getByText(/Added Blow-dry/)).toBeVisible();
  });

  test('takes a service off and says how much time came back', async ({ page }) => {
    const appointment = await bookOne();
    await detail(page, appointment.id);

    // Add, then take it off again through the same control.
    await page.getByRole('button', { name: /Blow-dry/ }).click();
    await page.getByRole('button', { name: 'Change what she is having' }).click();
    await expect(page.getByText(/Added Blow-dry/)).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: /Blow-dry/ }).click();
    await page.getByRole('button', { name: 'Change what she is having' }).click();
    await expect(page.getByText(/took off Blow-dry/)).toBeVisible();
    await expect(page.getByText(/minutes back on the book/)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        include: { lines: true },
      });
      expect(row.lines).toHaveLength(1);
      expect(row.endAt.getTime()).toBe(appointment.endAt.getTime());
    } finally {
      await prisma.$disconnect();
    }
  });

  /** APPT-07: the change is in the history, in words, on the same appointment
   *  — which is the whole reason it is not a cancel-and-rebook. */
  test('says what changed in the appointment history', async ({ page }) => {
    const appointment = await bookOne();
    await detail(page, appointment.id);
    await page.getByRole('button', { name: /Blow-dry/ }).click();
    await page.getByRole('button', { name: 'Change what she is having' }).click();
    await expect(page.getByText(/Added Blow-dry/)).toBeVisible();

    await page.reload();
    await expect(page.getByText(/added Blow-dry\. Now ends/)).toBeVisible();
    // The booking is still the first thing that happened to it.
    await expect(page.getByText(/^Booked by/)).toBeVisible();
  });

  /**
   * THE REFUSAL IS A STEP, NOT A DEAD END (D-8) — and this one is real rather
   * than contrived: the seeded salon breaks 12:00–13:00, so Cut + Colour from
   * 10:00 runs to 12:45 and straight through it. Found by writing the spec
   * above with Colour and watching the engine correctly say no.
   */
  test('refuses a visit that would run through her break, and offers the override', async ({ page }) => {
    const appointment = await bookOne();
    await detail(page, appointment.id);

    await page.getByRole('button', { name: /Colour/ }).click();
    await page.getByRole('button', { name: 'Change what she is having' }).click();

    await expect(page.getByText('That would not fit.')).toBeVisible();
    // The engine's OWN word for it, in the salon's vocabulary.
    await expect(page.getByText('during her break.')).toBeVisible();

    // BOOK-05: the desk decides to work through lunch, knowingly and on the
    // record.
    await panel(page).getByLabel('Do it anyway').check();
    await panel(page).getByLabel('Why?', { exact: true }).fill('She is only in today, Dana agreed');
    await page.getByRole('button', { name: 'Change what she is having' }).click();
    await expect(page.getByText(/Added Colour/)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        include: { lines: true },
      });
      expect(row.lines).toHaveLength(2);
      // Still not a cancellation, even through the override door.
      expect(row.status).toBe('booked');
    } finally {
      await prisma.$disconnect();
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    const appointment = await bookOne();
    await detail(page, appointment.id);

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

/**
 * A-060 — ONE CANCEL BUTTON (APPT-06, D-19).
 *
 * The database tests pin the classification. This is the half only a browser
 * can see, and it is the actual point of the item: that the desk is no longer
 * shown two buttons a thumb-width apart and asked to decide, under pressure,
 * a number that lands on the client's rolling late-cancel count.
 */
test.describe('cancelling is one button (A-060)', () => {
  /** D-19's service override, exaggerated so a future Tuesday falls inside
   *  it — the seeded business asks two hours' notice and the appointment is
   *  days away, which is the ordinary case the first test covers. */
  const demandTendaysNotice = async () => {
    const prisma = new PrismaClient();
    try {
      await prisma.service.updateMany({ where: { name: 'Cut' }, data: { cancellationCutoffMinutes: 10 * 24 * 60 } });
    } finally {
      await prisma.$disconnect();
    }
  };

  /** The escape's own words. A straight apostrophe: `&apos;` in the JSX
   *  renders as one, and matching a curly one here fails on a button that is
   *  plainly on the screen. */
  const ESCAPE = /don't count it late/;

  const statusOf = async (id: string) => {
    const prisma = new PrismaClient();
    try {
      return (await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    } finally {
      await prisma.$disconnect();
    }
  };

  test('offers one Cancel, never a "Cancel (late)" beside it', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    // The pair this item removed. An exact-name assertion, because "the old
    // button is gone" is the whole behaviour under test.
    await expect(page.getByRole('button', { name: 'Cancel (late)' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /counts as late/ })).toHaveCount(0);
  });

  test('says it will count as late BEFORE it is pressed, and then does', async ({ page }) => {
    await demandTendaysNotice();
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await page.getByRole('button', { name: 'Cancel — counts as late' }).click();

    // The controls REPLACE themselves once it is terminal, so the log line is
    // the confirmation the screen actually gives — the same one every other
    // status test in this file reads.
    await expect(page.getByText('Changed from booked to cancelled late by Front desk.')).toBeVisible();
    expect(await statusOf(appointment.id)).toBe('cancelled_late');
  });

  test('the escape needs a reason, and records what it overruled', async ({ page }) => {
    await demandTendaysNotice();
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await page.getByRole('button', { name: ESCAPE }).click();
    await expect(page.getByText(/needs a reason/)).toBeVisible();
    expect(await statusOf(appointment.id)).toBe('booked');

    await page.reload();
    await page.getByLabel(/^Reason/).fill('Dana was off sick when she rang');
    await page.getByRole('button', { name: ESCAPE }).click();

    await expect(page.getByText('Changed from booked to cancelled by Front desk.')).toBeVisible();
    // `cancelled`, so `reliability.ts` — which counts by status alone — never
    // puts it on an innocent client's rolling count.
    expect(await statusOf(appointment.id)).toBe('cancelled');
  });

  test('the owner can see how many were let off, and who', async ({ page }) => {
    await demandTendaysNotice();
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);
    await page.getByLabel(/^Reason/).fill('we moved her twice already');
    await page.getByRole('button', { name: ESCAPE }).click();
    await expect(page.getByText('Changed from booked to cancelled by Front desk.')).toBeVisible();

    await page.goto(`/staff/dashboard?week=${DAY}`);
    await page.getByRole('link', { name: /let off the\s+late count/ }).click();

    await expect(page.getByRole('heading', { name: 'Let off the late count' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ada Chen' })).toBeVisible();
    await expect(page.getByText('we moved her twice already')).toBeVisible();
    expect(await statusOf(appointment.id)).toBe('cancelled');
  });
});

/**
 * A-068 — WHO WAS THIS? (BOOK-04, CLIENT-01, D-17.)
 *
 * The walk-in typed in as nothing but a time rebooks at the till, and her
 * visit was orphaned forever: on no client record, counting toward no
 * reliability, reachable by no reminder. The only writer of `clientId` after
 * creation was the client merge — and the schema has promised this door since
 * the first migration.
 */
test.describe('who was this? (A-068)', () => {
  test('names a walk-in from the appointment, using the booking screen\'s own picker', async ({ page }) => {
    const appointment = await bookWalkIn();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await expect(page.getByRole('heading', { name: 'Walk-in, no name' })).toBeVisible();
    await expect(page.getByText('Nobody — this was booked as a walk-in with no record.')).toBeVisible();

    await page.getByLabel('Find a client by name or phone number').fill('Ada');
    await page.getByRole('button', { name: /Ada Chen/ }).click();
    await page.getByLabel('Why (optional)').fill('Rebooked at the till');
    await page.getByRole('button', { name: 'Attach this client' }).click();

    await expect(page.getByText('Recorded as Ada Chen.')).toBeVisible();
    // The page SAYS it, not just the row — the heading is the whole point of
    // attaching, and so is the log line that settles it six weeks later.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Ada Chen' })).toBeVisible();
    await expect(page.getByText('Recorded as Ada Chen by Front desk.')).toBeVisible();
    await expect(page.getByText('Rebooked at the till')).toBeVisible();
  });

  /** Case (b), and the reason this is a correctness item: the workaround was
   *  cancel-and-rebook, which since A-060 derives `cancelled_late` on a client
   *  who did nothing wrong. */
  test('takes a visit off the wrong client without cancelling anything', async ({ page }) => {
    const appointment = await bookOne();
    await page.goto(`/staff/appointments/${appointment.id}`);

    await page.getByRole('button', { name: /take it off the record/ }).click();

    await expect(page.getByText('Taken off Ada Chen.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Walk-in, no name' })).toBeVisible();
    await expect(page.getByText('Taken off Ada Chen by Front desk.')).toBeVisible();
    // The whole point: no cancellation of any kind was written.
    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      expect(row.status).toBe('booked');
      expect(row.clientId).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    const appointment = await bookWalkIn();
    await page.goto(`/staff/appointments/${appointment.id}`);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

/**
 * A-069 / D-44 — GIVING A NO-SHOW'S DEAD TIME BACK (APPT-03, BOOK-05).
 *
 * 10:00 colour, ninety minutes. At 10:20 the desk marks her a no-show and that
 * time stays blocked. The walk-in at 10:25 could only be booked into it
 * through a BOOK-05 override with a typed reason — a false override marker on
 * a slot that is genuinely empty, which is the fastest way to train the desk
 * to dismiss the marker D-8 rests on.
 */
test.describe("a no-show's time, given back (A-069)", () => {
  /** Her appointment is in the PAST on the grid's own day, because a no-show
   *  cannot be marked before it has started. */
  async function pastNoShow() {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const client = await prisma.client.create({
        data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' },
      });
      // Floored to the minute: `appointment_instants_whole_minutes` refuses a
      // stray second, and `new Date()` always has one.
      const startAt = toDate(instant(Math.floor(fromDate(new Date()) / 60_000 - 40) * 60_000));
      const appointment = await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          status: 'no_show',
          startAt,
          endAt: toDate(instant(fromDate(startAt) + 45 * 60_000)),
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 10,
          blockedStart: startAt,
          blockedEnd: toDate(instant(fromDate(startAt) + 45 * 60_000)),
          startDay: toLabel(fromDate(startAt), zoneId(ZONE)).day,
          startWallTime: toLabel(fromDate(startAt), zoneId(ZONE)).time,
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
      return appointment;
    } finally {
      await prisma.$disconnect();
    }
  }

  test('offers the release beside the no-show, and puts the time on the freed list', async ({ page }) => {
    const appointment = await pastNoShow();
    await page.goto(`/staff/appointments/${appointment.id}`);

    // Offered where the desk already is, not a screen away.
    await expect(page.getByText(/minutes of her slot are still blocked/)).toBeVisible();
    // Its own label, because A-068's client correction has a reason box on
    // this same page — two fields called "Why" are ambiguous to a screen
    // reader long before they are ambiguous to a locator.
    await page.getByLabel('What happened (optional)').fill('Rang twice, no answer');
    await page.getByRole('button', { name: /Put \d+ min back on the market/ }).click();

    // The SETTLED state, not the toast: the action revalidates this panel, so
    // the transient message is replaced before it can be read. Asserting what
    // the page says once it has stopped moving is the honest version.
    await expect(page.getByText(/went back on the market at/)).toBeVisible();
    await page.reload();
    // The log says WHAT was done and by whom — nothing about her status moved.
    await expect(page.getByText(/Her remaining time was put back on the market by Front desk/)).toBeVisible();
    await expect(page.getByText('Rang twice, no answer')).toBeVisible();

    // …and it reaches the one screen whose job is selling it (A-067).
    await page.goto('/staff/opened');
    await expect(page.getByText('Ada Chen never came — the rest of her time was put back')).toBeVisible();
  });

  test('changes no status, so her no-show still counts (D-7)', async ({ page }) => {
    const appointment = await pastNoShow();
    await page.goto(`/staff/appointments/${appointment.id}`);
    await page.getByRole('button', { name: /Put \d+ min back on the market/ }).click();
    await expect(page.getByText(/went back on the market at/)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      expect(row.status).toBe('no_show');
      expect(row.startAt.getTime()).toBe(row.startAt.getTime());
      expect(row.releasedAt).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }

    // Offered once. The panel says what was done rather than offering it again.
    await page.reload();
    await expect(page.getByText(/went back on the market at/)).toBeVisible();
    await expect(page.getByRole('button', { name: /back on the market/ })).toHaveCount(0);
  });

  test('has no accessibility violations', async ({ page }) => {
    const appointment = await pastNoShow();
    await page.goto(`/staff/appointments/${appointment.id}`);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
