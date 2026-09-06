/**
 * A-094 — the public booking flow ON THE DEVICE IT IS USED ON (design brief
 * §8.8).
 *
 * The client's one shot, on a phone, at night, and she will not see it again
 * for six weeks. Every existing spec over this flow runs at Desktop Chrome's
 * 1280×720 in the light scheme, because that is Playwright's default and
 * nothing had ever said otherwise — so six green accessibility runs measured a
 * page nobody ever sees.
 *
 * `test.use` rather than `emulateMedia` + `reload` (day-grid.spec.ts's
 * pattern): the flow is five steps of CLIENT state, so a reload does not
 * survive to step four. A context that was dark from the first paint buys the
 * same thing the reload was buying there — nothing mid-`transition-colors` at
 * the moment axe samples it — and buys it for every step, not just the first.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { expect, test } from './fixtures';

/** An iPhone 12/13/14's CSS viewport. Not `devices['iPhone 12']`, which also
 *  swaps in WebKit — the sweep runs one browser, and what is under test here
 *  is the LAYOUT at 390 CSS pixels, not Safari. */
test.use({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

const firstOption = (page: Page) => page.locator('fieldset ul > li > button').first();

/** Walks the five steps, running `at` on each. */
async function eachStep(page: Page, at: (where: string) => Promise<void>) {
  await page.goto('/book');
  await at('service');
  await page.getByRole('button', { name: /^Cut 45 min/ }).click();
  await at('service (chosen)');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('group')).toContainText('Who would you like to see?');
  await at('who');
  await page.getByRole('button', { name: 'Dana', exact: true }).click();
  await expect(page.getByRole('group')).toContainText('Which day suits you?');
  await at('day');
  await firstOption(page).click();
  await expect(page.getByRole('group')).toContainText('What time on');
  await at('time');
  await firstOption(page).click();
  await expect(page.getByRole('button', { name: 'Confirm appointment' })).toBeVisible();
  await at('details');
}

test.describe('the booking flow on a phone, at night (A-094)', () => {
  /**
   * THE FINDING THIS ITEM STARTED FROM. Before the fix this failed on the
   * first screen with 12 nodes and never got past it: one value,
   * `text-zinc-500`, at 4.1:1 on #0a0a0a — every duration and every price in
   * the catalogue, the step counter, and on the last screen the price of her
   * own appointment. A-088's `--ink-muted` is zinc-600 for precisely this
   * reason and flips with the scheme by itself.
   */
  test('has no accessibility violations on any screen, in the dark scheme', async ({ page }) => {
    await eachStep(page, async (where) => {
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(violations.map((v) => v.id), where).toEqual([]);
    });
  });

  /**
   * WCAG 2.2 SC 2.5.8, which axe carries no rule for — the reason this is a
   * measurement and not a scan. "Back" shipped at 31×20 CSS px on three of the
   * five screens, missing on BOTH axes, and it is the control a thumb reaches
   * for whenever the last tap was wrong.
   *
   * `boundingBox()`, never a grep for `min-h-11`: a class-string assertion
   * passes the day somebody adds a `py-1` that wins the cascade (A-089).
   */
  test('every control she can tap clears the 24px target minimum', async ({ page }) => {
    const tooSmall: string[] = [];
    await eachStep(page, async (where) => {
      for (const el of await page.locator('button:visible, a:visible, input:visible').all()) {
        const box = await el.boundingBox();
        const name = ((await el.textContent()) ?? (await el.getAttribute('name')) ?? '?').trim().slice(0, 30);
        if (!box || box.width < 24 || box.height < 24) {
          tooSmall.push(`${where}: "${name}" ${box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'unrendered'}`);
        }
      }
    });
    expect(tooSmall).toEqual([]);
  });

  /**
   * And the two the whole flow exists to reach get the full 44 (§4), full
   * width, because a phone has no pointer to aim with. Both measured 36 and
   * sat at their text width beside another control.
   */
  test('the two buttons the flow exists to reach are full-width and 44px', async ({ page }) => {
    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    const cont = await page.getByRole('button', { name: 'Continue' }).boundingBox();
    expect(cont!.height).toBeGreaterThanOrEqual(44);
    // The 390px viewport less the page's own 24px gutters.
    expect(cont!.width).toBe(342);

    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Dana', exact: true }).click();
    await firstOption(page).click();
    await firstOption(page).click();
    const confirm = await page.getByRole('button', { name: 'Confirm appointment' }).boundingBox();
    expect(confirm!.height).toBeGreaterThanOrEqual(44);
    expect(confirm!.width).toBe(342);
  });

  /** A phone that scrolls sideways has lost a control off the right edge, and
   *  she will not find it. */
  test('never scrolls sideways on any screen', async ({ page }) => {
    await eachStep(page, async (where) => {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, where).toBeLessThanOrEqual(clientWidth);
    });
  });

  /**
   * iOS Safari ZOOMS THE VIEWPORT when a focused input's font-size is under
   * 16px, leaving the page magnified and scrolled with the submit button off
   * the right edge for the rest of the form. A-089's `Input` shipped at
   * `text-body`, which A-088 measured this product to be — 14px.
   *
   * Asserted here rather than on `/staff/design` because the failure is a
   * PHONE'S, but the fix is in the shared primitive and the salon's iPad is
   * the same browser: every staff form inherits it.
   */
  test('the text fields are 16px, so the phone does not zoom on focus', async ({ page }) => {
    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Dana', exact: true }).click();
    await firstOption(page).click();
    await firstOption(page).click();

    for (const field of ['Your name', 'Phone', 'Email (optional)']) {
      const px = await page.getByLabel(field).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(px, field).toBeGreaterThanOrEqual(16);
    }
  });

  /**
   * THE LATENCY DEFECT, made deterministic by holding the round-trip open
   * rather than by hoping the machine is slow.
   *
   * Choosing a stylist or a day fires a server action, and the screen used to
   * say nothing at all while it ran — on a phone at night that is a tap that
   * did not work, so she taps again and a second `listTimesOn` goes out. Each
   * step's controls now sit in a `<fieldset disabled={pending}>`, which is one
   * native attribute that reaches every control under it, Back included.
   */
  test('holds its controls while a server round-trip is in flight', async ({ page }) => {
    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // A server action is a POST to the page's own URL. Hold the next one open
    // long enough to look at the screen underneath it.
    let held: (() => void) | undefined;
    await page.route('**/book', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await new Promise<void>((resolve) => (held = resolve));
      await route.continue();
    });

    const dana = page.getByRole('button', { name: 'Dana', exact: true });
    await dana.click();

    await expect(page.locator('fieldset[aria-busy="true"]')).toBeVisible();
    await expect(dana).toBeDisabled();
    // Back too — it is inside the fieldset, and a tap that unwinds the step
    // mid-flight is the same double-action by another route.
    await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();

    held!();
    await expect(page.getByRole('group')).toContainText('Which day suits you?');
  });

  /**
   * The day list stacks the weekday over the date so twenty options fit two to
   * a row. That makes the day TWO strings where every later screen restates it
   * as one, and this is the assertion that they are the same day — the rule
   * this repo wrote down twice (A-082, A-069): when one fact is rendered under
   * two names, assert the two answers are equal rather than checking each.
   */
  test('the day she taps and the day the next screen names are the same day', async ({ page }) => {
    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Dana', exact: true }).click();

    const chosen = firstOption(page);
    // `innerText`, not `textContent`: the two halves are separate elements and
    // the second is a block, so what a person reads has a line break between
    // them where the concatenated source has nothing at all.
    const stacked = (await chosen.evaluate((el) => (el as HTMLElement).innerText)).trim().replace(/\s+/g, ' ');
    await chosen.click();

    await expect(page.getByRole('group')).toContainText(`What time on ${stacked}?`);
  });

  /** Two columns is the whole density argument: twenty days was ~1000px of
   *  near-identical rows on a screen 844 tall. */
  test('offers the days two to a row', async ({ page }) => {
    await page.goto('/book');
    await page.getByRole('button', { name: /^Cut 45 min/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Dana', exact: true }).click();
    await expect(page.getByRole('group')).toContainText('Which day suits you?');

    const days = page.locator('fieldset ul > li > button');
    expect(await days.count()).toBeGreaterThan(2);
    const [a, b] = [await days.nth(0).boundingBox(), await days.nth(1).boundingBox()];
    expect(a!.y).toBe(b!.y);
    expect(b!.x).toBeGreaterThan(a!.x);
  });
});
