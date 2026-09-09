/**
 * A-051 — WHAT DID NOT GO OUT (NOTIF-01, D-14).
 *
 * A retry policy nobody can see is the same silence with better manners, so
 * the screen is the half of this item worth an end-to-end test: the desk has
 * to be able to find the message that never reached Ada, read the provider's
 * own reason for it, and put it back in the queue once the number is fixed.
 *
 * The rows are written directly. The SUBJECT here is the surface — the
 * dispatcher's own behaviour (which failures are retried, on what backoff, and
 * when it gives up) is proved against the real database with an injected clock
 * in `packages/db/notifications`, where it can be asserted in milliseconds
 * instead of driven through a browser.
 */
import { expectNoAxeViolations } from './axe';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { fromDate, instant, toDate } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

/**
 * Age a row past D-51's one-hour bound. `updatedAt`, not `createdAt`, because
 * that is the column the bound reads — a retried row keeps an old `createdAt`
 * and must not bounce straight back onto this screen.
 */
async function ageBeyondTheHour(dedupeKey: string) {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRaw`UPDATE "NotificationOutbox" SET "updatedAt" = now() - interval '3 hours' WHERE "dedupeKey" = ${dedupeKey}`;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * One appointment inside the 24-hour lead window that was booked long enough
 * ago to have been reminded, and never was. Raw, because the write path
 * refuses to backdate a booking — and `blockedStart`/`blockedEnd` are left to
 * the trigger, which is the only thing allowed to write them (CLAUDE.md).
 */
async function bookedButNeverReminded(args: { name: string; phone: string }) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const provider = await prisma.provider.findFirstOrThrow({ where: { businessId: business.id } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: args.name, phone: args.phone },
    });
    // Floored to the minute: `appointment_instants_whole_minutes` refuses a row
    // carrying the seconds `new Date()` came with, and it is right to — a book
    // whose times are not on the grid cannot be rendered or matched.
    const inTwelveHours = fromDate(new Date()) + 12 * 60 * 60_000;
    const startAt = toDate(instant(inTwelveHours - (inTwelveHours % 60_000)));
    const endAt = toDate(instant(fromDate(startAt) + 60 * 60_000));
    const appointment = await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: provider.id,
        clientId: client.id,
        status: 'booked',
        startAt,
        endAt,
        // Required by the client's types and immediately OVERWRITTEN by the
        // trigger that owns them (CLAUDE.md) — passed as the body, never as a
        // claim about the envelope. Nothing on this screen measures a
        // footprint, so the zero buffers are harmless here.
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: '2026-06-09',
        startWallTime: '10:00',
      },
    });
    await prisma.$executeRaw`UPDATE "Appointment" SET "createdAt" = now() - interval '5 days' WHERE id = ${appointment.id}`;
  } finally {
    await prisma.$disconnect();
  }
}

/** One outbox row in whatever state the test is about. */
async function queueRow(args: {
  dedupeKey: string;
  status: 'pending' | 'failed';
  attempts: number;
  lastError: string | null;
  nextAttemptAt?: Date | null;
}) {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    await prisma.notificationOutbox.create({
      data: {
        businessId: business.id,
        dedupeKey: args.dedupeKey,
        channel: 'sms',
        template: 'appointment.reminder',
        recipient: '+15125550101',
        payload: {},
        status: args.status,
        attempts: args.attempts,
        lastError: args.lastError,
        nextAttemptAt: args.nextAttemptAt ?? null,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

test.describe('messages that did not go out (A-051)', () => {
  test('refuses an anonymous visitor', async ({ browser }) => {
    const anonymous = await browser.newPage();
    await anonymous.goto('/staff/messages');
    await expect(anonymous).toHaveURL(/\/staff\/login/);
    await anonymous.close();
  });

  test('says so plainly when everything has gone out, and says whether the job ran', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/messages');
    await expect(page.getByText(/Everything has gone out/)).toBeVisible();
    // D-51. "Nothing was due" and "the job has not run since Tuesday" are
    // identical on an empty screen, and this line is the only thing that tells
    // them apart. On a fresh install it has genuinely never run.
    await expect(page.getByText('The reminder job has never run.')).toBeVisible();
    // And the shell carries no count to act on. `exact: true` is what asserts
    // that: without it, "Messages 1" matches too and the test passes for the
    // one reason it exists to rule out. No navigation needed — the shell is on
    // this page as well, which is the point of A-085.
    await expect(page.getByRole('link', { name: 'Messages', exact: true })).toBeVisible();
  });

  /**
   * The whole point: the reason is the PROVIDER'S OWN WORDS, code first. A
   * friendlier paraphrase would throw away the one string that tells the desk
   * to go and fix the number.
   */
  test('shows what was given up on, with the reason, and counts it on the way in', async ({ page }) => {
    await queueRow({
      dedupeKey: 'reminder-24h:appt1:1',
      status: 'failed',
      attempts: 5,
      lastError: 'invalid_recipient: the number is not in service',
    });

    await signIn(page);
    // The count is in the SHELL — a screen about messages nobody was told
    // about is only as useful as the reason to open it, and since A-085 that
    // reason is on every staff screen rather than on a landing page the desk
    // no longer passes through. This assertion runs on the day grid.
    await expect(page.getByRole('link', { name: 'Messages 1' })).toBeVisible();
    await page.getByRole('link', { name: 'Messages 1' }).click();

    await expect(page.getByRole('heading', { name: /Nobody was told/ })).toBeVisible();
    await expect(page.getByText('invalid_recipient: the number is not in service')).toBeVisible();
    await expect(page.getByText('5 tries')).toBeVisible();
  });

  /** Reassuring, and shown for that reason: without it a message mid-backoff
   *  is invisible and the desk phones a client the system was about to
   *  reach anyway. A row still trying offers no button — there is nothing to
   *  do but wait. */
  test('shows a message still working through its backoff, without offering a retry', async ({ page }) => {
    await queueRow({
      dedupeKey: 'reminder-24h:appt2:1',
      status: 'pending',
      attempts: 2,
      lastError: 'server_error: the provider had a bad minute',
      // Through the one conversion module — a backoff is physical
      // milliseconds, and `new Date(...)` arithmetic is banned repo-wide.
      nextAttemptAt: toDate(instant(fromDate(new Date()) + 25 * 60_000)),
    });

    await signIn(page);
    await page.goto('/staff/messages');

    await expect(page.getByRole('heading', { name: /Still trying/ })).toBeVisible();
    await expect(page.getByText('server_error: the provider had a bad minute')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send it again' })).toHaveCount(0);
    // And it is NOT counted as something to act on — a row still working
    // through its backoff is not a number anybody should act on.
    await expect(page.getByRole('link', { name: 'Messages', exact: true })).toBeVisible();
  });

  /** The desk fixed the number. The row goes back with a full budget — a
   *  retry that made one more attempt and gave up again would look, from the
   *  desk, like the button does not work. */
  test('puts a given-up message back in the queue', async ({ page }) => {
    await queueRow({
      dedupeKey: 'reminder-24h:appt3:1',
      status: 'failed',
      attempts: 5,
      lastError: 'invalid_recipient: the number is not in service',
    });

    await signIn(page);
    await page.goto('/staff/messages');
    await page.getByRole('button', { name: 'Send it again' }).click();
    await expect(page.getByText(/Back in the queue/)).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const row = await prisma.notificationOutbox.findFirstOrThrow({
        where: { dedupeKey: 'reminder-24h:appt3:1' },
      });
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.nextAttemptAt).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * A-108 / D-51 — THE STATE THIS SCREEN COULD NOT SEE.
   *
   * 713 rows sat `pending`/`attempts = 0` on two independent databases with
   * the badge reading 0 beside them and the page saying "Everything has gone
   * out." The assertion is on what is THERE — the section, the count and the
   * badge — because a screen that only ever asserts absence passes against a
   * missing one (A-107).
   */
  test('shows what was queued and never tried, and counts it', async ({ page }) => {
    await queueRow({ dedupeKey: 'reminder-24h:untried:1', status: 'pending', attempts: 0, lastError: null });
    await ageBeyondTheHour('reminder-24h:untried:1');

    await signIn(page);
    await expect(page.getByRole('link', { name: 'Messages 1' })).toBeVisible();
    await page.getByRole('link', { name: 'Messages 1' }).click();

    await expect(page.getByRole('heading', { name: /Queued and never tried \(1\)/ })).toBeVisible();
    await expect(page.getByText(/The sending job may not be running/)).toBeVisible();
    // Nothing has tried, so there is nothing to put back in the queue.
    await expect(page.getByRole('button', { name: 'Send it again' })).toHaveCount(0);
    await expect(page.getByText(/Everything has gone out/)).toHaveCount(0);
  });

  /** And a fresh one is still just new — the bound is the whole difference
   *  between this bucket and every message the salon sends. */
  test('leaves a message queued a moment ago alone', async ({ page }) => {
    await queueRow({ dedupeKey: 'reminder-24h:fresh:1', status: 'pending', attempts: 0, lastError: null });

    await signIn(page);
    await page.goto('/staff/messages');
    await expect(page.getByText(/Everything has gone out/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Messages', exact: true })).toBeVisible();
  });

  /**
   * A-108 / D-51 — the cohort with no outbox row at all, so nothing on this
   * screen could ever have found it. Derived from the appointments, and the
   * phone number IS the action: D-51 chose telling the desk over enqueuing a
   * catch-up nobody set a policy for.
   */
  test('names a client the reminder job missed, with a number to ring', async ({ page }) => {
    await bookedButNeverReminded({ name: 'Ada Chen', phone: '(512) 555-0188' });

    await signIn(page);
    await page.goto('/staff/messages');

    await expect(page.getByRole('heading', { name: /never reminded \(1\)/ })).toBeVisible();
    await expect(page.getByText('Ada Chen')).toBeVisible();
    // Through PhoneLink (A-092): the stored formatting is stripped out of the
    // href, so a number typed with brackets still dials.
    await expect(page.getByRole('link', { name: '(512) 555-0188' })).toHaveAttribute('href', 'tel:5125550188');
    await expect(page.getByText(/Everything has gone out/)).toHaveCount(0);
  });

  /** Scanned with ALL THREE sections on screen at once — A-108 added two, and
   *  a fixture carrying only the original one measures a page the desk will
   *  rarely see. */
  test('has no accessibility violations', async ({ page }) => {
    await queueRow({
      dedupeKey: 'reminder-24h:appt4:1',
      status: 'failed',
      attempts: 5,
      lastError: 'blocked: the client has opted out',
    });
    await queueRow({ dedupeKey: 'reminder-24h:appt5:1', status: 'pending', attempts: 0, lastError: null });
    await ageBeyondTheHour('reminder-24h:appt5:1');
    await bookedButNeverReminded({ name: 'Ada Chen', phone: '(512) 555-0188' });

    await signIn(page);
    await page.goto('/staff/messages');
    await expect(page.getByRole('heading', { name: /never reminded/ })).toBeVisible();

    await expectNoAxeViolations(page);
  });
});
