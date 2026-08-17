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
import { addDays, calendarDay, fromDate, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
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

    const option = page.getByRole('button', { name: /at \d\d:\d\d$/ }).first();
    if (await option.count()) {
      await option.click();
      await page.getByRole('button', { name: 'No name' }).click();
      await page.getByRole('button', { name: 'Book', exact: true }).click();
      await expect(page.getByText('Booked.')).toBeVisible();
    } else {
      // Outside the seeded opening hours there is genuinely nobody free, and
      // saying so is the correct behaviour rather than a failure.
      await expect(page.getByText(/Nobody is free for that today/)).toBeVisible();
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
    await page.getByLabel('Find a client by name or phone number').fill('Ada');

    await expect(page.getByText(/already has 09:00 with Priya/)).toBeVisible();

    // And it does not stop the booking — mum and daughter share a number, and
    // even the same client twice is the salon's call (D-17).
    await page.getByRole('button', { name: /Ada Chen/ }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Booked.')).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto(`/staff/day?day=${DAY}`);
    await page.getByRole('link', { name: /Book \d+ minutes free/ }).first().click();
    await page.getByRole('button', { name: /^Cut\d/ }).click();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
