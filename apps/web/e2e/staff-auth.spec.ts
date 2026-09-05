import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { saveStaffMember, verifyStaffPin } from '@bookable/db/auth';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

/**
 * A-005 / D-9. The acceptance criterion is "staff routes refuse
 * unauthenticated requests", and that is a claim about the SERVER, so these
 * assert against real navigation rather than against a mocked hook.
 */

test.describe('staff session', () => {
  test('an anonymous visitor is refused and sent to sign in', async ({ page }) => {
    await page.goto('/staff');
    await expect(page).toHaveURL(/\/staff\/login$/);
    // The protected content must not render at all — not merely be hidden.
    await expect(page.getByRole('heading', { name: 'Staff sign in' })).toBeVisible();
    await expect(page.getByText('At the desk')).toHaveCount(0);
  });

  test('the wrong password is refused with one generic message', async ({ page }) => {
    await page.goto('/staff/login');
    await page.getByLabel('Email').fill(STAFF_EMAIL);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('That email and password do not match.')).toBeVisible();
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  // The message for an unknown email must be identical to the one for a wrong
  // password, or the form becomes a directory of who has an account.
  test('an unknown email gives the SAME message as a wrong password', async ({ page }) => {
    await page.goto('/staff/login');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill(STAFF_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('That email and password do not match.')).toBeVisible();
  });

  test('the right credential signs in, reaches the staff page, and signs out again', async ({ page }) => {
    await page.goto('/staff/login');
    await page.getByLabel('Email').fill(STAFF_EMAIL);
    await page.getByLabel('Password').fill(STAFF_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // A-085 (D-49): sign-in lands on the DAY GRID, the screen the desk works
    // in, rather than on an index one hop away from it.
    await expect(page).toHaveURL(/\/staff\/day/);
    await expect(page.getByRole('navigation', { name: 'Staff' })).toBeVisible();
    // A-037: who is at the desk is named, not the account's email. Asserted on
    // the desk bar rather than inside `<main>`: the bar is the only thing that
    // says it now, on every screen, and `/staff`'s own copy went with the shell.
    await expect(page.locator('summary').filter({ hasText: 'At the desk:' })).toContainText(
      'Front desk',
    );

    // Signing out is a deliberate, rare action and lives on Setup — not in the
    // chrome the desk taps forty times a day.
    await page.goto('/staff');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/staff\/login$/);

    // And the session is genuinely gone, not just navigated away from.
    await page.goto('/staff');
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  test('the session cookie is HttpOnly and SameSite=Lax', async ({ page, context }) => {
    await page.goto('/staff/login');
    await page.getByLabel('Email').fill(STAFF_EMAIL);
    await page.getByLabel('Password').fill(STAFF_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/staff\/day/);

    const cookie = (await context.cookies()).find((c) => c.name === 'bookable_staff_session');
    expect(cookie).toBeDefined();
    // HttpOnly is what stops an XSS reading the session out of document.cookie.
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Lax');
    // The sweep runs against a PRODUCTION build (CLAUDE.md), so NODE_ENV is
    // 'production' and Secure must be on. Browsers treat localhost as a
    // secure context, which is why this still works over http here — and why
    // asserting it is worth doing rather than assuming: a regression to
    // `secure: false` would be invisible locally and would ship the session
    // cookie in clear text everywhere else.
    expect(cookie!.secure).toBe(true);
  });

  // A forged or tampered cookie must read as "not logged in", never as an
  // error page and never as a session.
  test('a tampered session cookie is rejected, not trusted', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'bookable_staff_session',
        value: 'eyJzdWIiOiJhdHRhY2tlciIsImV4cCI6OTk5OTk5OTk5OTk5OX0.forged-signature',
        domain: 'localhost',
        path: '/',
      },
    ]);
    await page.goto('/staff');
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  test('the sign-in page has no serious accessibility violations', async ({ page }) => {
    await page.goto('/staff/login');
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious).toEqual([]);
  });
});

/**
 * A-050 — PER-PERSON CREDENTIALS AND THE OWNER SPLIT (D-36).
 *
 * Until this item the salon had four NAMES on the audit trail and ONE
 * credential under the desk, and anybody who signed in could open the
 * dashboard: revenue, utilization, and every stylist's no-show count.
 *
 * Asserted against real navigation, for the same reason A-005's specs are:
 * "the dashboard refuses a stylist" is a claim about the SERVER, and hiding a
 * link proves nothing about it.
 */
test.describe('staff roles (A-050)', () => {
  const PRIYA_EMAIL = 'priya@shear-genius.test';
  const PRIYA_PASSWORD = 'priya-own-password';

  /** Her own sign-in, on the roster row that already existed — which is the
   *  shape of the whole item: A-037 made the identities, this gives them
   *  credentials. */
  async function givePriyaAnAccount(role: 'owner' | 'staff') {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      await saveStaffMember(prisma, {
        businessId: business.id,
        name: 'Priya',
        email: PRIYA_EMAIL,
        password: PRIYA_PASSWORD,
        role,
      });
    } finally {
      await prisma.$disconnect();
    }
  }

  async function signInAs(page: Page, email: string, password: string) {
    await page.goto('/staff/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/staff\/day/);
  }

  test('a stylist signs in as herself and cannot reach the money', async ({ page }) => {
    await givePriyaAnAccount('staff');
    await signInAs(page, PRIYA_EMAIL, PRIYA_PASSWORD);

    // Her own name on the desk, from her own credential — not the shared one.
    // On the desk bar since A-085: it is the one place that says who is acting,
    // and it says it on every screen rather than on a landing page.
    await expect(page.locator('summary').filter({ hasText: 'At the desk:' })).toContainText('Priya');
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);

    // THE CONTROL, not the hidden link: typed straight in, and refused by the
    // route rather than merely undrawn.
    await page.goto('/staff/dashboard');
    await expect(page).toHaveURL(/\/staff\/day/);
    await expect(page.getByRole('heading', { name: /This week/ })).toHaveCount(0);

    // The drill-down behind it is its own route and needs its own guard —
    // a screen reachable by a link the guarded page draws is still reachable
    // by anybody who has seen the URL once.
    await page.goto('/staff/dashboard/appointments?from=2026-06-08&to=2026-06-14');
    await expect(page).toHaveURL(/\/staff\/day/);
  });

  test('an owner still sees it', async ({ page }) => {
    await givePriyaAnAccount('owner');
    await signInAs(page, PRIYA_EMAIL, PRIYA_PASSWORD);

    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/staff\/dashboard/);
  });

  /**
   * Taking the desk hands the money back with it.
   *
   * The role is read from whoever is AT THE DESK, not from the account that
   * opened the session — the salon terminal signs in once as the owner in the
   * morning and four people use it all day, so a role read from `sub` would
   * leave every stylist holding the owner's dashboard.
   */
  test('a stylist who takes the desk loses the dashboard with it', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      await saveStaffMember(prisma, { businessId: business.id, name: 'Priya', pin: '4821' });
    } finally {
      await prisma.$disconnect();
    }

    await signInAs(page, STAFF_EMAIL, STAFF_PASSWORD);
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();

    await page.locator('summary').filter({ hasText: 'At the desk:' }).click();
    await page.getByLabel('Who').selectOption({ label: 'Priya' });
    await page.getByLabel('PIN').fill('4821');
    await page.getByRole('button', { name: 'That’s me' }).click();
    await expect(page.getByText('Priya is at the desk.')).toBeVisible();

    await page.goto('/staff/dashboard');
    await expect(page).toHaveURL(/\/staff\/day/);
  });

  /**
   * A LOCKED PIN REACHES THE DESK AS A SENTENCE, not as a 500.
   *
   * That is the whole reason this is an e2e at all: `verifyStaffPin` THROWS on
   * a lockout, and a throw nothing catches is a stack trace on the screen a
   * salon uses all day. The COUNTING is proved in the database tests, against
   * an injected clock, where it belongs.
   *
   * So the five wrong tries are spent server-side and only the sixth goes
   * through the browser. Clicking the same button five times and asserting the
   * same failure message after each one proves nothing anyway: the message
   * from attempt one is still on screen during attempt two, so the assertion
   * passes without the attempt having landed — which is exactly how this test
   * first failed, having registered four submissions instead of five.
   */
  test('a PIN that has been locked out says so, rather than crashing the desk', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const { id } = await saveStaffMember(prisma, { businessId: business.id, name: 'Priya', pin: '4821' });
      // Five wrong tries, spent through the same function the form calls.
      for (let attempt = 0; attempt < 5; attempt++) {
        expect(await verifyStaffPin(prisma, { businessId: business.id, staffUserId: id, pin: '0000' })).toBeNull();
      }
    } finally {
      await prisma.$disconnect();
    }

    await signInAs(page, STAFF_EMAIL, STAFF_PASSWORD);
    await page.locator('summary').filter({ hasText: 'At the desk:' }).click();
    await page.getByLabel('Who').selectOption({ label: 'Priya' });

    // The RIGHT PIN, refused — which is the whole point of a lockout — and
    // refused in words, with the desk still where it was.
    await page.getByLabel('PIN').fill('4821');
    await page.getByRole('button', { name: 'That’s me' }).click();
    await expect(page.getByText(/Too many PIN attempts/)).toBeVisible();
    await expect(page.getByText('Priya is at the desk.')).toHaveCount(0);
  });
});
