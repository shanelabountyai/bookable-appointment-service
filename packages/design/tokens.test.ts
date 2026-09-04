import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A-088 — THE CONTRAST RESULTS, COMPUTED (design brief §5.1, §4).
 *
 * §5.1 asks for "a stated contrast result" per intent token. A number stated
 * in a comment is right on the day it is written and silently wrong the first
 * time somebody nudges a hex — which is exactly how the public palette got
 * two tokens that passed axe on half the marketing pages and failed on the
 * other half (`--color-muted-ink`'s header comment tells that story). So the
 * result is not stated. It is derived from the tokens themselves, here, at
 * every `npm test`.
 *
 * This complements the axe run rather than duplicating it: axe measures what
 * a rendered page actually paints, and cannot see a token that no screen has
 * adopted yet. A-089 onwards adopt them; this file is what makes adopting one
 * safe before any page proves it.
 *
 * Deliberately parsed out of the CSS rather than imported from a TypeScript
 * source of truth that generates it: the CSS is what ships, and a generator
 * would leave the shipped file un-asserted — one fact under two names, which
 * is the class of defect this project keeps finding.
 */
const CSS = readFileSync(new URL('../../apps/web/app/globals.css', import.meta.url), 'utf8');

/** The `:root` block in a given scope. `scope` is `''` for light (the bare
 *  top-level `:root`) or the media condition for a nested one. */
function tokensFor(mode: 'light' | 'dark'): Map<string, string> {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  // Every `--token: #hex;` declaration, in source order, with the ones inside
  // the dark media block flagged by their position relative to its opening.
  const darkAt = CSS.indexOf('@media (prefers-color-scheme: dark)');
  const printAt = CSS.indexOf('@media print');
  for (const m of CSS.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    const at = m.index ?? 0;
    if (at > printAt) continue; // the print overrides are a third mode, checked separately
    (at > darkAt ? dark : light).set(m[1]!, m[2]!);
  }
  if (mode === 'light') return light;
  // Dark inherits every token it does not itself redeclare.
  return new Map([...light, ...dark]);
}

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const GRAPHIC = 3;

/** Every ground an ink or a line is allowed to land on. `--ground-inverted`
 *  is excluded on purpose: only `--ink-inverted` goes there, and that pair is
 *  asserted on its own below. */
const GROUNDS = ['--ground-page', '--ground-raised', '--ground-sunken'] as const;
const INTENTS = ['positive', 'attention', 'danger', 'info'] as const;

describe.each(['light', 'dark'] as const)('the %s token set', (mode) => {
  const t = tokensFor(mode);
  const ratio = (a: string, b: string) => contrast(t.get(a)!, t.get(b)!);

  it('declares every token the other mode declares', () => {
    // A token defined only in light silently inherits its light value into
    // dark, which is how a dark screen ends up with a near-black ink on a
    // near-black ground and nothing fails. Every value below is therefore
    // resolved, never undefined.
    for (const name of [...GROUNDS, '--ground-inverted', '--ink-primary', '--ink-secondary', '--ink-muted', '--ink-inverted', '--line-control', '--line-strong', '--focus-ring']) {
      expect(t.get(name), `${name} missing in ${mode}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(['--ink-primary', '--ink-secondary', '--ink-muted'])('%s is text-legible on every ground it can land on', (ink) => {
    for (const ground of GROUNDS) {
      expect(ratio(ink, ground), `${ink} on ${ground} (${mode})`).toBeGreaterThanOrEqual(TEXT);
    }
  });

  it('inverted ink is legible on the inverted ground', () => {
    expect(ratio('--ink-inverted', '--ground-inverted')).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(INTENTS)('%s ink is text-legible on every ground AND on its own fill', (intent) => {
    for (const ground of [...GROUNDS, `--intent-${intent}-fill`]) {
      expect(ratio(`--intent-${intent}-ink`, ground), `${intent} on ${ground} (${mode})`).toBeGreaterThanOrEqual(TEXT);
    }
  });

  it.each(INTENTS)('%s line clears the graphical bar on every ground AND on its own fill', (intent) => {
    for (const ground of [...GROUNDS, `--intent-${intent}-fill`]) {
      expect(ratio(`--intent-${intent}-line`, ground), `${intent} line on ${ground} (${mode})`).toBeGreaterThanOrEqual(GRAPHIC);
    }
  });

  it('the control border and the focus ring clear the graphical bar', () => {
    // 1.4.11: the boundary that IDENTIFIES a control, and the ring that shows
    // where the keyboard is. `--line-hairline` is absent on purpose — it is
    // decorative and nothing is identified by it.
    for (const ground of GROUNDS) {
      expect(ratio('--line-control', ground), `control border on ${ground} (${mode})`).toBeGreaterThanOrEqual(GRAPHIC);
      expect(ratio('--focus-ring', ground), `focus ring on ${ground} (${mode})`).toBeGreaterThanOrEqual(GRAPHIC);
    }
    expect(ratio('--line-strong', '--ground-page')).toBeGreaterThanOrEqual(GRAPHIC);
  });
});

describe('the print overrides (A-062, extended by A-088)', () => {
  it('drives every ground to white and every ink to black', () => {
    const print = CSS.slice(CSS.indexOf('@media print'));
    for (const ink of ['--ink-primary', '--ink-secondary', '--ink-muted', '--intent-attention-ink', '--intent-danger-ink']) {
      expect(print, `${ink} not forced for print`).toMatch(new RegExp(`${ink}:\\s*#000000`));
    }
    for (const ground of GROUNDS) {
      expect(print, `${ground} not forced for print`).toMatch(new RegExp(`${ground}:\\s*#ffffff`));
    }
  });
});
