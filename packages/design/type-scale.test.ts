import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cn } from '../../apps/web/lib/utils';

/**
 * A-094 — THE TYPE SCALE HAS TO SURVIVE `cn`, AND FOR FIVE ITEMS IT DID NOT.
 *
 * `tailwind-merge` decides which of two conflicting classes wins from a
 * built-in map of Tailwind's OWN class names. A-088 named its five roles
 * `text-display`, `text-page-title`, `text-section`, `text-body` and
 * `text-caption`; tailwind-merge has never heard of any of them, files each as
 * a text COLOUR, and drops it the moment a real colour follows in the same
 * merge. `Button`'s size string is `text-body` and every one of its four
 * variants ends in a `text-ink-*`, so the merge kept the colour and threw the
 * size away — in the primitive whose entire job is to be the size everything
 * else copies.
 *
 * Nothing could see it. Both classes are strings of the same shape, so the
 * compiler is happy; the element rendered at the inherited 16px, which is a
 * plausible size, so nothing looked broken; axe measures contrast, not size;
 * and `primitives.test.ts` reads the SOURCE, where `text-body` is present and
 * correct. It is only wrong after the merge runs.
 *
 * TWO ASSERTIONS, and the second is the one that lasts. The first is that each
 * role survives beside a colour today. The second is that the set of roles
 * `globals.css` declares and the set `cn` was told about are THE SAME SET —
 * because the failure mode is not a wrong value, it is a role in one list and
 * not the other, and a sixth role added to the scale would otherwise be
 * silently dropped exactly like these five were.
 */
const CSS = readFileSync(new URL('../../apps/web/app/globals.css', import.meta.url), 'utf8');

/** Every `--text-<role>` in the sheet, minus Tailwind's `--…--line-height`
 *  companions. Derived rather than typed, so the scale is the source. */
const DECLARED = [
  ...new Set(
    [...CSS.matchAll(/^\s*--text-([a-z-]+):/gm)]
      .map((m) => m[1]!)
      .filter((role) => !role.endsWith('-line-height')),
  ),
].sort();

describe("A-088's type scale survives tailwind-merge", () => {
  it('declares the five roles A-088 measured', () => {
    expect(DECLARED).toEqual(['body', 'caption', 'display', 'page-title', 'section']);
  });

  // DERIVED FROM THE STYLESHEET, not listed here, and that is what holds this
  // closed. `cn` cannot read the CSS — it ships in the browser bundle — so it
  // carries its own copy of the role names, and a copy nobody compares is the
  // defect this repo has now found in four disguises (A-086's status list,
  // A-078's constraint names, A-069's `bodyStart`). Looping over what the
  // sheet declares means a SIXTH role added to the scale and forgotten in `cn`
  // fails here, rather than rendering at the inherited size for five items.
  //
  // The class order is the one the primitives actually produce: the size comes
  // from the size string and the colour from the variant string after it,
  // which is the order in which the size loses.
  for (const role of DECLARED) {
    it(`keeps text-${role} when a colour token follows it`, () => {
      expect(cn(`text-${role}`, 'text-ink-primary')).toContain(`text-${role}`);
    });
  }

  /** Two roles in one merge must still collapse — the point is that they are
   *  recognised as sizes, not that conflict resolution is switched off. */
  it('still lets one role override another', () => {
    expect(cn('text-body', 'text-section')).toBe('text-section');
  });

});
