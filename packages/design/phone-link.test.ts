import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A-092 — THE NUMBER THE DESK DIALS IS ONE COMPONENT.
 *
 * WHAT THE ITEM FOUND. §8.6a asked for `/staff/dashboard/lapsed` "at thirty
 * rows… each row a phone call waiting to be made", and on that screen the
 * thing you tap to make the call measured **16px tall and 3.9px from a link
 * that navigates away** — a third of §4's 44px tablet bar, beside the client
 * record, on a list that measured 5044px (6.6 screens on a 1024×768 tablet).
 *
 * WHY THE FIX HAD TO BE A COMPONENT AND NOT AN EDIT, and why this file exists
 * rather than a note. A-091 fixed `FreedSlotRow`'s copy one item earlier and
 * wrote down what it had left: *"the `tel:` links on the waitlist, lapsed and
 * call-down rows are still inline `text-sm`."* Three. A grep says **eight** —
 * those three plus the appointment detail, the stranded list on Providers, the
 * conflicts list, the day column's ring-round and `/staff/opened` itself.
 * **The list of known copies was itself written from memory**, which is the
 * same defect one level up, and it is why seven stayed at 16px. A guard that
 * walks the directory cannot undercount.
 *
 * WHY NOTHING IN THE GATE COULD SEE IT. 44px is WCAG 2.5.5, which is AAA; the
 * AA rule CI runs is 2.2's 2.5.8 at 24px, and 16 fails that too — but axe's
 * `target-size` check is not in the four tags CI asserts on. So the height is
 * measured for real in `e2e/design-system.spec.ts` against a rendered box, and
 * this file is the cheaper half: the one that fails on the day somebody types
 * the ninth copy.
 *
 * THE HREF IS PART OF IT. Every staff copy interpolated the stored string
 * straight into `tel:`, so a number typed "(512) 555-0188" dialled nothing;
 * `PhoneLink` strips it the way the public site's `telHref` has since the
 * marketing pages were built.
 *
 * Scoped to `app/staff/` on purpose. The public site's one `tel:` belongs to
 * the other palette (§5.1) and is not a desk target.
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

/** A `tel:` href written at a call site — the shape all eight copies had. */
const RAW_TEL = /href=\{?[`'"]tel:/;

const FILES = tsxFilesUnder(STAFF_DIR);

describe('no staff surface writes its own tel: link', () => {
  // Walked rather than listed, so a screen added by a later item is covered
  // without anybody remembering to add it here.
  it('has staff surfaces to check', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    const source = readFileSync(new URL(file, STAFF_DIR), 'utf8');
    // Comments describe the link that was REPLACED — matching them would make
    // the guard fire on its own explanation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it(`${file} dials through PhoneLink`, () => {
      expect(code.match(RAW_TEL)?.[0]).toBeUndefined();
    });
  }

  /** The guard is only worth anything while the component it points at is
   *  actually the one being used — a rule with no callers passes forever. */
  it('and something actually calls it', () => {
    const callers = FILES.filter((file) =>
      readFileSync(new URL(file, STAFF_DIR), 'utf8').includes("from '@/components/ui/phone-link'"),
    );
    expect(callers.length).toBeGreaterThanOrEqual(8);
  });
});
