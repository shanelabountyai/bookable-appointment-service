/**
 * A-089 — the primitives, driven (design brief §5.3, §8.2, §4).
 *
 * §8.2 wants every state drawn: rest, hover, focus, active, disabled, pending,
 * invalid. `/staff/design` renders the four that are props; this file drives
 * the three that are CSS pseudo-classes, because a focus ring is exactly the
 * kind of thing a gallery LOOKS like it has and a keyboard does not find.
 *
 * The two assertions worth naming:
 *
 *  - **44px is measured, not asserted as a class.** §4's desk target is a
 *    physical size on a tablet; a test that greps `min-h-11` passes the day
 *    somebody adds a `py-1` override that wins.
 *  - **The badge is inside its control's accessible NAME.** `Opened up 3` as a
 *    link name is the whole reason `Badge` has no name of its own; a badge
 *    that drifts outside the control announces a bare "3".
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await page.goto('/staff/design');
  await expect(page.getByRole('heading', { name: 'Primitives' })).toBeVisible();
});

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test('the state matrix has no accessibility violations', async ({ page }) => {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(results.violations).toEqual([]);
});

/**
 * A-090 — THE DOMAIN MATRICES, AND IN BOTH SCHEMES.
 *
 * Demo checkpoint 7's rule, applied to the gallery that exists to prevent its
 * class of defect: an accessibility assertion over a screen with no data on it
 * is an assertion over the chrome. This page now draws eight statuses, six
 * modifiers and four whole days, and it draws them from FIXTURES rather than
 * from the book — so the states axe measures here are the states the component
 * has, not the states the demo install happens to contain (checkpoint 7 found
 * that the demo has no running-late column and no stylist off at all).
 */
test('the chip matrix and the four days have no accessibility violations, in both schemes', async ({ page }) => {
  // The compositions §8.5 asks for are all on the page, not just the easy one.
  for (const heading of ['four stylists', 'one stylist', 'a column forty minutes behind', 'a stylist off']) {
    await expect(page.getByRole('heading', { name: `The day — ${heading}` })).toBeVisible();
  }
  // Eight statuses drawn, seven of them wearing their word (§4, never colour
  // alone). `booked` is the eighth and carries none, on purpose.
  for (const word of ['Confirmed', 'Here', 'In chair', 'Done', 'No-show', 'Cancelled', 'Late cancel']) {
    await expect(page.getByText(word, { exact: true }).first()).toBeVisible();
  }

  const light = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(light.violations).toEqual([]);

  // Reload rather than only `emulateMedia` — see `day-grid.spec.ts`: switching
  // the query on a live page leaves every control mid-transition and axe then
  // samples the blend.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The day — a stylist off' })).toBeVisible();
  const dark = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(dark.violations).toEqual([]);
});

test('a pending button is disabled and says so in the accessibility tree', async ({ page }) => {
  // Pending IS disabled, not a look beside it: every mutating control here is
  // a `useActionState` form, and a clickable pending button is a double write.
  const pending = page.getByRole('button', { name: 'Saving primary…' });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute('aria-busy', 'true');

  // Disabled is disabled and says nothing about being busy; rest is neither.
  const disabled = page.getByRole('button', { name: 'disabled primary' });
  await expect(disabled).toBeDisabled();
  await expect(disabled).not.toHaveAttribute('aria-busy', /./);
  await expect(page.getByRole('button', { name: 'rest primary' })).toBeEnabled();
});

test('Field wires aria-describedby to both the hint and the error', async ({ page }) => {
  const invalid = page.getByRole('textbox', { name: 'Invalid' });
  await expect(invalid).toHaveAttribute('aria-invalid', 'true');
  const describedBy = (await invalid.getAttribute('aria-describedby')) ?? '';
  expect(describedBy.split(' ').sort()).toEqual(['demo-invalid-error', 'demo-invalid-hint']);
  // The ids have to point at something — a dangling `aria-describedby` reads
  // as nothing at all and axe does not always catch it.
  await expect(page.locator('#demo-invalid-hint')).toHaveText('The last few digits are enough.');
  await expect(page.locator('#demo-invalid-error')).toHaveText(
    'That number is already on another record.',
  );

  // A field that cannot fail describes nothing and is not marked invalid.
  const rest = page.getByRole('textbox', { name: 'Rest' });
  await expect(rest).not.toHaveAttribute('aria-describedby', /./);
  await expect(rest).not.toHaveAttribute('aria-invalid', /./);
});

test('the current tab is a link with aria-current, and it is the only one', async ({ page }) => {
  const tabs = page.getByRole('navigation', { name: 'Primitive demo view' });
  // Links, not `role="tab"` — these are URLs (§4).
  await expect(tabs.getByRole('tab')).toHaveCount(0);
  await expect(tabs.getByRole('link')).toHaveCount(3);
  await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(tabs.getByRole('link', { name: 'Everyone' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('a badge is part of its control’s accessible name', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'Opened up 3' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Messages 2' })).toBeVisible();
});

test('desk controls are at least 44px tall', async ({ page }) => {
  // §4, measured. The grid chip is the stated exception and is not a primitive.
  for (const control of [
    page.getByRole('button', { name: 'rest primary' }),
    page.getByRole('textbox', { name: 'Rest' }),
    page.getByRole('link', { name: 'Everyone' }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test('keyboard focus draws a visible ring', async ({ page }) => {
  // A-088 draws the ring once on `:focus-visible`, for every keyboard stop —
  // the first one on a staff page is the desk switcher's `<summary>`, which is
  // not a Button and is exactly why the rule does not live in one.
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const style = el ? getComputedStyle(el) : null;
    return { tag: el?.tagName, style: style?.outlineStyle, width: style?.outlineWidth };
  });
  expect(first.tag).toBe('SUMMARY');
  expect(first.style).not.toBe('none');
  expect(first.width).toBe('2px');

  // And a Button is REACHABLE by keyboard and rings when it gets there.
  //
  // Tabbed to rather than asserted as "the second stop": the first draft did
  // assert the position, and A-085's shell inserted eight nav stops above the
  // page and broke it. The tab ORDER of the whole application is not what this
  // test is about — that a keyboard can reach a Button, and sees it when it
  // does, is.
  let button: { name?: string; style?: string; width?: string } | null = null;
  for (let i = 0; i < 40 && button === null; i += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const style = el ? getComputedStyle(el) : null;
      return {
        name: el?.textContent?.trim(),
        style: style?.outlineStyle,
        width: style?.outlineWidth,
      };
    });
    if (active.name === 'rest primary') button = active;
  }
  expect(button, 'a keyboard never reached the first Button on the page').not.toBeNull();
  expect(button?.style).not.toBe('none');
  expect(button?.width).toBe('2px');
});
