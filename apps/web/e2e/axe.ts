/**
 * A-096 — THE ONE WAY THIS SUITE RUNS AXE, AND IT RUNS IT IN BOTH SCHEMES.
 *
 * WHY THIS FILE EXISTS. Playwright's default colour scheme is light, and until
 * A-094 no spec had ever changed it — so on a palette built to flip with
 * `prefers-color-scheme` (A-088), exactly half of it had never been measured
 * by anything. The half nobody looked at was failing: **275 colour-contrast
 * nodes across twelve staff routes**, every one of them the same value,
 * `text-zinc-500` — #71717b on #0a0a0a, **4.1:1** against AA's 4.5:1. Light
 * was clean on every one of those twelve routes, which is why forty green axe
 * runs had nothing to say about it.
 *
 * The fix for the colour was one substitution (`--ink-muted`, which is
 * zinc-600 in light and zinc-400 in dark and flips by itself). The fix for the
 * BLINDNESS is this file: the scheme loop lives inside the helper, so a spec
 * cannot opt out of dark by writing the assertion the obvious way, and
 * `no-restricted-imports` in `eslint.config.mjs` stops a spec importing
 * `AxeBuilder` and re-growing the light-only version.
 *
 * WHY TRANSITIONS ARE KILLED AND THE PAGE IS *NOT* RELOADED. Switching the
 * media query on a live page catches every control mid-`transition-colors`,
 * and axe then samples the blend — A-092 measured 583 nodes of colours nobody
 * ships. The three specs that already ran both schemes solved that by
 * reloading. Reloading also throws away everything the test had built: an open
 * panel, a typed form, a five-step booking flow. Measured on four staff routes
 * (A-096): the naive flip invents 10 phantom nodes on the client record and 2
 * on the day grid, while killing transitions and reloading agree **exactly**,
 * on all four, in both directions. So this takes the one that keeps the page —
 * because a helper that silently measured a page the test had not built is the
 * defect this file is here to prevent, one level up. A-096 hit precisely that
 * while measuring: a sweep whose sign-in had quietly failed reported 46 clean
 * routes, all of them the login page.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.0 + 2.1, A and AA. `color-contrast` carries `wcag2aa`, so it is in. */
export const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

type Impact = 'minor' | 'moderate' | 'serious' | 'critical';

/**
 * The bar the screens that ship known moderate findings are held to. It still
 * catches every colour problem this item was about: axe rates `color-contrast`
 * **serious**, so an impact filter narrows what a screen is asserted on
 * WITHOUT narrowing the dark-scheme sweep.
 */
export const SERIOUS: readonly Impact[] = ['serious', 'critical'];

export type AxeOptions = {
  /**
   * Names the moment — which screen, which step. It reaches the failure
   * message alongside the scheme, because "expected [] to equal [...]" on its
   * own does not say which of a five-screen flow was being looked at.
   */
  where?: string;
  /**
   * Rule tags. `null` runs every rule axe carries, which is what a bare
   * `.analyze()` did at the call sites this replaced — BROADER than the WCAG
   * set, not narrower, so those keep their reach.
   */
  tags?: readonly string[] | null;
  /**
   * Assert only at these impacts. One caller uses it (`/staff/availability`,
   * which ships known moderate findings) and it is deliberately awkward to
   * reach for: an impact filter is how a screen stops being measured.
   */
  impacts?: readonly Impact[];
};

/** Kills transitions AND animations, so the palette axe samples is the settled
 *  one rather than whatever frame the scheme flip landed on. */
const FREEZE = '*,*::before,*::after{transition:none!important;animation:none!important}';

/**
 * Runs axe in light AND dark and asserts no violations in either.
 *
 * Leaves the page on the context's own colour scheme, so a file-level
 * `test.use({ colorScheme: 'dark' })` survives the call, and leaves `media`
 * alone entirely — the print-sheet spec sets that and keeps it.
 */
export async function expectNoAxeViolations(page: Page, options: AxeOptions = {}): Promise<void> {
  const { where, tags = WCAG_AA, impacts } = options;

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const frozen = await page.addStyleTag({ content: FREEZE });
    try {
      let builder = new AxeBuilder({ page });
      if (tags) builder = builder.withTags([...tags]);
      const { violations } = await builder.analyze();
      const asserted = impacts ? violations.filter((v) => impacts.includes(v.impact as Impact)) : violations;
      expect(asserted, [where, `${colorScheme} scheme`].filter(Boolean).join(' — ')).toEqual([]);
    } finally {
      // Removed rather than left behind: a global `transition: none` that
      // outlives the assertion changes every later step of the same test.
      await frozen.evaluate((el: Element) => el.remove()).catch(() => undefined);
    }
  }

  await page.emulateMedia({ colorScheme: null });
}
