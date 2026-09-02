'use client';

import { useActionState } from 'react';
import type { FreedOffer, FreedOfferOutcome } from '@bookable/db/waitlist';
import { type OfferState, recordOffer } from '@/lib/waitlist/offer-actions';
import { OFFER_WORDS } from '@/lib/waitlist/offer-words';

const initial: OfferState = {};

/**
 * A-072 — WHO HAS ALREADY BEEN RUNG ABOUT THIS SLOT (WAIT-02).
 *
 * The desk rings Mrs Patel, who says "let me check with work". A walk-in
 * arrives, the phone goes, and at 4pm the second person at the desk opens the
 * same list, sees the same two names and rings Mrs Patel again — or promises
 * the slot to the second name while the first is still deciding.
 *
 * FOUR OUTCOMES, NOT A TICK, and each of them is a different next action:
 * "no answer" is still to try, "left a message" is the ball in her court,
 * "she's thinking about it" means do not promise it to anybody else yet, and
 * "she took it" means stop ringing. A boolean would collapse all four into
 * "tried", which is the state the Post-it existed to escape.
 *
 * A RECORD, NOT A HOLD (D-37(b)): the slot stays sellable to anybody
 * throughout — nothing here refuses a booking or reserves anything, and
 * nothing is sent.
 *
 * A form per row, like A-061's beside it: `useActionState` is one hook per
 * component instance, and a shared one would show row three's result next to
 * row one.
 */
export function OfferButtons({
  freedKey,
  appointmentId,
  clientId,
  offer,
}: {
  freedKey: string;
  appointmentId: string;
  clientId: string;
  offer: FreedOffer | undefined;
}) {
  const [state, formAction, pending] = useActionState(recordOffer, initial);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1">
      <input type="hidden" name="freedKey" value={freedKey} />
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="clientId" value={clientId} />

      {/* All four stay available on a marked row: "no answer at 2, thinking
          about it at 4" re-stamps the same row, so correcting a mis-pressed
          outcome needs no separate control. */}
      {(Object.keys(OFFER_WORDS) as FreedOfferOutcome[]).map((outcome) => (
        <button
          key={outcome}
          name="outcome"
          value={outcome}
          type="submit"
          disabled={pending}
          className={button(offer, outcome)}
        >
          {OFFER_WORDS[outcome]}
        </button>
      ))}

      {/* The undo. A mis-tap on a SHARED screen marks the wrong client as
          asked, which silently skips her — the harm this exists to prevent,
          inverted — so it has to be reversible by the same hand. */}
      {offer ? (
        <button
          name="outcome"
          value="clear"
          type="submit"
          disabled={pending}
          className="ml-1 text-xs text-zinc-500 underline underline-offset-4 disabled:opacity-60"
        >
          Not asked
        </button>
      ) : null}

      {state.message ? (
        <span aria-live="polite" className="w-full text-xs text-zinc-500">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/** The pressed outcome reads as pressed. `aria-pressed` is not available on a
 *  submit button that is also the form's payload, so the state is carried by
 *  the visible style and by the sentence on the row beside it. */
const button = (offer: FreedOffer | undefined, outcome: FreedOfferOutcome) =>
  [
    'rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-60',
    offer?.outcome === outcome
      ? 'border-zinc-800 bg-zinc-800 text-zinc-50 dark:border-zinc-200 dark:bg-zinc-200 dark:text-zinc-900'
      : 'border-zinc-400 dark:border-zinc-600',
  ].join(' ');
