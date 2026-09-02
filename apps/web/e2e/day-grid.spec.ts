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
  await expect(page).toHaveURL(/\/staff$/);
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
}) {
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
        notes: options.visitNote ?? null,
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
   *  happened. Yesterday, so it is comfortably past and inside the lookback. */
  async function unclosed(name: string, status = 'booked') {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const client = await prisma.client.create({ data: { businessId: business.id, name, phone: '5125550177' } });
      const startAt = toDate(instant(Math.floor(fromDate(new Date()) / 60_000 - 24 * 60) * 60_000));
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
    await page.getByRole('link', { name: 'Still open (1)' }).click();

    await expect(page).toHaveURL(/\/staff\/unfinished$/);
    await expect(page.getByRole('link', { name: 'Olive Open' })).toBeVisible();
    // The size of it in the units the owner staffs on.
    await expect(page.getByText(/\$140\.00 of work the week's figures cannot see/)).toBeVisible();
    await expect(page.getByText('never checked in')).toBeVisible();

    await page.getByRole('button', { name: 'She came' }).click();
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
    await page.getByRole('button', { name: "She didn't" }).click();
    await expect(page.getByText(/Nothing left open/)).toBeVisible();

    expect((await statusOf(appointment.id)).status).toBe('no_show');
  });

  /** The badge disappears at zero, so it never becomes a permanent piece of
   *  furniture the desk stops reading. */
  test('the tab is not there when nothing is open', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);

    await expect(page.getByRole('link', { name: /Still open/ })).toHaveCount(0);
  });

  test('has no accessibility violations', async ({ page }) => {
    await unclosed('Olive Open');
    await page.goto('/staff/unfinished');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
