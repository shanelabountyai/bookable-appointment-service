'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * A-091 — `CallMarkButtons` (design brief §5.4.9).
 *
 * "The four-outcome attempt marks, with an undo, actor-stamped and
 * re-stampable. ONE COMPONENT, THREE SURFACES: the waitlist matcher, the
 * lapsed-client report, and — in a two-outcome sibling — the call-down. This
 * is the most-reused interactive control in the product and it has no design
 * at all."
 *
 * It was not one component. A-061 wrote it for the call-down, A-072 wrote it
 * again for the waitlist (four outcomes instead of two, and a copy of the same
 * eleven-line `button()` style function), and A-073 wrapped A-072's for the
 * lapsed list. Two implementations of one idea, and the styling of the pressed
 * state written out twice — so this is one component parameterised by the only
 * three things that actually differ: the WORDS (two on the call-down, four
 * here), the form's hidden payload, and the undo's label.
 *
 * TWO THINGS THAT WERE WRONG IN BOTH COPIES, and both are §4:
 *
 *  - **26px tall.** `px-2 py-1 text-xs` on the control the desk taps more than
 *    any other in the product, on a tablet, where §4's bar is 44px and is a
 *    correctness rule rather than a preference. And the harm of a mis-tap is
 *    not a wasted tap: a shared screen with the wrong client marked as rung
 *    SILENTLY SKIPS HER, which is the exact harm the undo below exists to
 *    reverse. `Button` at its default `md` is 44px; `e2e/call-marks.spec.ts`
 *    measures it rather than grepping for the class.
 *  - **The pressed state was not in the accessibility tree at all.** Both
 *    copies carried a comment saying `aria-pressed` "is not available on a
 *    submit button that is also the form's payload". That is not true — a
 *    `<button type="submit">` has role `button` and role `button` supports
 *    `aria-pressed` — so a screen reader got four identically-named buttons
 *    and no indication of which one stands. Colour alone, in the tree as well
 *    as on the screen.
 *
 * Every outcome stays available on a marked row: "no answer at 2, thinking
 * about it at 4" re-stamps the same row, so correcting a mis-pressed outcome
 * needs no separate control.
 *
 * A RECORD, NOT A HOLD (D-37(b)). Nothing here reserves a slot, refuses a
 * booking or sends anything.
 */
export interface CallMarkState {
  ok?: boolean;
  message?: string;
}

const INITIAL: CallMarkState = {};

export function CallMarkButtons<Outcome extends string>({
  words,
  current,
  hidden,
  action,
  undoLabel,
}: {
  /** The outcomes in the desk's own words, TOTAL over the outcome enum — so a
   *  fifth is a compile error at the caller rather than a raw value here. */
  words: Record<Outcome, string>;
  /** The mark that stands, if any. */
  current: Outcome | undefined;
  /** What this form is about — `subject`/`clientId` here, `appointmentId` on
   *  the call-down. The outcome itself is the pressed button's own value. */
  hidden: Record<string, string>;
  action: (state: CallMarkState, formData: FormData) => Promise<CallMarkState>;
  /** "Not asked" / "Not rung" — the undo, in the surface's own words. */
  undoLabel: string;
}) {
  // A form per row, like `ConfirmButton` beside it: `useActionState` is one
  // hook per component instance, and a shared one would show row three's
  // result next to row one.
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {(Object.keys(words) as Outcome[]).map((outcome) => (
        <Button
          key={outcome}
          name="outcome"
          value={outcome}
          type="submit"
          // Inversion, not a tint: it survives greyscale on the printed sheet
          // and it is the same "selected" signal the tabs and the day nav use.
          variant={current === outcome ? 'primary' : 'secondary'}
          aria-pressed={current === outcome}
          pending={pending}
        >
          {words[outcome]}
        </Button>
      ))}

      {/* The undo. A mis-tap on a SHARED screen marks the wrong client as
          rung, which silently skips her — the harm this exists to prevent,
          inverted — so it has to be reversible by the same hand, at the same
          size as the thing it reverses. */}
      {current ? (
        <Button name="outcome" value="clear" type="submit" variant="quiet" pending={pending}>
          {undoLabel}
        </Button>
      ) : null}

      {state.message ? (
        <span aria-live="polite" className="w-full text-caption text-ink-muted">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
