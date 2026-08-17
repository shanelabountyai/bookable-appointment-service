/**
 * A-013 — the manage link (TOKEN-01..03, D-5, D-10).
 *
 * The link is taken FROM THE OUTBOX ROW, never minted by the spec. That is the
 * whole assertion of golden path 1's last clause: what a customer actually
 * receives has to open her appointment. A spec that issued its own token would
 * have passed for the entire time the confirmation carried the string
 * `token-placeholder`.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { expect, test } from './fixtures';

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

const firstOption = (page: Page) => page.locator('fieldset ul > li > button').first();

/** Books through the customer flow and returns the link the salon sent her. */
async function bookAndTakeTheLink(page: Page): Promise<string> {
  await page.goto('/book');
  await page.getByRole('button', { name: /^Cut 45 min/ }).click();
  await page.getByRole('button', { name: 'Dana', exact: true }).click();
  await firstOption(page).click(); // the day
  await firstOption(page).click(); // the time
  await page.getByLabel('Your name').fill('Ada Chen');
  await page.getByLabel('Phone').fill('(512) 555-0101');
  await page.getByRole('button', { name: 'Confirm appointment' }).click();
  await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible();

  const prisma = new PrismaClient();
  try {
    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'appointment.confirmed' },
    });
    return (row.payload as { manageUrl: string }).manageUrl;
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('the manage link (A-013)', () => {
  test('the link in the confirmation opens the appointment', async ({ page }) => {
    await page.goto(await bookAndTakeTheLink(page));

    await expect(page.getByRole('heading', { name: 'Your appointment' })).toBeVisible();
    await expect(page.getByText('Cut')).toBeVisible();
    await expect(page.getByText('Dana')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel this appointment' })).toBeVisible();
  });

  /**
   * TOKEN-03, asserted against the RENDERED PAGE rather than against the
   * source. The rule is "no internal identifier renders on any token-reachable
   * route", and only the page can answer that — a component could be perfect
   * and a layout, an error boundary or a stray debug attribute could still put
   * a cuid in the markup.
   */
  test('renders no internal identifier (TOKEN-03, D-10)', async ({ page }) => {
    const link = await bookAndTakeTheLink(page);
    await page.goto(link);
    const html = await page.content();

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow();
      // The exact ids of this very appointment — no pattern matching, so this
      // cannot pass by accident or fail on a coincidence.
      for (const id of [appointment.id, appointment.businessId, appointment.providerId, appointment.clientId!]) {
        expect(html).not.toContain(id);
      }
    } finally {
      await prisma.$disconnect();
    }

    // Status enum values. `cancelled` and `confirmed` are absent from this list
    // ON PURPOSE: they are the customer lexicon's own words (D-10). The
    // machine-only forms are the tell.
    for (const enumValue of ['no_show', 'cancelled_late', 'checked_in', 'in_progress']) {
      expect(html).not.toContain(enumValue);
    }

    // Entity and column names. "Appointment" is deliberately not here — it is
    // the approved word, and the page says it in a heading.
    for (const internal of [
      'ManageToken',
      'AppointmentEvent',
      'NotificationOutbox',
      'appointmentId',
      'businessId',
      'providerId',
      'clientId',
      'tokenHash',
    ]) {
      expect(html).not.toContain(internal);
    }

    // Backlog identifiers (A-013, D-5, BOOK-02) — they live in comments and
    // commit messages, never on a customer's screen.
    expect(html).not.toMatch(/\b[ABDR]-\d{2,3}\b/);
  });

  test('cancels the appointment, and the SAME link still opens afterwards (D-5)', async ({ page }) => {
    const link = await bookAndTakeTheLink(page);
    await page.goto(link);
    await page.getByRole('button', { name: 'Cancel this appointment' }).click();
    // The PAGE is the feedback: the action revalidates, so the appointment
    // re-renders in its new state and the button that no longer applies goes
    // away. Deliberately not asserting the action's own success sentence —
    // that message lives inside the form the revalidation unmounts, so
    // asserting it would be a race against a re-render.
    await expect(page.getByText('This appointment is cancelled.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel this appointment' })).toHaveCount(0);

    // MULTI-USE. A single-use token would 404 here, and the customer who wants
    // to check she really did cancel would call the salon instead.
    await page.goto(link);
    await expect(page.getByText('This appointment is cancelled.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel this appointment' })).toHaveCount(0);

    const prisma = new PrismaClient();
    try {
      const appointment = await prisma.appointment.findFirstOrThrow();
      // Which of the two depends on how close the first offered slot is to the
      // seeded cutoff; the split itself is A-012's and A-020's subject.
      expect(['cancelled', 'cancelled_late']).toContain(appointment.status);
      // The customer's action is attributed to her token, not to the salon.
      const event = await prisma.appointmentEvent.findFirstOrThrow({
        where: { type: 'status_changed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(event.actor).toBe('customer_token');
      expect(event.actorRef).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('a token that was never issued gets a non-enumerating message (TOKEN-02)', async ({ page }) => {
    await page.goto('/manage/definitely-not-a-real-token');
    await expect(page.getByText('This link is no longer valid.')).toBeVisible();
    // The same sentence a REVOKED or EXPIRED link gets. Anything that
    // distinguished them would confirm a guess had named a real appointment.
    await expect(page.getByRole('button', { name: 'Cancel this appointment' })).toHaveCount(0);
  });

  /** TOKEN-02: "The route is rate-limited (it returns PII)." Raw requests
   *  rather than page loads — this is about the count, not the rendering. */
  test('rate-limits the route', async ({ page }) => {
    const link = await bookAndTakeTheLink(page);

    let refusedAt = 0;
    for (let i = 1; i <= 40 && refusedAt === 0; i++) {
      const body = await (await page.request.get(link)).text();
      if (body.includes('Too many requests')) refusedAt = i;
    }

    // The page loads above spent some of the budget, so the exact number is
    // not the assertion — that it closes at all, and well before 40, is.
    expect(refusedAt).toBeGreaterThan(0);
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto(await bookAndTakeTheLink(page));
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
