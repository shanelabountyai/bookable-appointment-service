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

/* ===========================================================================
 * A-091 — `/staff/opened` composed (§8.6) and `CallMarkButtons` (§5.4.9).
 * ======================================================================== */

test('the five freed kinds are drawn, and one of them carries two call marks', async ({ page }) => {
  // Five kinds, five different phone calls — the sentence is the row's point,
  // and each one is asserted by what it SAYS rather than by a `data-` hook.
  for (const sentence of [
    'Cancelled late by Ada Chen',
    'Mrs Hall dropped the Colour and Blow-dry',
    'Tomas Reyes went to Marcus',
    'a walk-in with no name never came — the rest of the time was put back',
  ]) {
    await expect(page.getByText(sentence)).toBeVisible();
  }
  await expect(page.getByText(/^Nadia Okafor moved to /)).toBeVisible();

  // §8.6's "one of them already carrying two call marks" — the composition the
  // demo book cannot produce (checkpoint 7 found zero marks on a fresh
  // install, A-095), and the reason this row is drawn from a fixture.
  const asked = page.getByRole('list').filter({ hasText: 'Mrs Patel' }).last();
  await expect(asked.getByRole('listitem')).toHaveCount(2);
  await expect(asked).toContainText('Mrs Patel — thinking about it (Priya)');
  await expect(asked).toContainText('Jo Hart — took it (Dana)');
});

test('every call-mark button is a 44px desk target, undo included', async ({ page }) => {
  // §4's bar, MEASURED — and the reason this test exists: both copies of this
  // control shipped at `px-2 py-1 text-xs`, which is 26px, on the control the
  // desk taps more than any other in the product. A mis-tap on a shared screen
  // marks the WRONG client as rung and silently skips her.
  const form = page.locator('form').filter({ hasText: 'Not asked' }).first();
  const buttons = form.getByRole('button');
  // Four outcomes plus the undo — a count guard, so a form that rendered one
  // button cannot pass this vacuously.
  await expect(buttons).toHaveCount(5);
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    expect(box?.height, `${await button.textContent()} is under the 44px bar`).toBeGreaterThanOrEqual(44);
  }
});

test('the mark that stands is aria-pressed, and it is the only one', async ({ page }) => {
  // Both copies of this control carried a comment claiming `aria-pressed` "is
  // not available on a submit button that is also the form's payload". It is:
  // a `<button type="submit">` has role `button`, and role `button` supports
  // it. Until now the pressed state was an inverted ground and nothing else,
  // which is colour alone in the accessibility tree as well as on the screen.
  const form = page.locator('form').filter({ hasText: 'Not asked' }).first();
  await expect(form.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(form.getByRole('button', { name: 'No answer', pressed: true })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Took it', pressed: false })).toBeVisible();

  // The two-outcome sibling is the same component, not a copy of it (§5.4.9).
  const callDown = page.locator('form').filter({ hasText: 'Not rung' });
  await expect(callDown.getByRole('button')).toHaveCount(3);
  await expect(callDown.getByRole('button', { name: 'Left a message', pressed: true })).toBeVisible();

  // The undo appears only where something stands: the unmarked row has four
  // buttons and no fifth.
  const unmarked = page.locator('form').filter({ hasText: 'Thinking about it' }).first();
  await expect(unmarked.getByRole('button')).toHaveCount(4);
});

/* ===========================================================================
 * A-092 — `/staff/dashboard/lapsed` composed, at the length it is worked at
 * (§8.6a).
 * ======================================================================== */

test('the lapsed list is drawn at thirty rows, and the number is a 44px target at both ends', async ({
  page,
}) => {
  const list = page.getByRole('list').filter({ hasText: 'Marguerite Okonkwo-Ferreira' }).last();
  const rows = list.getByRole('listitem');
  // A COUNT GUARD FIRST. §8.6a's whole ask is the LENGTH — "it will be thirty
  // rows long; the row needs to survive that" — so a gallery that quietly drew
  // three would pass every assertion below it and prove nothing.
  await expect(rows).toHaveCount(30);

  // §4's 44px desk bar, MEASURED, on the control this screen exists for. It
  // was 16px here and on six other staff surfaces; A-091 had fixed the
  // seventh. The LAST row as well as the first, because the defect this
  // replaces was a target that only survived where somebody had looked.
  for (const row of [rows.first(), rows.last()]) {
    const phone = row.getByRole('link', { name: /^512 555/ });
    const box = await phone.boundingBox();
    expect(box?.height, `${await phone.textContent()} is under the 44px bar`).toBeGreaterThanOrEqual(44);
  }

  // …and it does not sit on top of the link that navigates AWAY from a list
  // this long. Measured before the fix: 3.9px apart, both 16px tall, and the
  // mis-tap costs the reader their place in 6.6 screens of rows.
  const first = rows.first();
  const name = await first.getByRole('link', { name: 'Marguerite Okonkwo-Ferreira' }).boundingBox();
  const phone = await first.getByRole('link', { name: /^512 555/ }).boundingBox();
  expect(phone!.y, 'the number shares a line with the client record link').toBeGreaterThanOrEqual(
    name!.y + name!.height,
  );

  // The six states that lead the list, asserted by what the row SAYS.
  await expect(list).toContainText('No number on the record');
  await expect(list).toContainText('worth ringing again');
  await expect(list).toContainText('Thinking about it — Priya');
  await expect(list.getByRole('link', { name: 'No name' })).toBeVisible();
});

test('a call mark says who it is about, in the accessibility tree', async ({ page }) => {
  // Thirty rows × five buttons drawn from a vocabulary of five words: without
  // the subject, a screen reader hears "Left a message, button" thirty times
  // with nothing to tell them apart. A-091 put the pressed STATE in the tree
  // one item ago; this is the SUBJECT, and the visible label stays the bare
  // word because the four outcomes need the width on a tablet.
  const row = page.getByRole('listitem').filter({ hasText: 'Bea Nakamura' }).last();
  await expect(row.getByRole('button', { name: 'Left a message — Bea Nakamura', pressed: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'No answer — Bea Nakamura', pressed: false })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Not asked — Bea Nakamura' })).toBeVisible();
});
