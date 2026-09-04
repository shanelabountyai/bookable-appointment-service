import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A-089 — THE PRIMITIVES SPEND TOKENS, NOTHING ELSE.
 *
 * A-088's token layer only pays off if the things built on it stop reaching
 * past it. The audit it was derived from counted `text-zinc-600` ×136 sitting
 * beside `dark:text-zinc-400` ×132 — one fact written twice, which is the
 * whole reason the `var()` indirection exists. A primitive that quietly puts
 * `border-zinc-400` back is not a style problem: it is a value that no longer
 * flips with the colour scheme, is not covered by `tokens.test.ts`'s contrast
 * assertions, and does not follow the print overrides.
 *
 * So the guard is structural rather than visual, and it is the cheapest thing
 * that can fail: no raw palette anywhere under `components/ui`, and no `dark:`
 * variant, because a `dark:` in a primitive means somebody has gone around the
 * tokens rather than through them.
 *
 * Scoped to the primitives on purpose. The rest of the staff app still renders
 * raw zinc everywhere and A-085 onwards is what converts it; widening this
 * glob before then would just fail.
 */
const UI_DIR = new URL('../../apps/web/components/ui/', import.meta.url);

const FILES = readdirSync(UI_DIR).filter((f) => f.endsWith('.tsx'));

/** Tailwind's default palettes, plus the two bare colour keywords the audit
 *  found in button and badge classes (`text-white`, `bg-white`). */
const RAW_PALETTE =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|placeholder|divide|accent|caret|shadow)-(?:zinc|slate|gray|neutral|stone|amber|yellow|orange|red|rose|pink|fuchsia|purple|violet|indigo|blue|sky|cyan|teal|emerald|green|lime|white|black)\b/;

describe('the ui primitives are built out of tokens', () => {
  // The directory is globbed rather than listed, so a primitive added by a
  // later item is covered without anybody remembering to add it here.
  it('has primitives to check', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    const source = readFileSync(new URL(file, UI_DIR), 'utf8');
    // Comments describe the palette the tokens REPLACED — matching them would
    // make the guard fire on its own explanation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it(`${file} uses no raw palette utility`, () => {
      expect(code.match(RAW_PALETTE)?.[0]).toBeUndefined();
    });

    it(`${file} needs no dark: variant`, () => {
      expect(code.match(/\bdark:/)?.[0]).toBeUndefined();
    });

    it(`${file} hard-codes no hex`, () => {
      expect(code.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]).toBeUndefined();
    });
  }
});
