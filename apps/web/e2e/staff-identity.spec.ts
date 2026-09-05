/**
 * A-037 / D-33 — WHO IS AT THE DESK.
 *
 * Four people share one terminal, so every mutation read "by the front desk"
 * and "who moved this appointment" had no real answer. The PIN is deliberately
 * NOT a login: it acts inside a session already opened with a real credential,
 * and decides only whose name goes on the next thing that happens.
 */
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { SESSION_TTL_MS, signSession } from '@bookable/core/auth';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

/** The bar is a native `<details>`, and since A-085 it is the ONLY thing in
 *  the product that says who is at the desk — the `/staff` page's own copy of
 *  that line went with the shell. Scoped to the summary all the same: the
 *  expanded form contains the switcher, not the current name. */
function deskBar(page: Page) {
  return page.locator('summary').filter({ hasText: 'At the desk:' });
}

/** Take the desk as Priya, through the bar, exactly as the salon does. */
async function beMePriya(page: Page) {
  await deskBar(page).click();
  await page.getByLabel('Who').selectOption({ label: 'Priya' });
  await page.getByLabel('PIN').fill('4821');
  await page.getByRole('button', { name: 'That’s me' }).click();
  await expect(page.getByText('Priya is at the desk.')).toBeVisible();
}

async function addPriya(page: Page) {
  await page.goto('/staff/people');
  const form = page.locator('form').filter({ hasText: 'Add somebody' });
  await form.getByLabel('Name').fill('Priya');
  await form.getByLabel('Desk PIN').fill('4821');
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Priya added.')).toBeVisible();
}

test.describe('named staff identity', () => {
  test.beforeEach(async () => {
    const prisma = new PrismaClient();
    try {
      await seedSetup(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('somebody added to the roster can take the desk, and the log says their name', async ({ page }) => {
    await signIn(page);
    await addPriya(page);

    // The bar is on every staff screen, so taking the desk does not mean
    // navigating somewhere first.
    await page.goto('/staff/day');
    await expect(deskBar(page)).toBeVisible();
    await deskBar(page).click();
    await page.getByLabel('Who').selectOption({ label: 'Priya' });
    await page.getByLabel('PIN').fill('4821');
    await page.getByRole('button', { name: 'That’s me' }).click();

    await expect(page.getByText('Priya is at the desk.')).toBeVisible();

    // And the stamp on the next mutation is hers, not the account's.
    const prisma = new PrismaClient();
    try {
      const priya = await prisma.staffUser.findFirstOrThrow({ where: { name: 'Priya' } });
      // A-085: who is acting is the SHELL's fact now, on every screen, rather
      // than a line `/staff` happened to render. Asserted on the desk bar for
      // that reason — the old `main`-scoped version was scoped that way only to
      // avoid matching the bar it has now become the source of truth for.
      await page.goto('/staff/day');
      await expect(deskBar(page)).toContainText('Priya');
      expect(priya.pinHash).not.toBe('4821');
      // A roster identity is not an account: no email, so no way to sign in.
      expect(priya.email).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('a wrong PIN is refused with one generic message', async ({ page }) => {
    await signIn(page);
    await addPriya(page);

    await page.goto('/staff');
    await deskBar(page).click();
    await page.getByLabel('Who').selectOption({ label: 'Priya' });
    await page.getByLabel('PIN').fill('0000');
    await page.getByRole('button', { name: 'That’s me' }).click();

    await expect(page.getByText('That name and PIN do not match.')).toBeVisible();
    // Still whoever it was — a failed switch must not silently hand the desk
    // over, or the log would name the wrong person for the rest of the shift.
    await expect(deskBar(page)).toContainText('Front desk');
  });

  /** Off-boarding takes somebody off the switcher and ends their session,
   *  without taking their name off the events they already stamped. */
  test('taking somebody off the roster removes them from the switcher', async ({ page }) => {
    await signIn(page);
    await addPriya(page);

    await page.goto('/staff/people');
    const row = page.locator('li').filter({ hasText: 'Priya' });
    await row.getByRole('button', { name: 'Take off the roster' }).click();
    await expect(page.getByText('Priya is off the roster.')).toBeVisible();

    await page.goto('/staff');
    await deskBar(page).click();
    await expect(page.getByText('Nobody else has a desk PIN yet.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      // Deactivated, NOT deleted — the name has to survive on every event it
      // ever stamped, or "who did this" loses its answer the day she leaves.
      const priya = await prisma.staffUser.findFirstOrThrow({ where: { name: 'Priya' } });
      expect(priya.active).toBe(false);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('the roster screen has no serious accessibility violations', async ({ page }) => {
    await signIn(page);
    await addPriya(page);
    await page.goto('/staff/people');

    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious).toEqual([]);
  });

  /**
   * A-044 — THE GUARD, AND IT IS ON THE ACTION, NOT ON THE SCREEN.
   *
   * The roster is reachable by anybody, and a PIN is the credential every "by
   * Priya" in the log rests on. Priya setting Dana's PIN forges Dana's name in
   * thirty seconds, which is precisely what A-037 built the trail to prevent.
   *
   * The two tabs are not a contrivance — this is the shared salon terminal,
   * and the point of the test is that the roster form was rendered BEFORE the
   * desk changed hands, so its PIN field is sitting right there in the DOM.
   * A screen that only hides the input protects nothing; the refusal has to
   * happen when the values arrive.
   */
  test('somebody at the desk on a borrowed name cannot set a PIN, even with the field in front of them', async ({
    page,
    context,
  }) => {
    await signIn(page);
    await addPriya(page);

    // Rendered as the account holder, so the PIN field is real and fillable.
    await page.goto('/staff/people');
    const priyaRow = page.locator('li').filter({ hasText: 'Priya' });
    await expect(priyaRow.getByLabel('New desk PIN')).toBeVisible();

    // The desk changes hands in another tab. Same terminal, same cookie jar.
    const other = await context.newPage();
    await other.goto('/staff');
    await beMePriya(other);
    await other.close();

    // This page never re-rendered. Priya types a new PIN into the form the
    // owner left open and saves it.
    await priyaRow.getByLabel('New desk PIN').fill('9999');
    await priyaRow.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Only the account this terminal signed in with can set a desk PIN.')).toBeVisible();

    const prisma = new PrismaClient();
    try {
      const priya = await prisma.staffUser.findFirstOrThrow({ where: { name: 'Priya' } });
      // Assert the PIN is UNCHANGED by using it, not by inspecting the hash:
      // a hash that merely differs from '9999' would also be true of a
      // successful re-hash of 9999, which is the failure this must catch.
      await page.goto('/staff');
      await deskBar(page).click();
      await page.getByLabel('Who').selectOption({ label: 'Priya' });
      await page.getByLabel('PIN').fill('9999');
      await page.getByRole('button', { name: 'That’s me' }).click();
      await expect(page.getByText('That name and PIN do not match.')).toBeVisible();
      expect(priya.id).toBeTruthy();
    } finally {
      await prisma.$disconnect();
    }
  });

  /**
   * The courtesy half: once somebody has taken the desk the fields are not
   * drawn at all, so nobody types a PIN twice to find out it was refused.
   * Naming stays open — A-044 is a guard on one credential.
   *
   * A-050 TIGHTENED THE OTHER HALF, and this test says so rather than keeping
   * a title that stopped being true: off-boarding ends somebody's live
   * sessions, which makes it a credential being taken away, so it moved behind
   * the owner role with handing one out. Priya is a stylist, so it is gone
   * from her screen too.
   */
  test('the roster still names on a borrowed identity — the PIN and off-boarding go', async ({ page }) => {
    await signIn(page);
    await addPriya(page);
    await page.goto('/staff');
    await beMePriya(page);

    await page.goto('/staff/people');
    await expect(page.getByText('Desk PINs are set by whoever signed this terminal in.')).toBeVisible();
    await expect(page.getByLabel('New desk PIN')).toHaveCount(0);
    await expect(page.getByLabel('Desk PIN')).toHaveCount(0);
    await expect(page.getByText('Remove PIN')).toHaveCount(0);
    // A-050 (D-36): a stylist can neither grant a sign-in nor take one away.
    await expect(page.getByLabel('Sign-in email')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Take off the roster' })).toHaveCount(0);

    // Still hers to change: the name the log uses.
    const priyaRow = page.locator('li').filter({ hasText: 'Priya' });
    await priyaRow.getByLabel('Name').fill('Priya S');
    await priyaRow.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
  });

  /**
   * A-044 — THE DESK COMES BACK BY ITSELF.
   *
   * Nothing used to hand it back, so whoever tapped last kept the log's name
   * all day, including after they had gone home. The cookie is signed here
   * rather than waited out: half an hour of real time is not a test, and the
   * signature is the only thing that makes `actExp` trustworthy anyway.
   */
  test('a lapsed desk falls back to the account holder without logging the terminal out', async ({
    page,
    context,
  }) => {
    await signIn(page);
    await addPriya(page);

    const prisma = new PrismaClient();
    try {
      const priya = await prisma.staffUser.findFirstOrThrow({ where: { name: 'Priya' } });
      const holder = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
      await stampSession(context, { sub: holder.id, act: priya.id, actExp: Date.now() - 1 });
    } finally {
      await prisma.$disconnect();
    }

    // Still signed in — a lapsed NAME is not a lapsed session, and throwing
    // the front desk at the login page mid-Saturday would be the worse bug.
    await page.goto('/staff/people');
    await expect(page).toHaveURL(/\/staff\/people$/);
    await expect(deskBar(page)).toContainText('Front desk');

    // And the account holder has their own screen back, guard included.
    await expect(page.getByText('Desk PINs are set by whoever signed this terminal in.')).toHaveCount(0);
    await expect(page.locator('li').filter({ hasText: 'Priya' }).getByLabel('New desk PIN')).toBeVisible();
  });

  /** The other side of the same coin: inside the window, she is still at the
   *  desk. Without this the test above passes for a build that ignores `act`
   *  entirely. */
  test('inside the window the acting name still holds', async ({ page, context }) => {
    await signIn(page);
    await addPriya(page);

    const prisma = new PrismaClient();
    try {
      const priya = await prisma.staffUser.findFirstOrThrow({ where: { name: 'Priya' } });
      const holder = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
      await stampSession(context, { sub: holder.id, act: priya.id, actExp: Date.now() + 60_000 });
    } finally {
      await prisma.$disconnect();
    }

    await page.goto('/staff/people');
    await expect(deskBar(page)).toContainText('Priya');
    await expect(page.getByText('Desk PINs are set by whoever signed this terminal in.')).toBeVisible();
  });
});

/**
 * Writes a session cookie the server will accept — signed with the same secret
 * the app runs on, which is what makes `act` and `actExp` worth trusting in
 * the first place. Only the acting fields are the subject; `exp` is left long
 * so nothing under test can be confused with an ordinary logout.
 */
async function stampSession(
  context: BrowserContext,
  args: { sub: string; act: string; actExp: number },
): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set — the e2e env is not loaded.');

  await context.addCookies([
    {
      name: 'bookable_staff_session',
      value: signSession({ ...args, exp: Date.now() + SESSION_TTL_MS }, secret),
      domain: 'localhost',
      path: '/',
    },
  ]);
}
