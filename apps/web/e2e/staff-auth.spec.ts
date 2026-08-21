import AxeBuilder from '@axe-core/playwright';
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

    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByRole('heading', { name: 'Staff' })).toBeVisible();
    // A-037: the page names the person at the desk, not the account's email.
    // Scoped to <main> because the desk-switcher bar says the same name.
    await expect(page.getByRole('main').getByText('Front desk')).toBeVisible();

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
    await expect(page).toHaveURL(/\/staff$/);

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
