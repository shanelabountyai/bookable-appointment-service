import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * DEMO CHECKPOINT 7 (A-087) — NO STATIC `opacity-*` ON A STAFF SURFACE.
 *
 * WHAT THE WALK FOUND. `/staff/day` on a real book — a day that has been
 * worked through, so most of its chips are `completed` — failed WCAG AA on
 * every one of them, in BOTH colour schemes:
 *
 *   <span class="block truncate opacity-80">Cut & finish · +15125550103</span>
 *   light  #72727b on #f4f4f5 = 4.33:1   (needs 4.5:1 at 12px)
 *   dark   #878790 on #27272a = 4.18:1
 *
 * Three decisions, each defensible alone. `completed` paints a darker ground
 * (`bg-zinc-100`). It also paints a lighter ink (`text-zinc-600`) — which is
 * 7.0:1 on that ground and correct. Then the chip's detail line multiplied
 * that ink by 0.8. The product is a colour that exists only in the compositor.
 *
 * WHY THE TOKEN LAYER COULD NOT SEE IT. A-088's whole point is that the stated
 * contrast is a COMPUTED one — `tokens.test.ts` reads each token and asserts it
 * against its own ground at its real bar, so a number in a comment cannot rot.
 * An `opacity-*` at the call site is the same fact written a second time under
 * another name: it changes the rendered colour without changing the token, so
 * every contrast assertion in the repo still passes. This repo's most-found
 * defect, one layer down from where it has been found before.
 *
 * WHY THE SUITE COULD NOT SEE IT EITHER. `day-grid.spec.ts` runs axe on this
 * exact page and is green — it seeds ONE appointment, and it is `booked`, whose
 * ground is `bg-white`, where the same 0.8 lands on 4.66:1 and passes by a
 * hundredth. **The violation needs a chip somebody has closed out**, which is
 * what a real evening's book is made of and what no fixture had ever rendered.
 * That spec now seeds a completed chip and a cancelled one; this file is the
 * cheaper half, and the half that fails on the day somebody types it again.
 *
 * THE RULE, and why it is drawn here rather than at `components/ui`:
 * `primitives.test.ts` guards the six primitives against reaching past the
 * tokens. This guards every staff surface against reaching past the CONTRAST
 * ASSERTION, which is a different and wider promise — the day grid is not a
 * primitive and never will be.
 *
 * VARIANT-PREFIXED OPACITY IS ALLOWED, and the exemption is WCAG's own:
 * 1.4.3 does not apply to disabled controls, so `disabled:opacity-60` is the
 * house idiom for a pending button and stays. `hover:`/`focus:` likewise
 * describe a transient state axe does not measure. It is the UNPREFIXED one —
 * the colour the desk reads all day — that has to be a colour somebody checked.
 */
const STAFF_DIR = new URL('../../apps/web/app/staff/', import.meta.url);

function tsxFilesUnder(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tsxFilesUnder(new URL(`${entry.name}/`, dir)).map((f) => `${entry.name}/${f}`)
      : entry.name.endsWith('.tsx')
        ? [entry.name]
        : [],
  );
}

/** Unprefixed only: `opacity-80`, never `disabled:opacity-60`. The negative
 *  lookbehind is on the `:` a Tailwind variant ends with. */
const STATIC_OPACITY = /(?<![:\w-])opacity-\d/;

const FILES = tsxFilesUnder(STAFF_DIR);

describe('no staff surface dims text with an alpha', () => {
  // Walked rather than listed, so a screen added by a later item is covered
  // without anybody remembering to add it here.
  it('has staff surfaces to check', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    const source = readFileSync(new URL(file, STAFF_DIR), 'utf8');
    // Comments describe the opacity that was REMOVED — matching them would
    // make the guard fire on its own explanation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it(`${file} uses no unprefixed opacity utility`, () => {
      expect(code.match(STATIC_OPACITY)?.[0]).toBeUndefined();
    });
  }
});
