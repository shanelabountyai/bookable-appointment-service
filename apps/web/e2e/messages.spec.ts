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
import AxeBuilder from '@axe-core/playwright';
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

  test('says so plainly when everything has gone out', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/messages');
    await expect(page.getByText(/Everything has gone out/)).toBeVisible();
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

  test('has no accessibility violations', async ({ page }) => {
    await queueRow({
      dedupeKey: 'reminder-24h:appt4:1',
      status: 'failed',
      attempts: 5,
      lastError: 'blocked: the client has opted out',
    });
    await signIn(page);
    await page.goto('/staff/messages');

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
