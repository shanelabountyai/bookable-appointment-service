'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { type AppointmentStatus, SLOT_FREEING_STATUSES } from '@bookable/core/scheduling';
import { type DetailState, changeStatus, releaseTime, undoStatus, unreleaseTime } from '@/lib/appointments/actions';
import { STATUS_ACTION_LABELS } from '@/app/staff/day/status-actions';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initial: DetailState = {};

/**
 * The status buttons (APPT-01, APPT-03, APPT-06).
 *
 * The list comes from the server, which asked the §7 transition table with
 * this actor and this clock — so a button here can never offer a move the
 * write path then refuses. Nothing in this file decides what is legal.
 *
 * The reason field is always available and only sometimes required. The
 * machine decides which: a walk-out and a terminal correction need one, an
 * ordinary check-in does not, and the refusal comes back in words if it is
 * missing.
 *
 * A-060: CANCELLING IS ONE BUTTON. `cancelled` and `cancelled_late` are not in
 * `available` — the page took them out — because two buttons a thumb-width
 * apart, pressed under pressure, decided a number that lands on the client's
 * rolling late-cancel count and on the owner's staffing decisions. The server
 * derives the status from the cutoff and the clock; `cancelAs` is what it will
 * decide, shown so the desk knows before it presses rather than after.
 *
 * The escape beside it is deliberately NOT a second classification button. It
 * appears only when the machine's answer is `cancelled_late`, it says what it
 * means in the salon's words, it demands a reason, and it is recorded as an
 * overrule — so "we let this one off" stays a visible, countable act instead
 * of being indistinguishable from the cutoff never having applied.
 */
export function StatusControls({
  appointmentId,
  status,
  available,
  cancelAs,
  undo = null,
  release,
}: {
  appointmentId: string;
  status: AppointmentStatus;
  available: AppointmentStatus[];
  /** A-069 / D-44. `null` when there is nothing to give back — every status
   *  but `no_show`, and a no-show whose time is over or already released. */
  release: { minutes: number; words: string } | { releasedLabel: string; words: string } | null;
  /** What the server WILL write if the one Cancel button is pressed, or null
   *  when no cancellation is on the table at all. Advisory: the write path
   *  derives it again from the same arithmetic and never trusts this. */
  cancelAs: 'cancelled' | 'cancelled_late' | null;
  /** A-160 (D-77). "Finished by Sam · 11:02" while that tap can still be
   *  undone; null otherwise. The server decided — this only draws it. */
  undo?: string | null;
}) {
  const [state, action, pending] = useActionState(changeStatus, initial);

  // A-112 (D-53). Asked of the STATUS, not of `available`: the server already
  // decided whether the edge is on the table (seven days, staff, reason), and
  // this only decides whether the notice checkbox has anything to be about.
  const reinstating = (SLOT_FREEING_STATUSES as readonly string[]).includes(status);

  // A-069's panel is its OWN form (its own action), so it sits beside this one
  // rather than inside it — nested forms are invalid, and more to the point a
  // control that changes no status has no business in the form that does.
  // Rendered on BOTH branches: a no-show still has APPT-06's correction edge
  // available, so the dead-end branch below is not the one it lands on.
  if (available.length === 0 && !cancelAs) {
    return (
      <div className="flex flex-col gap-3">
        <UndoPanel appointmentId={appointmentId} status={status} undo={undo} />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Nothing more to do with this one — {status.replace('_', ' ')} is where it ends.
        </p>
        <ReleasePanel appointmentId={appointmentId} release={release} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <UndoPanel appointmentId={appointmentId} status={status} undo={undo} />
      <form action={action} className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      {/* The status the screen SHOWED. If somebody else moved it meanwhile,
          the write is refused and says who got there first, rather than
          silently overwriting their decision. */}
      <input type="hidden" name="expectedFrom" value={status} />

      <Field id="status-reason" label="Reason (needed for some changes)">
        {(control) => <Input {...control} name="reason" placeholder="Walked out / marked wrong yesterday" />}
      </Field>

      {/* A-112 (D-53) — the only OPT-IN notice in the product, and the only
          place a checkbox here means "send" rather than "don't send".
          Rendered from the status rather than from the button list because it
          belongs to one move: the cancellation this is undoing has already
          been texted, so a second message is a decision, not a default. The
          desk's usual first move is the phone. */}
      {reinstating ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="tellThem" className="mt-0.5" />
          <span>
            Text them to say it&apos;s back on
            <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">
              They were already sent a cancellation. Leave this alone if you&apos;re ringing them.
            </span>
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {available.map((to) => (
          <Button key={to} type="submit" name="to" value={to} pending={pending}>
            {STATUS_ACTION_LABELS[to]}
          </Button>
        ))}

        {/* One button, and `to` is deliberately absent from it: the status is
            the server's to choose, so this posts the INTENT and the write path
            resolves the cutoff from real rows. */}
        {cancelAs ? (
          <Button type="submit" name="cancel" value="derive" pending={pending}>
            {cancelAs === 'cancelled_late' ? 'Cancel — counts as late' : 'Cancel'}
          </Button>
        ) : null}
      </div>

      {cancelAs === 'cancelled_late' ? (
        <Button
          type="submit"
          name="cancel"
          value="override"
          pending={pending}
          className="self-start border-dashed text-left"
        >
          Proper notice given, or this one&apos;s on us — don&apos;t count it late
          <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">
            Needs a reason. Recorded as overruling the cutoff.
          </span>
        </Button>
      ) : null}

      <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
      </form>

      {/* She IS a no-show, correctly and permanently. The seventy minutes she
          is not using is a different question, and this is where it is asked. */}
      <ReleasePanel appointmentId={appointmentId} release={release} />
    </div>
  );
}

/**
 * A-069 / D-44 — "she never came; give the rest of her time back".
 *
 * OFFERED AT THE MOMENT THE DESK MARKS THE NO-SHOW, not a screen away: that is
 * the only moment anybody is thinking about the slot, and a door nobody knows
 * to walk through is the gap A-043 was built to close.
 *
 * ITS OWN FORM, because it is its own action. Putting it in the status form
 * would make it a fourth thing that decides a status, which is exactly what
 * A-060 took apart — and this one changes NO status at all. She stays a
 * no-show, her twelve-month count is untouched, utilization is untouched, and
 * the only thing that moves is what the salon may sell.
 */
function ReleasePanel({
  appointmentId,
  release,
}: {
  appointmentId: string;
  release: { minutes: number; words: string } | { releasedLabel: string; words: string } | null;
}) {
  const [state, action, pending] = useActionState(releaseTime, initial);

  // live-region-ok: nothing to give back for this appointment at all — the panel does not apply, no result is being removed.
  if (release === null) return null;
  if ('releasedLabel' in release) {
    // The SETTLED state carries the pointer, not the toast. `revalidatePath`
    // re-renders this panel the moment the action returns, so the success
    // message from `useActionState` is replaced before anybody reads it —
    // which is right, and means the sentence worth saying belongs here.
    // `state.message` below stays as the FAILURE channel, where the server
    // state has not changed and the message is the only thing that has.
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The remaining time went back on the market at {release.releasedLabel}. {release.words}{' '}
          <Link href="/staff/opened" className="underline underline-offset-4">
            See What&apos;s opened up
          </Link>
          .
        </p>
        {/* A-075 / D-45. Without this she keeps a no-show she did not earn:
            booking her into her own released tail makes the APPT-06 correction
            permanently impossible, and the desk finds that out as a refusal it
            cannot act on. Refused by the constraint the moment the tail has
            been sold, and said in words when it is. */}
        <UnreleasePanel appointmentId={appointmentId} />
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-dashed border-zinc-400 p-4 dark:border-zinc-600">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <p className="text-sm">
        {/* A-091 took the pronoun out here too: the record has no gender field,
            and this sentence renders about whoever the appointment names. */}
        <span className="font-medium">Nobody came, and {release.minutes} minutes of this slot are still blocked.</span>{' '}
        Give them back and the walk-in at the door can have them — with no override, because the time really is
        free. {release.words}
      </p>
      {/* NOT "Why (optional)": A-068's client correction is on this same page
          with a reason box of its own, and two identically-labelled fields are
          ambiguous to a screen reader long before they are ambiguous to a
          test. This one is about what happened to HER. */}
      <Field id="release-reason" label="What happened (optional)">
        {(control) => <Input {...control} name="reason" placeholder="Rang twice, no answer" />}
      </Field>
      <Button type="submit" pending={pending} className="self-start">
        {pending ? 'Putting it back…' : `Put ${release.minutes} min back on the market`}
      </Button>
      <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
    </form>
  );
}

/**
 * A-075 / D-45 — "she's here after all; put her time back on the book".
 *
 * Its own form and its own action, beside the sentence that says what was
 * done. It changes no status: she is still a no-show until somebody corrects
 * her, and that correction is the desk's next tap — which now succeeds,
 * because the range it needs is hers again.
 */
function UnreleasePanel({ appointmentId }: { appointmentId: string }) {
  const [state, action, pending] = useActionState(unreleaseTime, initial);

  return (
    <form action={action} className="flex flex-col gap-2 text-sm">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <Button type="submit" pending={pending} className="self-start">
        {pending ? 'Putting it back…' : 'They’re here after all — put the time back on the book'}
      </Button>
      <p aria-live="polite" className="text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
    </form>
  );
}

/**
 * A-160 (D-77) — "Finished by Sam · 11:02 · Undo".
 *
 * Its own form and its own action: the destination comes from the log on the
 * server, so this posts no `to` at all. Rendered until the window closes or
 * the undo lands; the failure message stays here because a refused undo does
 * not change the status and nothing else will say why.
 */
function UndoPanel({ appointmentId, status, undo }: { appointmentId: string; status: AppointmentStatus; undo: string | null }) {
  const [state, action, pending] = useActionState(undoStatus, initial);

  // live-region-ok: nothing to undo — no result is being removed; a refusal keeps the panel, because the server state did not change.
  if (undo === null && !state.message) return null;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 text-sm">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="expectedFrom" value={status} />
      {undo ? (
        <>
          <span>{undo}</span>
          <span aria-hidden="true">·</span>
          <Button type="submit" pending={pending}>
            Undo
          </Button>
        </>
      ) : null}
      <p aria-live="polite" className="basis-full text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
    </form>
  );
}
