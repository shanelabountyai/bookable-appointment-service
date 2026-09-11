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
import { expectNoAxeViolations } from './axe';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedDensity, seedSetup } from '@bookable/db/settings';
import { fromDate, instant, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
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

/** Books straight into the database — the write path has its own suite, and
 *  this spec needs a known column rather than a realistic booking journey. */
async function seedAppointment(options: {
  start: string;
  end: string;
  status?: string;
  clientNotes?: string;
  /** A-070 — the note about TODAY, as opposed to the note about her. */
  visitNote?: string;
  /** A-093 — `[worked, gap, worked]` in minutes. The trigger cuts one block
   *  per worked part, which is how a colour's develop time stays sellable. */
  segmentPattern?: number[];
  /** A-099 — a second client, because the defect is two of them at once and a
   *  fixture with one name in it cannot tell which chip survived. */
  clientName?: string;
  /** BOOK-05 / D-8. The trigger does the rest: a zero-width blocked range so
   *  the constraint is satisfied without being weakened, and the TRUE range in
   *  `overriddenFromRange` for the day view to render the collision from. */
  isOverride?: boolean;
  overrideReason?: string;
}) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({
      data: {
        businessId: business.id,
        name: options.clientName ?? 'Ada Chen',
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
        notes: options.visitNote ?? null,
        ...(options.status ? { status: options.status as 'booked' } : {}),
        ...(options.segmentPattern ? { segmentPattern: options.segmentPattern } : {}),
        ...(options.isOverride
          ? { isOverride: true, overrideReason: options.overrideReason ?? 'Dana said to squeeze her in.' }
          : {}),
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

  /**
   * A-090 — EVERY COLUMN AND THE GUTTER SHARE ONE MINUTE ZERO.
   *
   * The defect this replaces was on the product's home screen and had been
   * there since A-016. Each column laid out its own heading, then its own
   * controls, and only then its positioned box — so minute zero sat wherever
   * that column's chrome happened to end, and the chrome's height depends on
   * the DATA. Measured on a seeded Tuesday with nothing running late:
   *
   *     gutter 380 | Dana 480 | Priya 480 | Marcus 438 | Tess 438
   *
   * The hour labels were 100px — 67 minutes — above the rows they label, and
   * the two stylists with nothing left in their columns were drawn 42px
   * (28 minutes) above their colleagues, because a column with nothing to push
   * renders no "push the column" control.
   *
   * "Who is free at two?" is a question you answer by reading ACROSS a day
   * grid. It was off by half an hour, differently per column, according to how
   * busy each stylist was — which is the one variable that makes the question
   * worth asking.
   *
   * THE FIXTURE IS THE TEST. One column is given a running-late delta so that
   * its chrome grows a ring-round panel and a "back on time" button, while the
   * three empty columns beside it have the shortest chrome the product draws.
   * Every fixture in this suite before today had one provider, or four with
   * identical chrome — which is why nothing saw it.
   */
  test('every column and the time gutter start on the same pixel', async ({ page }) => {
    await seedAppointment({ start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T10:45:00-05:00' });
    await page.goto(`/staff/day?day=${DAY}`);

    // Make the chrome heights genuinely differ: Dana grows a ring-round panel,
    // the other three stay at their shortest.
    const dana = page.getByRole('region', { name: /^Dana/ });
    await dana.getByLabel('Behind by').fill('40');
    await dana.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByText('+40 min')).toBeVisible();

    const axes = page.locator('main [data-day-axis]');
    const count = await axes.count();
    // The gutter plus one per provider. If this ever reads 1 the assertion
    // below is vacuously true, which is the way an alignment test dies quietly.
    expect(count).toBeGreaterThan(2);

    const tops = await axes.evaluateAll((nodes) =>
      nodes.map((n) => ({
        axis: n.getAttribute('data-day-axis'),
        top: Math.round(n.getBoundingClientRect().top),
      })),
    );
    const distinct = [...new Set(tops.map((t) => t.top))];
    expect(distinct, `columns start at different heights: ${JSON.stringify(tops)}`).toHaveLength(1);
  });

  /**
   * ONE CHIP OF EVERY STATUS THAT REPAINTS THE CHIP, not one chip.
   *
   * Demo checkpoint 7: this test seeded a single `booked` appointment and was
   * green while the same page, on a real book, failed AA on every chip the
   * desk had closed out. `booked` sits on `bg-white`, where the detail line's
   * old `opacity-80` landed on 4.66:1 and passed by a hundredth. `completed`
   * and `cancelled` are the two statuses that repaint BOTH the ground and the
   * ink, and on `completed` the same alpha gave 4.33:1 light / 4.18:1 dark.
   *
   * So the fixture is the finding: an evening's book is mostly closed-out
   * chips, and until now no fixture had ever rendered one under axe. Every
   * status whose entry in `STATUS_COLOUR` changes the ground belongs here.
   */
  test('has no accessibility violations', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T10:45:00-05:00',
      clientNotes: 'Allergic to PPD.',
    });
    await seedAppointment({
      start: '2026-06-09T11:00:00-05:00',
      end: '2026-06-09T11:45:00-05:00',
      status: 'completed',
    });
    await seedAppointment({
      start: '2026-06-09T12:00:00-05:00',
      end: '2026-06-09T12:45:00-05:00',
      status: 'cancelled',
    });
    await seedAppointment({
      start: '2026-06-09T13:00:00-05:00',
      end: '2026-06-09T13:45:00-05:00',
      status: 'no_show',
    });
    await page.goto(`/staff/day?day=${DAY}`);
    // The chip whose ground the violation needed — asserted present, so a
    // fixture that silently stops rendering it cannot make this test pass for
    // the wrong reason.
    await expect(page.getByText('Cut · +15125550101').first()).toBeVisible();

    // BOTH SCHEMES — the helper runs light AND dark, because half of a palette
    // that flips with `prefers-color-scheme` had never been measured at all
    // until this test. The chip's old alpha failed in both (4.33:1 light,
    // 4.18:1 dark) and the LIGHT run was the one that could not see it, since
    // `booked` sits on white where the same 0.8 scraped past at 4.66:1.
    // A-096 moved the scheme loop into `expectNoAxeViolations` so a spec
    // cannot go back to measuring one of the two.
    await expectNoAxeViolations(page);
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

/**
 * A-070 — THE NOTE ABOUT TODAY (CLIENT-03).
 *
 * "Patch test done 12/4." "6.3 + 20 vol, 35 min." The desk typed these into
 * the appointment's own note field and the stylist at the backwash could read
 * them on no screen at all: `day-view.ts` had selected `notes` since A-016 and
 * the view model dropped it on the floor. The blank scribble column was then
 * the salon writing the colour formula on paper and binning it at six.
 */
test.describe('the note about today (A-070)', () => {
  test('is on the chip and in its accessible name, apart from the note about her', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T10:45:00-05:00',
      clientNotes: 'Allergic to PPD.',
      visitNote: '6.3 + 20 vol, 35 min',
    });
    await page.goto(`/staff/day?day=${DAY}`);

    // BOTH, and marked differently: ⚑ is the safety line about her, ✎ is
    // about today. Merging them is what buries an allergy under six months of
    // one-off reminders.
    await expect(page.getByText('⚑ Allergic to PPD.')).toBeVisible();
    await expect(page.getByText('✎ 6.3 + 20 vol, 35 min')).toBeVisible();
    // Read aloud one after the other they still cannot be confused.
    await expect(page.getByRole('link', { name: /Ada Chen/ })).toHaveAttribute(
      'aria-label',
      /note: Allergic to PPD\..*today: 6\.3 \+ 20 vol, 35 min/,
    );
  });

  /** The operator's sentence is the specification: *"if it takes three taps to
   *  write '6.3 + 20vol' it goes on the scribble column instead"* — and the
   *  scribble column is binned at six. */
  test('can be written from the stylist’s own day, without leaving it', async ({ page }) => {
    await seedAppointment({ start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T10:45:00-05:00' });
    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}`);

    // A native `<details>`, clicked by its summary — the same shape the desk
    // switcher's spec uses, and for the same reason: the element's own role
    // mapping is not something to assert against.
    await page.locator('summary').filter({ hasText: 'Add a note for this visit' }).click();
    await page.getByLabel('Note for this visit').fill('6.3 + 20 vol, 35 min');
    await page.getByRole('button', { name: 'Save' }).click();

    // It appears on the list she typed it into, which is the whole point — the
    // action revalidates the day rather than only the detail page.
    await expect(page.getByText('✎ 6.3 + 20 vol, 35 min')).toBeVisible();
  });

  test('follows onto the printed sheet, which is where the backwash reads it', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T10:45:00-05:00',
      clientNotes: 'Allergic to PPD.',
      visitNote: 'Bring the reference photo',
    });
    await page.goto(`/staff/day?day=${DAY}&sheet=1`);

    await expect(page.getByText('⚑ Allergic to PPD.')).toBeVisible();
    await expect(page.getByText('✎ Bring the reference photo')).toBeVisible();
  });
});

/**
 * A-076 / D-46 — WHAT IS STILL OPEN.
 *
 * Six o'clock Saturday: twenty-nine went through and eleven are still on
 * `booked` or `checked_in`, because at the till you are taking money and
 * answering the phone. Nothing mentioned them again, and three readers were
 * wrong because of it — utilization, the lapsed round, and CLIENT-04's block.
 *
 * The list is derived, the two answers are the desk's, and NOTHING infers
 * attendance from silence (D-46).
 */
test.describe('what is still open (A-076)', () => {
  /** An appointment that has been and gone with nobody having said what
   *  happened. Yesterday by default, so it is comfortably past and inside the
   *  lookback; `minutesAgo` puts one deliberately OUTSIDE it (A-081). */
  async function unclosed(name: string, status = 'booked', minutesAgo = 24 * 60) {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const client = await prisma.client.create({ data: { businessId: business.id, name, phone: '5125550177' } });
      const startAt = toDate(instant(Math.floor(fromDate(new Date()) / 60_000 - minutesAgo) * 60_000));
      const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
      return await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          status: status as 'booked',
          startAt,
          endAt,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: toLabel(fromDate(startAt), zoneId(business.timezone)).day,
          startWallTime: toLabel(fromDate(startAt), zoneId(business.timezone)).time,
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 14000, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }
  }

  const statusOf = async (id: string) => {
    const prisma = new PrismaClient();
    try {
      return await prisma.appointment.findUniqueOrThrow({ where: { id } });
    } finally {
      await prisma.$disconnect();
    }
  };

  test('is one tap from the day, with a count, and closes one out in two taps', async ({ page }) => {
    const appointment = await unclosed('Olive Open');

    await page.goto(`/staff/day?day=${DAY}`);
    // The COUNT is the point: eleven unclosed appointments are invisible by
    // definition, so a door nobody knows about is a door nobody walks through.
    await page.getByRole('link', { name: 'Still open 1' }).click();

    await expect(page).toHaveURL(/\/staff\/unfinished$/);
    await expect(page.getByRole('link', { name: 'Olive Open' })).toBeVisible();
    // The size of it in the units the owner staffs on.
    await expect(page.getByText(/\$140\.00 of work the week's figures cannot see/)).toBeVisible();
    await expect(page.getByText('never checked in')).toBeVisible();

    await page.getByRole('button', { name: 'Came' }).click();
    await expect(page.getByText('Nothing left open — every appointment that has been and gone has an answer against it.')).toBeVisible();

    const row = await statusOf(appointment.id);
    expect(row.status).toBe('completed');
    // D-46's honest timestamps: nobody knows when she sat down or got up.
    expect(row.checkedInAt).toBeNull();
    expect(row.endedAt).toBeNull();
  });

  /** The other half of the truth, and the one CLIENT-04's counter depends on
   *  the desk tapping as readily as the first. */
  test('records a no-show, so the reliability count is finally told', async ({ page }) => {
    const appointment = await unclosed('Nora Never');

    await page.goto('/staff/unfinished');
    await page.getByRole('button', { name: "Didn't come" }).click();
    await expect(page.getByText(/Nothing left open/)).toBeVisible();

    expect((await statusOf(appointment.id)).status).toBe('no_show');
  });

  /**
   * A-085 / D-50 INVERTED HALF OF THIS TEST, deliberately.
   *
   * A-076 hid the whole link at zero, so that it never became a permanent piece
   * of furniture the desk stops reading. D-49 then recorded what that cost:
   * Phase 8's headline screen had exactly ONE door, and a desk that had never
   * had an unfinished appointment could not know the screen existed.
   *
   * The shell settles it by splitting the two things apart. The DOOR is
   * navigation and is always there; the NUMBER is an errand and appears only
   * when there is one. `exact: true` is what asserts the second half — a link
   * named exactly "Still open" is a link with no badge on it.
   */
  test('the door is there at zero, and the badge is not', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);

    await expect(page.getByRole('link', { name: 'Still open', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Still open \d/ })).toHaveCount(0);
  });

  /**
   * A-081 / D-48 — THE DOOR THAT USED TO LOCK ITSELF.
   *
   * 21 days was the right default and the wrong ceiling: past it a row could
   * never be closed, so `dashboard.ts`, `lapsed.ts` and `reliability.ts` stayed
   * permanently wrong about it and D-46's whole argument — the reports get
   * right because the desk can tell them the truth — had no door left. The
   * BADGE deliberately does not widen with the box: the badge is tonight's
   * errand, the box is the backlog behind it, and asserting both here is what
   * stops a later "make them consistent" tidy-up from undoing the decision.
   */
  test('widens past the default window, and the badge does not follow', async ({ page }) => {
    await unclosed('Winnie Winter', 'booked', 40 * 24 * 60);

    await page.goto('/staff/unfinished');
    await expect(
      page.getByText('Nothing left open — every appointment that has been and gone has an answer against it.'),
    ).toBeVisible();

    await page.getByLabel('Going back (days)').fill('60');
    await page.getByRole('button', { name: 'Show' }).click();

    await expect(page).toHaveURL(/days=60/);
    await expect(page.getByRole('link', { name: 'Winnie Winter' })).toBeVisible();
    await expect(page.getByText('Showing the last 60 days.')).toBeVisible();

    // The badge stays on the 21-day errand — a forty-day-old row is not a thing
    // the desk is closing out tonight. The DOOR is still there (D-50); it is
    // the NUMBER that must not follow the box.
    await page.goto(`/staff/day?day=${DAY}`);
    await expect(page.getByRole('link', { name: 'Still open', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Still open \d/ })).toHaveCount(0);
  });

  test('has no accessibility violations', async ({ page }) => {
    await unclosed('Olive Open');
    await page.goto('/staff/unfinished');
    await expectNoAxeViolations(page);
  });
});

/**
 * A-093 — A SEGMENTED VISIT IS ONE CHIP, DRAWN OVER ALL OF IT.
 *
 * `findBusyAppointments` returns one row per WORKED block keyed by the
 * appointment's id (D-29), and the day view built its lookup with a last-wins
 * `Map` — so a colour reached the grid as its SECOND half. Measured on the
 * seeded book before the fix: Tom Byrne's 09:00–11:00 colour was drawn at
 * 10:25 and 55 minutes tall, and Dana's column showed EMPTY for the hour she
 * spends applying it. "Who is with a client at quarter past nine?" is read off
 * this grid, and it answered wrong.
 *
 * The assertion is geometric because the defect was geometric: the chip's box
 * must CONTAIN the develop gap's box. Asserting the chip's top alone would
 * pass on a one-block fixture, which is every other fixture in this file.
 */
test.describe('a colour on the grid (A-093)', () => {
  test('is one chip that spans its own develop time', async ({ page }) => {
    await seedAppointment({
      start: '2026-06-09T09:00:00-05:00',
      end: '2026-06-09T10:00:00-05:00',
      // 20 applying, 25 developing, 15 finishing.
      segmentPattern: [20, 25, 15],
    });
    await page.goto(`/staff/day?day=${DAY}`);

    const chip = page.locator('li').filter({ hasText: 'Ada Chen' }).first();
    // The develop time comes back as a bookable gap — that is the point of
    // segments — and it is the box the chip has to be drawn around.
    const gap = page.getByRole('link', { name: /Book 25 minutes free/ }).first();

    const chipBox = await chip.boundingBox();
    const gapBox = await gap.boundingBox();
    expect(chipBox).not.toBeNull();
    expect(gapBox).not.toBeNull();
    expect(chipBox!.y).toBeLessThan(gapBox!.y);
    expect(chipBox!.y + chipBox!.height).toBeGreaterThan(gapBox!.y + gapBox!.height);
  });
});

/**
 * A-099 — TWO CLIENTS AT TEN O'CLOCK, AND D-8 PROMISES IN WRITING THAT THE DAY
 * VIEW DRAWS BOTH.
 *
 * D-8's last clause: an override writes a zero-width blocked range plus
 * `overriddenFromRange` "so the constraint never lies and the day view renders
 * the true collision". It did not. Both chips computed `top=60 minutes=…`,
 * `CHIP_SHELL` is `absolute inset-x-1` for EVERY chip in the product, and
 * `GridItem` carried no lane, no offset and no width at all — so the later one
 * in DOM order painted over the earlier one, opaque and `overflow-hidden`.
 * **The client who was already in the book is the one who disappeared**, under
 * a chip wearing the override marker, which reads as one deliberate override
 * rather than as two people at ten. The desk overrides IN ORDER to see both.
 *
 * THE ASSERTIONS ARE ON BOTH CHIPS, not on the pair. `toBeVisible()` on the
 * override alone passes against the bug — it is the one that survived. What
 * fails against it is the earlier client's box existing and not being underneath
 * the later one's.
 *
 * AND ON ALL THREE READERS OF `GridColumn.items`. The grid says it with
 * geometry; the printed sheet and the stylist's phone list have no geometry and
 * put the pair on CONSECUTIVE ROWS, which is the shape of a queue rather than
 * of a collision — so they say it in words, from the same `concurrent` the
 * view model computes once.
 */
test.describe('two clients in one hour (A-099, D-8)', () => {
  /** 09:00 is not scenery: lanes are per overlapping CLUSTER, and a fixture
   *  with nothing but the pair in it cannot tell a correct implementation from
   *  one that halves the whole column. */
  async function seedTheDoubleBooking() {
    await seedAppointment({
      start: '2026-06-09T09:00:00-05:00',
      end: '2026-06-09T09:45:00-05:00',
      clientName: 'Ada Chen',
    });
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T11:00:00-05:00',
      clientName: 'Mei Chen',
    });
    await seedAppointment({
      start: '2026-06-09T10:00:00-05:00',
      end: '2026-06-09T11:30:00-05:00',
      clientName: 'Ruth Adeyemi',
      isOverride: true,
      overrideReason: 'Mother of the bride — Dana said to squeeze her in.',
    });
  }

  test('draws both of them, side by side, and neither on top of the other', async ({ page }) => {
    await seedTheDoubleBooking();
    // No `provider=`: that tab renders the LIST. The grid is the everyone view.
    await page.goto(`/staff/day?day=${DAY}`);

    const first = page.locator('li').filter({ hasText: 'Mei Chen' }).first();
    const second = page.locator('li').filter({ hasText: 'Ruth Adeyemi' }).first();
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    const a = (await first.boundingBox())!;
    const b = (await second.boundingBox())!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // They start at the same instant, so they are drawn at the same height —
    // which is exactly why one could hide the other.
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    // The whole item, in one line: no horizontal overlap.
    const apart = a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1;
    expect(apart, `chips overlap: ${JSON.stringify({ a, b })}`).toBe(true);

    // ONE double-booked hour must not halve the day around it. Ada's 09:00 is
    // alone in its cluster and keeps the whole column.
    const alone = (await page.locator('li').filter({ hasText: 'Ada Chen' }).first().boundingBox())!;
    expect(alone.width).toBeGreaterThan(a.width * 1.5);
  });

  test('says it in the accessible name, where there is no geometry to read', async ({ page }) => {
    await seedTheDoubleBooking();
    // No `provider=`: that tab renders the LIST. The grid is the everyone view.
    await page.goto(`/staff/day?day=${DAY}`);

    await expect(page.getByRole('link', { name: /Mei Chen.*at the same time as Ruth Adeyemi/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Ruth Adeyemi.*at the same time as Mei Chen/ })).toBeVisible();
  });

  test('prints it on the sheet, where consecutive rows would read as a queue', async ({ page }) => {
    await seedTheDoubleBooking();
    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}&sheet=1`);

    await expect(page.getByText('At the same time as Ruth Adeyemi.')).toBeVisible();
    await expect(page.getByText('At the same time as Mei Chen.')).toBeVisible();
    // §5.4.11 — and the typed reason beside it, so the paper says a human
    // decided this rather than that the printer repeated itself.
    await expect(page.getByText('Mother of the bride — Dana said to squeeze her in.')).toBeVisible();
    // Ada is alone at 09:00 and must not be told she has company.
    await expect(page.getByText(/At the same time as Ada Chen/)).toHaveCount(0);
  });

  test('says it on the stylist’s own list, which is the phone in her pocket', async ({ page }) => {
    await seedTheDoubleBooking();
    await page.goto(`/staff/day?day=${DAY}&provider=${await danaId()}`);

    await expect(page.getByText('At the same time as Ruth Adeyemi')).toBeVisible();
    await expect(page.getByText('At the same time as Mei Chen')).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await seedTheDoubleBooking();
    // No `provider=`: that tab renders the LIST. The grid is the everyone view.
    await page.goto(`/staff/day?day=${DAY}`);
    await expectNoAxeViolations(page);
  });
});

/**
 * A-113 — THE SAME PROMISE, ON THE BOOK A DEMO ACTUALLY OPENS.
 *
 * Everything above hand-builds its pair, which is how A-099 could be right and
 * still invisible on every install: the density seed held no overlapping
 * same-provider pair to draw. This runs the REAL seed and reads the pair back
 * rather than naming it — which clients and which day are the seed's business —
 * and asserts what the screen says about them.
 *
 * `now` is FROZEN, as in the seed's own tests: the moving book is anchored to
 * it, and `?day=` pins the page, so nothing here reads the wall clock.
 */
test.describe('the seeded double-booking (A-113)', () => {
  test('is drawn side by side on the grid, legibly, and printed as a pair on the sheet', async ({ page }) => {
    // Hundreds of appointments through the real write path, one at a time.
    test.setTimeout(240_000);
    const prisma = new PrismaClient();
    let pair: { day: string; providerId: string; reason: string; squeezedIn: string; already: string };
    try {
      await seedDensity(prisma, { now: at('2026-09-02T15:30:00-05:00') });
      const override = await prisma.appointment.findFirstOrThrow({
        where: { isOverride: true },
        select: { providerId: true, startAt: true, startDay: true, overrideReason: true, client: { select: { name: true } } },
      });
      const other = await prisma.appointment.findFirstOrThrow({
        where: { providerId: override.providerId, startAt: override.startAt, isOverride: false },
        select: { client: { select: { name: true } } },
      });
      pair = {
        day: override.startDay,
        providerId: override.providerId,
        reason: override.overrideReason!,
        squeezedIn: override.client!.name!,
        already: other.client!.name!,
      };
    } finally {
      await prisma.$disconnect();
    }

    // No `provider=`: that tab renders the LIST. The grid is the everyone view.
    // Found by the accessible name's pairing, never by a name alone: the seeded
    // clients recur all day, and only these two are "at the same time as".
    await page.goto(`/staff/day?day=${pair.day}`);
    const chip = (who: string, withWhom: string) =>
      page.getByRole('link', { name: new RegExp(`${who}.*at the same time as ${withWhom}`) }).locator('xpath=ancestor::li[1]');
    const already = chip(pair.already, pair.squeezedIn);
    const squeezed = chip(pair.squeezedIn, pair.already);
    await expect(already).toBeVisible();
    await expect(squeezed).toBeVisible();

    const a = (await already.boundingBox())!;
    const b = (await squeezed.boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    const apart = a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1;
    expect(apart, `chips overlap: ${JSON.stringify({ a, b })}`).toBe(true);

    // LEGIBLE, not merely present. The name is the part of line one that gives
    // way in a narrow lane (the chip's own truncation order), so `toBeVisible`
    // passes on "Ma…" — measure whether the text actually fits.
    for (const [box, name] of [
      [already, pair.already],
      [squeezed, pair.squeezedIn],
    ] as const) {
      const label = box.getByText(name, { exact: true });
      await expect(label).toBeVisible();
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), `${name} is cut off`).toBe(true);
    }

    // The paper has no geometry, so it says it in words — on BOTH rows, and the
    // override's row carries the reason somebody typed.
    await page.goto(`/staff/day?day=${pair.day}&provider=${pair.providerId}&sheet=1`);
    const row = (who: string, withWhom: string) =>
      page.locator('tbody tr').filter({ hasText: `At the same time as ${withWhom}.` }).filter({ hasText: who });
    await expect(row(pair.already, pair.squeezedIn)).toHaveCount(1);
    await expect(row(pair.squeezedIn, pair.already)).toHaveCount(1);
    await expect(row(pair.squeezedIn, pair.already)).toContainText(pair.reason);
  });
});
