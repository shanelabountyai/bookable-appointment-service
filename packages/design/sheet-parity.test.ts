import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A-093 — TWO RENDERERS OF ONE MODEL, AND ONLY ONE OF THEM GETS TOLD.
 *
 * `GridItem` has two readers: `AppointmentChip`, which the desk looks at, and
 * `DaySheet`, which comes off the printer at 8:45 and is the copy of the day
 * that still works when the broadband does not. Every item that has added a
 * fact to the day since A-062 told the chip. Three of them did not tell the
 * paper:
 *
 *   A-069  `released`     — a no-show whose remaining time went back on the
 *                           market, so the client printed against the same
 *                           hour further down is not a printing error.
 *   A-090  the status word — the sheet's filter is `occupiesTime`, which
 *                           deliberately KEEPS `no_show` (D-7), so the sheet
 *                           whose own comment calls it "who is coming" printed
 *                           the one client who definitively is not, in the
 *                           same ink as everybody else.
 *   §5.4.11 `isOverride`  — "the single most important visual in the product",
 *                           on the tablet and on none of the eight pages the
 *                           stylists actually hold.
 *
 * None of the three is visible from inside the item that introduced it: each
 * one edited the chip, looked at the day grid, and was right. This file is the
 * cheap half of the fix — the half that fails on the day somebody adds a tenth
 * field to the chip and does not think about paper.
 *
 * IT IS A ONE-DIRECTION RULE. The sheet may carry MORE than the chip (it
 * carries `overrideReason`, because a page has room for a sentence and a 45px
 * chip does not). What it may not do is carry less by accident — so every chip
 * field is either on the paper or written down here with the reason it is not.
 *
 * THE EXEMPTIONS ARE ASSERTED TOO. A list of names that no longer match
 * anything is the defect A-092 found one level up: a rule pointing at nothing
 * passes forever. Every key below must still be a field the chip actually
 * reads.
 */
const CHIP = readFileSync(new URL('../../apps/web/app/staff/day/appointment-chip.tsx', import.meta.url), 'utf8');
const SHEET = readFileSync(new URL('../../apps/web/app/staff/day/day-sheet.tsx', import.meta.url), 'utf8');

/** Every `item.<field>` a file reads. Deliberately textual: the point is to
 *  catch an edit to the chip, and an edit to the chip is text. */
function fieldsRead(source: string): Set<string> {
  return new Set([...source.matchAll(/\bitem\.([a-zA-Z]+)/g)].map((m) => m[1]!));
}

/**
 * WHAT THE PAPER DOES NOT CARRY, AND WHY. Each of these is a decision, not an
 * omission — which is exactly the difference this file exists to keep visible.
 */
const NOT_ON_PAPER: Record<string, string> = {
  startTime:
    'The chip is POSITIONED by time and needs a short first line; the sheet is a ' +
    'table with a Time column and prints the whole range there.',
  projected:
    'D-22. The sheet is printed once and read all day, so the running-late delta is ' +
    'stamped on the page HEADER as what was true at print, rather than repeated per ' +
    'row as a promise the paper cannot keep.',
  minutes:
    'The chip’s ENVELOPE in minutes, which is geometry: the chip is drawn at that ' +
    'height. The sheet prints `durationMinutes`, the body the stylist has the chair for.',
  appointmentId: 'A control’s target. Nothing on paper is clickable.',
  available: 'The §7 transitions the desk may perform. Nothing on paper is pressable.',
  href: 'The appointment’s page. Nothing on paper navigates, and a printed URL is ink.',
  label: 'The chip’s accessible name — for a screen reader, which paper is not.',
};

describe('the printed sheet against the chip (A-093)', () => {
  const chipFields = fieldsRead(CHIP);
  const sheetFields = fieldsRead(SHEET);

  it('reads a chip that actually reads its item, so this file cannot pass vacuously', () => {
    expect(chipFields.size).toBeGreaterThan(8);
    expect(sheetFields.size).toBeGreaterThan(8);
    // The three A-093 put on the paper, named so a revert is a failure here
    // rather than a silently quieter sheet.
    expect(sheetFields).toContain('isOverride');
    expect(sheetFields).toContain('released');
    expect(sheetFields).toContain('status');
  });

  it('carries every fact the chip carries, or names the reason it does not', () => {
    const missing = [...chipFields].filter((f) => !sheetFields.has(f) && !(f in NOT_ON_PAPER));
    expect(missing).toEqual([]);
  });

  it('has no exemption for a field the chip no longer reads', () => {
    const stale = Object.keys(NOT_ON_PAPER).filter((f) => !chipFields.has(f));
    expect(stale).toEqual([]);
  });

  it('gives every exemption a reason, not a blank line', () => {
    expect(Object.entries(NOT_ON_PAPER).filter(([, why]) => why.trim().length < 20)).toEqual([]);
  });
});
