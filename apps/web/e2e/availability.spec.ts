import AxeBuilder from '@axe-core/playwright';
import { PrismaClient } from '@bookable/db';
import { createWeeklyWindow } from '@bookable/db/availability';
import { addDays, calendarDay, fromDate, instant, instantFromIso, resolve, toDate, toLabel, wallTime, weekdayOf, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

/** Through the one conversion module, like every other spec (D-3/D-4). */
const at = (iso: string) => toDate(instantFromIso(iso));

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

async function addProvider(page: import('@playwright/test').Page, name: string) {
  await page.goto('/staff/providers');
  await page.getByLabel('Add a provider').fill(name);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function providerIdFor(displayName: string): Promise<string> {
  const prisma = new PrismaClient();
  try {
    return (await prisma.provider.findFirstOrThrow({ where: { displayName } })).id;
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('availability (A-007)', () => {
  test('refuses an anonymous visitor', async ({ page }) => {
    await page.goto('/staff/availability');
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  test('business hours can be set and persist', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('#open-').fill('09:00');
    await page.locator('#close-').fill('18:00');
    await page.getByRole('button', { name: 'Add hours' }).click();

    await expect(page.getByText('09:00–18:00')).toBeVisible();
    // A-052 (operator R-8): who set it, resolved from the signed-in session —
    // not a placeholder, the actual name the seed gave this account.
    await expect(page.getByText('set by Front desk')).toBeVisible();
    await page.reload();
    await expect(page.getByText('09:00–18:00')).toBeVisible();
    await expect(page.getByText('set by Front desk')).toBeVisible();
  });

  // AVAIL-01: never swapped, never silently empty.
  test('refuses a window that closes before it opens', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('#open-').fill('17:00');
    await page.locator('#close-').fill('09:00');
    await page.getByRole('button', { name: 'Add hours' }).click();

    await expect(page.getByText(/does not come after/)).toBeVisible();
    await expect(page.getByText('17:00–09:00')).toHaveCount(0);
  });

  test('refuses a break that falls outside its window', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('#open-').fill('09:00');
    await page.locator('#close-').fill('17:00');
    await page.locator('#breakOpen-').fill('18:00');
    await page.locator('#breakClose-').fill('19:00');
    await page.getByRole('button', { name: 'Add hours' }).click();

    await expect(page.getByText(/falls outside its window/)).toBeVisible();
  });

  test('a provider gets her own hours, separate from the business', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();
    await expect(page.getByRole('heading', { name: 'Weekly hours' })).toBeVisible();

    await page.locator('input[name="open"]').first().fill('10:00');
    await page.locator('input[name="close"]').first().fill('16:00');
    await page.getByRole('button', { name: 'Add hours' }).click();
    await expect(page.getByText('10:00–16:00')).toBeVisible();

    // The business pattern is untouched by a provider's hours.
    await page.getByRole('link', { name: 'The business' }).click();
    await expect(page.getByText('10:00–16:00')).toHaveCount(0);
  });

  // AVAIL-02: an override REPLACES, never merges.
  test('a date override is recorded and shown as replacing that day', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('input[name="day"]').fill('2026-12-24');
    await page.locator('input[name="open"]').nth(1).fill('10:00');
    await page.locator('input[name="close"]').nth(1).fill('14:00');
    await page.locator('input[name="reason"]').first().fill('Christmas Eve');
    await page.getByRole('button', { name: 'Save date' }).click();

    await expect(page.getByText('2026-12-24')).toBeVisible();
    await expect(page.getByText('10:00–14:00')).toBeVisible();
    await expect(page.getByText('Christmas Eve')).toBeVisible();
    // R-8's other half: not just WHY (the reason, already shown) but WHO.
    await expect(page.getByText('set by Front desk')).toBeVisible();
  });

  test('a closed-all-day override is recorded as closed', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/availability');

    await page.locator('input[name="day"]').fill('2026-07-04');
    await page.locator('input[name="isClosed"]').check();
    await page.locator('input[name="reason"]').first().fill('Independence Day');
    await page.getByRole('button', { name: 'Save date' }).click();

    await expect(page.getByText('2026-07-04')).toBeVisible();
    await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  });

  /**
   * AVAIL-03 / D-2: recording time off over an existing appointment must
   * SUCCEED. Refusing it is not the design — surfacing what it stranded for a
   * human is (A-019).
   */
  test('time off is accepted, with an explicit offset (D-4)', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();

    await page.locator('input[name="startAt"]').fill('2026-06-09T14:00:00-05:00');
    await page.locator('input[name="endAt"]').fill('2026-06-09T16:00:00-05:00');
    await page.locator('input[name="reason"]').last().fill('Dentist');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // "Time off" also appears in the section heading, the explanatory
    // paragraph and the <option> — scope to the recorded row itself.
    const row = page.getByRole('listitem').filter({ hasText: 'Dentist' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Time off')).toBeVisible();
    // A-052: "who blocked Dana's 2-4, and why?" — the reason was already on
    // the row (Dentist); this is the who.
    await expect(row.getByText('blocked by Front desk')).toBeVisible();
  });

  /**
   * A-041 (operator P-8). The write ALWAYS succeeds (D-2/A-007) — this test
   * is about the sentence that comes back with it. The screen's own copy has
   * promised "which appointments it strands is shown" since A-007; nothing
   * ever computed it until this row.
   */
  test('time off says what it just stranded, and links to the list', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const provider = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.create({
        data: { businessId: business.id, name: 'Cut', durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, priceCents: 5500 },
      });
      const client = await prisma.client.create({ data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' } });
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: provider.id,
          clientId: client.id,
          startAt: at('2026-06-09T15:00:00.000Z'),
          endAt: at('2026-06-09T15:45:00.000Z'),
          blockedStart: at('2026-06-09T15:00:00.000Z'),
          blockedEnd: at('2026-06-09T15:45:00.000Z'),
          startDay: '2026-06-09',
          startWallTime: '10:00',
          status: 'booked',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();

    // Covers the whole morning, including her 10:00.
    await page.locator('input[name="startAt"]').fill('2026-06-09T09:00:00-05:00');
    await page.locator('input[name="endAt"]').fill('2026-06-09T12:00:00-05:00');
    await page.locator('input[name="reason"]').last().fill('Called in sick');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // The write is NOT refused (D-2/A-007) — it already happened. This is
    // what the response says about it.
    await expect(page.getByText('Time off added.')).toBeVisible();
    await expect(page.getByText('1 appointment now stranded.')).toBeVisible();

    await page.getByRole('link', { name: 'Deal with them' }).click();
    await expect(page).toHaveURL(/\/staff\/conflicts\?day=2026-06-09/);
    await expect(page.getByText('Ada Chen')).toBeVisible();
  });

  /**
   * A-047 — THE DELETES, WHICH ARE THE WORST OF THE FOUR.
   *
   * Removing a Thursday window IS "I don't work Thursdays any more", and it
   * silently orphaned every future Thursday booking: the action returned a
   * bare `{ ok: true }`, and the form discarded even that.
   *
   * The fixture is computed from the real clock rather than pinned to a date,
   * because this is one of the few paths whose answer genuinely depends on
   * `now` — an hours edit cannot strand a client who already came in, so a
   * fixture in the past reports zero and asserts nothing.
   */
  test('removing a weekly window says who it stranded, and leaves them booked', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    const prisma = new PrismaClient();
    let day: string;
    let weekday: number;
    try {
      const business = await prisma.business.findFirstOrThrow();
      const zone = zoneId(business.timezone);
      // Three weeks out, AT MIDDAY — never at whatever time-of-day the suite
      // happens to run.
      //
      // This used to be `Date.now() + 21 days`, which pinned the appointment
      // to the current wall-clock time. Run it after ~23:14 and a 45-minute
      // booking runs past the 23:59 window close this test adds, so the test
      // stranded its own fixture and failed — reproduced at 23:31 by A-055's
      // sweep. "Every test supplies a frozen time; a test that reads the clock
      // is wrong even when it passes" (CLAUDE.md) applies to the FIXTURE as
      // much as to the engine.
      const targetDay = addDays(calendarDay(toLabel(fromDate(new Date()), zone).day), 21);
      const resolved = resolve(targetDay, wallTime('12:00'), zone);
      if (resolved.kind !== 'unique') throw new Error(`12:00 is not unique on ${targetDay}`);
      const startAt = toDate(resolved.at);
      const label = toLabel(fromDate(startAt), zone);
      day = label.day;
      weekday = weekdayOf(calendarDay(label.day));

      const provider = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      // Effective availability is business ∩ provider (AVAIL-04), so the
      // business has to be open that weekday or Dana's own hours cannot hold
      // anything. Without this the ADD reports the booking stranded — which is
      // correct, and would make the assertion below ambiguous about which
      // write said it.
      await createWeeklyWindow(
        prisma,
        {
          businessId: business.id,
          providerId: null,
          weekday: weekdayOf(calendarDay(label.day)),
          open: '00:00',
          close: '23:59',
          endsNextDay: false,
        },
        { createdByActor: 'staff', actorRef: 'fixture' },
      );
      const service = await prisma.service.create({
        data: { businessId: business.id, name: 'Cut', durationMinutes: 45, priceCents: 5500 },
      });
      const client = await prisma.client.create({
        data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' },
      });
      const endAt = toDate(instant(startAt.getTime() + 45 * 60_000));
      await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: provider.id,
          clientId: client.id,
          startAt,
          endAt,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: label.day,
          startWallTime: label.time,
          status: 'booked',
          lines: {
            create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
          },
        },
      });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();

    // Give her hours on that weekday, wide enough to hold the booking...
    // Scoped by the section's own heading rather than by ARIA: these sections
    // are plain <section>s, and giving them labels to satisfy a test would be
    // turning them into landmarks for the test's benefit.
    const weekly = page.locator('section').filter({ hasText: 'Weekly hours' });
    // `exact` — "Ends next day" contains "Day" as far as an accessible-name
    // substring match is concerned.
    await weekly.getByLabel('Day', { exact: true }).selectOption(String(weekday));
    await weekly.getByLabel('Open').fill('00:00');
    await weekly.getByLabel('Close').fill('23:59');
    await weekly.getByRole('button', { name: 'Add hours' }).click();
    // ...which strands nobody, and says so by saying nothing extra. The
    // control for the assertion below: both sentences come from the same
    // derivation, so a mechanism that always reported "1 stranded" would pass
    // the remove case on its own.
    const added = page.getByRole('paragraph').filter({ hasText: 'Hours added.' });
    await expect(added).toBeVisible();
    await expect(added).not.toContainText('stranded');

    // ...then take them away again, which is the whole point.
    await weekly.getByRole('button', { name: 'Remove' }).first().click();

    const removed = page.getByRole('paragraph').filter({ hasText: 'Hours removed.' });
    await expect(removed).toContainText('1 appointment now stranded.');

    await page.getByRole('link', { name: 'Deal with them' }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/conflicts\\?day=${day}`));
    await expect(page.getByText('Ada Chen')).toBeVisible();
    // Nothing silently cancelled (D-2): she is still booked, on the list.
    await expect(page.getByText('booked')).toBeVisible();
  });

  // D-4: a zoneless payload is undecidable on fall-back day.
  test('refuses a time-off payload with no timezone offset', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');

    await page.goto('/staff/availability');
    await page.getByRole('link', { name: 'Dana' }).click();

    await page.locator('input[name="startAt"]').fill('2026-06-09T14:00:00');
    await page.locator('input[name="endAt"]').fill('2026-06-09T16:00:00');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByText(/explicit timezone offset/)).toBeVisible();
  });

  /**
   * A-052 — THE OLDEST OUTSTANDING OPERATOR FINDING (R-8), CLOSED.
   *
   * The data has existed since A-007; nothing rendered it. Proved with a
   * SECOND name deliberately — the seeded owner appearing everywhere else in
   * this spec could pass with the actor column hardcoded to a literal
   * string, and only a switch to somebody else's PIN proves it is actually
   * resolved.
   */
  test('names WHO blocked the time, not just why', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.create({
        data: { businessId: business.id, displayName: 'Dana', active: true },
      });
      await createWeeklyWindow(
        prisma,
        { businessId: business.id, providerId: dana.id, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false, breaks: [] },
        { createdByActor: 'staff', actorRef: null },
      );
    } finally {
      await prisma.$disconnect();
    }

    await signIn(page);
    await page.goto('/staff/availability');
    // A row written before an actor was ever recorded says nothing rather
    // than claiming a name the row does not actually have.
    await expect(page.getByText('set by')).toHaveCount(0);

    await page.goto('/staff/people');
    const addForm = page.locator('form').filter({ hasText: 'Add somebody' });
    await addForm.getByLabel('Name').fill('Priya');
    await addForm.getByLabel('Desk PIN').fill('4821');
    await addForm.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('Priya added.')).toBeVisible();

    await page.goto('/staff');
    await page.locator('summary').filter({ hasText: 'At the desk:' }).click();
    await page.getByLabel('Who').selectOption({ label: 'Priya' });
    await page.getByLabel('PIN').fill('4821');
    await page.getByRole('button', { name: 'That’s me' }).click();
    await expect(page.getByText('Priya is at the desk.')).toBeVisible();

    await page.goto('/staff/availability?provider=' + (await providerIdFor('Dana')));
    await page.locator('input[name="startAt"]').fill('2026-06-09T14:00:00-05:00');
    await page.locator('input[name="endAt"]').fill('2026-06-09T16:00:00-05:00');
    await page.locator('select[name="kind"]').selectOption('ad_hoc_block');
    await page.locator('input[name="reason"]').last().fill('Plumber');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const row = page.getByRole('listitem').filter({ hasText: 'Plumber' });
    await expect(row).toBeVisible();
    await expect(row.getByText('blocked by Priya')).toBeVisible();
  });

  test('the availability page has no serious accessibility violations', async ({ page }) => {
    await signIn(page);
    await addProvider(page, 'Dana');
    await page.goto('/staff/availability');
    const businessScan = await new AxeBuilder({ page }).analyze();
    expect(businessScan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

    await page.getByRole('link', { name: 'Dana' }).click();
    const providerScan = await new AxeBuilder({ page }).analyze();
    expect(providerScan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
});
