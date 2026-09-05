/**
 * A-018 — running late and pushing the column (APPT-03, APPT-04, D-22).
 *
 * The day is computed forward to the next Tuesday the seeded roster works:
 * pushing a column rewrites `startAt`, and a past day would be refused for the
 * same reason booking one is.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { addDays, calendarDay, fromDate, instant, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

let DAY: string;
let ZONE: string;

/** A wall-clock time on the test's day, as an instant, through the one
 *  conversion module. */
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

/** A time, or a time with a status on it — A-090 needs a column carrying more
 *  than one status at once, because the whole question is where the projection
 *  stops. */
type Seeded = string | { time: string; status: string };

async function seedAppointments(times: readonly Seeded[]) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    for (const [index, seeded] of times.entries()) {
      const { time, status } = typeof seeded === 'string' ? { time: seeded, status: 'booked' } : seeded;
      const client = await prisma.client.create({
        data: { businessId: business.id, name: `Client ${index + 1}`, phone: `51255501${index}0` },
      });
      const startAt = at(time);
      const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          startAt,
          endAt,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: DAY,
          startWallTime: time,
          status: status as 'booked',
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

test.describe('running late (A-018)', () => {
  /**
   * The Milestone 1 operator review's headline (R-1): the system could record
   * that an appointment RAN late but not that the day IS late — so the website
   * kept selling slots while the client sat in the waiting area.
   */
  test('marks a column behind, and the delta shows on the header', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('40');
    await dana.getByRole('button', { name: 'Set' }).click();

    await expect(page.getByText('+40 min')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.providerRunningLate.findFirstOrThrow();
      expect(row.minutes).toBe(40);
      // D-9: a claim somebody made, with their name on it.
      expect(row.setByActor).toBe('staff');
    } finally {
      await prisma.$disconnect();
    }
  });

  test('clears in one tap', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByText('+30 min')).toBeVisible();

    await page.getByRole('button', { name: 'Back on time' }).click();
    await expect(page.getByText('+30 min')).toHaveCount(0);

    const prisma = new PrismaClient();
    try {
      expect(await prisma.providerRunningLate.count()).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  /** APPT-03: the projected start, BESIDE the scheduled one — the client was
   *  booked for 14:00 and her confirmation still says so. */
  test('projects revised starts down the column without moving anything', async ({ page }) => {
    await seedAppointments(['14:00']);
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();

    await expect(page.getByText('→ likely 14:30')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow();
      // The delta is a claim, not a rewrite (D-22).
      expect(appointment.startWallTime.trim()).toBe('14:00');
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * A-090 — WHERE THE PROJECTION STOPS, which is the whole of this item's risk.
   *
   * The test above seeds one `booked` chip, and that is exactly how the defect
   * survived: `view-model.ts` hand-typed `status === 'booked'`, a status list of
   * ONE and narrower than both of its neighbours. So a CONFIRMED client in a
   * column forty minutes behind appeared on the desk's own ring-round as
   * "booked 14:00, likely 14:40" and her chip three inches away on the same
   * screen showed 14:00 and no projection at all — two answers to one question,
   * in one glance.
   *
   * The column below carries three statuses at once because the boundary is the
   * subject: `confirmed` and `checked_in` are still to come and both project;
   * `in_progress` is in the chair, and a projected START on her is not late, it
   * is wrong.
   */
  test('projects onto everyone who has not started, and stops at the chair', async ({ page }) => {
    await seedAppointments([
      { time: '10:00', status: 'in_progress' },
      { time: '14:00', status: 'confirmed' },
      { time: '15:00', status: 'checked_in' },
    ]);
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('40');
    await dana.getByRole('button', { name: 'Set' }).click();

    await expect(page.getByText('→ likely 14:40')).toBeVisible();
    await expect(page.getByText('→ likely 15:40')).toBeVisible();
    // She is in the chair. Nothing is projected onto her, at 10:40 or at all.
    await expect(page.getByText('→ likely 10:40')).toHaveCount(0);
    await expect(dana.getByText('→ likely')).toHaveCount(2);

    // THE TWO TIMES IN THE ACCESSIBLE NAME (§4). Not two bare clock readings in
    // one sentence — each one says which time it is.
    await expect(
      page.getByRole('link', { name: /booked for 14:00, likely to start 14:40/ }),
    ).toBeVisible();

    // NEVER COLOUR ALONE (§4): the status is a word on the chip, not a tint.
    // `checked_in` and `in_progress` share one intent and are told apart here.
    await expect(dana.getByText('Confirmed', { exact: true })).toBeVisible();
    await expect(dana.getByText('Here', { exact: true })).toBeVisible();
    await expect(dana.getByText('In chair', { exact: true })).toBeVisible();
  });
});

test.describe('pushing the column (A-018)', () => {
  test('previews what would move, then moves it and tells the clients', async ({ page }) => {
    await seedAppointments(['14:00', '15:00']);
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    // The <details> summary, which is what carries the name — the group
    // element around it is unnamed.
    await dana.getByText('Push the column').click();
    await dana.getByLabel('Push by').fill('30');
    await dana.getByRole('button', { name: 'Preview' }).click();

    // Named before anything moves.
    await expect(dana.getByText(/14:00 → 14:30/)).toBeVisible();
    await expect(dana.getByText(/15:00 → 15:30/)).toBeVisible();

    await dana.getByLabel('Why?').fill('Dana is running behind');
    await dana.getByRole('button', { name: /^Move 2 and tell them$/ }).click();

    await expect(dana.getByText(/Moved 2 appointments\. 2 clients told\./)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
      expect(rows.map((r) => r.startWallTime.trim())).toEqual(['14:30', '15:30']);
      // APPT-04's notice: a column that moved without anybody being told is
      // the silent change Goal 2 forbids.
      expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.running_late' } })).toBe(2);
      // And it is on the record, with a reason.
      const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { type: 'column_pushed' } });
      expect(event.reason).toBe('Dana is running behind');
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * D-26: the push moves what it can and NAMES what it left. Decided at demo
   * checkpoint 2, where all-or-nothing capped the seeded Saturday at a
   * five-minute push while the stylist was 38 minutes behind.
   */
  test('moves what fits and names the one it left behind', async ({ page }) => {
    await seedAppointments(['10:00', '16:30']); // the 16:30 ends 17:15, past the 17:00 close
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByText('Push the column').click();
    await dana.getByLabel('Push by').fill('30');
    await dana.getByRole('button', { name: 'Preview' }).click();

    await expect(dana.getByText(/stays: would run past closing/)).toBeVisible();
    await dana.getByRole('button', { name: /^Move 1 and tell them$/ }).click();

    await expect(dana.getByText(/Left where they were:/)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
      // The 10:00 moved; the client at the end of the day is exactly where
      // she expects to be, and the desk has been told her name.
      expect(rows.map((r) => r.startWallTime.trim())).toEqual(['10:30', '16:30']);
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * A-066 / D-43 — THE SEAM BETWEEN THE TWO HALVES OF A-018.
   *
   * The desk sets +30 correctly, Dana does not catch up, so they push the column
   * +30. Before this item the delta was still 30: the chip read "→ likely 15:00"
   * against a 14:30 it had just been moved to, the ring-round wanted six clients
   * phoned about a delay already applied to their booked times, and the engine
   * kept refusing to sell a gap that genuinely existed.
   *
   * Asserts what the PAGE SAYS, not that it answered.
   */
  test('a clean push works the delta off, so nothing double-counts it', async ({ page }) => {
    await seedAppointments(['14:00']);
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByText('→ likely 14:30')).toBeVisible();

    await dana.getByText('Push the column').click();
    await dana.getByLabel('Push by').fill('30');
    await dana.getByRole('button', { name: 'Preview' }).click();
    // Stated BEFORE the desk commits — D-43's preview half.
    await expect(dana.getByText(/Dana then shows on time/)).toBeVisible();

    await dana.getByRole('button', { name: /^Move 1 and tell them$/ }).click();
    await expect(dana.getByText(/Now back on time\./)).toBeVisible();

    // The claim is gone, and with it every projection standing on top of a
    // startAt that has already absorbed it.
    await expect(dana.getByText('+30 min')).toHaveCount(0);
    await expect(page.getByText(/→ likely/)).toHaveCount(0);
  });

  test('has no accessibility violations with a column running late', async ({ page }) => {
    await seedAppointments(['14:00']);
    await page.goto(`/staff/day?day=${DAY}`);
    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByText('+30 min')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

/**
 * A-059 (APPT-03) — THE RING-ROUND.
 *
 * The half A-018 left out: the delta makes the grid amber and stops the website
 * selling the next forty minutes, and tells not one of the people already on
 * their way. So the desk rings them, and kept the list of who it had got to on
 * a Post-it — the shadow calendar, one layer down from the one A-018 removed.
 *
 * THESE SEED AGAINST THE REAL CLOCK, unlike everything above, and have to: the
 * list is "who is coming in the next three hours", measured from a `now` the
 * page reads for itself. So the appointment goes an hour out from the actual
 * moment the test runs, and a whole-day DATE OVERRIDE opens Dana on whatever
 * day that lands on. Skipping when the salon happens to be shut would make
 * this a test that runs on a developer's laptop at 2pm and never in CI.
 */
test.describe('the ring-round (A-059)', () => {
  /** An appointment an hour from now, with Dana opened all day on whichever
   *  day that is. Returns the wall-clock label the grid will render. */
  async function seedAnHourFromNow(): Promise<string> {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });

      // Whole minutes: the schema CHECK-constrains it, because half-open
      // back-to-back booking depends on the ends matching exactly.
      const startAt = toDate(instant(Math.floor(fromDate(new Date()) / 60_000) * 60_000 + 60 * 60_000));
      const label = toLabel(fromDate(startAt), zoneId(ZONE));
      DAY = label.day;

      // Dana, open all day, on whatever day an hour from now falls on — so
      // this runs at 3pm and at 3am with the same result.
      //
      // BOTH levels: `resolveAvailableWindows` intersects the business
      // pattern with the provider pattern, and returns closed if EITHER has
      // no windows (packages/core/availability/windows.ts). The seeded
      // business only has weekly hours Tue-Sat — a provider-only override
      // left the whole column reading closed on Sunday and Monday, which is
      // exactly the day-of-week this test's own comment claims not to care
      // about.
      for (const providerId of [null, dana.id]) {
        const override = await prisma.dateOverride.create({
          data: { businessId: business.id, providerId, day: DAY, isClosed: false },
        });
        await prisma.dateOverrideWindow.create({
          data: { businessId: business.id, dateOverrideId: override.id, open: '00:00', close: '23:59' },
        });
      }

      const client = await prisma.client.create({
        data: { businessId: business.id, name: 'Client 1', phone: '5125550100' },
      });
      const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          startAt,
          endAt,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: DAY,
          startWallTime: label.time,
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
      return label.time;
    } finally {
      await prisma.$disconnect();
    }
  }

  test('lists who is still on her way, with the projected time and a number to ring', async ({ page }) => {
    const time = await seedAnHourFromNow();

    await page.goto(`/staff/day?day=${DAY}`);
    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();

    const list = page.getByRole('region', { name: 'Still to ring for Dana' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('heading', { name: 'Still to ring: 1 of 1' })).toBeVisible();

    // BOTH times. Her confirmation says the first one and the desk opens the
    // call with it; the second is what is really going to happen.
    await expect(list.getByText(time, { exact: true })).toBeVisible();
    const projected = toLabel(instant(fromDate(at(time)) + 30 * 60_000), zoneId(ZONE)).time;
    await expect(list.getByText(`→ ${projected}`)).toBeVisible();

    // TEL, not a number to read off a screen and re-key at a busy desk.
    await expect(list.getByRole('link', { name: '5125550100' })).toHaveAttribute('href', 'tel:5125550100');

    /**
     * A-044's line, held: NOTHING was sent. A screen saying "queued" beside a
     * client's name is read by staff as "no need to call her", which is the
     * precise opposite of what this list exists to make happen.
     */
    await expect(list.getByText(/Nobody has been messaged/)).toBeVisible();
    const prisma = new PrismaClient();
    try {
      expect(await prisma.notificationOutbox.count()).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  /** The Post-it, replaced: the second person at the desk must not re-ring the
   *  first six, and "back on time" must not leave this morning's ticks sitting
   *  under this afternoon's claim. */
  test('remembers who has been rung, and forgets it when the delta clears', async ({ page }) => {
    await seedAnHourFromNow();

    await page.goto(`/staff/day?day=${DAY}`);
    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();

    const list = page.getByRole('region', { name: 'Still to ring for Dana' });
    await list.getByRole('button', { name: 'Mark Client 1 as told' }).click();

    await expect(list.getByRole('heading', { name: 'Still to ring: 0 of 1' })).toBeVisible();
    // A-037: stamped with a person, not "the front desk" — which is four people.
    await expect(list.getByText(/Told at \d\d:\d\d by /)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.runningLateTold.findFirstOrThrow();
      // The number she was actually given, not whatever the delta becomes.
      expect(row.minutesToldAbout).toBe(30);
      expect(row.toldByActor).toBe('staff');
    } finally {
      await prisma.$disconnect();
    }

    await page.getByRole('button', { name: 'Back on time' }).click();
    await expect(list).toHaveCount(0);

    const after = new PrismaClient();
    try {
      // The cascade, from the browser: no cleanup job, no second write path.
      expect(await after.runningLateTold.count()).toBe(0);
    } finally {
      await after.$disconnect();
    }
  });

  test('has no accessibility violations with a ring-round on screen', async ({ page }) => {
    await seedAnHourFromNow();

    await page.goto(`/staff/day?day=${DAY}`);
    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByLabel('Behind by').fill('30');
    await dana.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByRole('region', { name: 'Still to ring for Dana' })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});

/** A-059's fold-in. The field always took a minus and nothing said so. */
test.describe('pulling the column earlier (A-059)', () => {
  test('says the minus is allowed, and pulls the column back when it is used', async ({ page }) => {
    await seedAppointments(['14:00', '15:00']);
    await page.goto(`/staff/day?day=${DAY}`);

    const dana = page.getByRole('region', { name: /Dana/ });
    await dana.getByText('Push the column').click();
    await expect(dana.getByText(/Minus to pull the column earlier/)).toBeVisible();

    await dana.getByLabel('Push by').fill('-20');
    await dana.getByRole('button', { name: 'Preview' }).click();
    await expect(dana.getByText(/14:00 → 13:40/)).toBeVisible();

    await dana.getByLabel('Why?').fill('Dana has caught up');
    await dana.getByRole('button', { name: /^Move 2 and tell them$/ }).click();
    await expect(dana.getByText(/Moved 2 appointments\./)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const rows = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
      expect(rows.map((r) => r.startWallTime.trim())).toEqual(['13:40', '14:40']);
      // She is not "running behind" — she is being asked to come in earlier,
      // and that is the sentence the client reads.
      expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.moved_earlier' } })).toBe(2);
      expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.running_late' } })).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
