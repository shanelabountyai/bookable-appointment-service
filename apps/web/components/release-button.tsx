'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { type DetailState, releaseTime } from '@/lib/appointments/actions';

const INITIAL: DetailState = {};

/**
 * A-102 — "NOBODY CAME; PUT THE REST OF THE TIME BACK", AS ONE TAP, ON EVERY
 * SCREEN THAT CAN SEE THE NO-SHOW.
 *
 * A-069 built the release and put it on `/staff/appointments/[id]` alone,
 * inside a panel with a reason box and two paragraphs of explanation. That is
 * the right shape on the detail screen and the wrong one everywhere else, so
 * this is the same action with the same wording and nothing around it: the
 * stylist's own list taps it while she is walking to the backwash, and
 * `/staff/opened` taps it while the desk is already deciding what to sell.
 *
 * NO REASON BOX HERE, deliberately. `releaseTime` takes the reason as
 * optional and the detail panel is where it gets typed; a field on a list row
 * is a field nobody fills in, and demanding one would put a keyboard between
 * the desk and the thing this item exists to make instant.
 *
 * THE MINUTES ARE THE CALLER'S, because only the caller knows how much room it
 * has for them — and they are advisory in both: the server derives the span
 * again from real rows and its own clock, and says what it actually freed.
 */
export function ReleaseButton({
  appointmentId,
  label,
  size = 'md',
  className = '',
}: {
  appointmentId: string;
  label: string;
  size?: 'md' | 'compact';
  className?: string;
}) {
  const [state, action, pending] = useActionState(releaseTime, INITIAL);

  return (
    <form action={action} className={`flex flex-wrap items-center gap-2 ${className}`}>
      <input type="hidden" name="appointmentId" value={appointmentId} />
      {/* A refusal REPLACES the button, the same reflex as the day chip's
          status controls: pressing again cannot help, because either somebody
          else released it or her time ran out while the screen was open. */}
      {state.ok === false ? null : (
        <Button type="submit" size={size} pending={pending}>
          {pending ? 'Putting it back…' : label}
        </Button>
      )}
      <p aria-live="polite" className={state.message ? 'text-caption text-ink-secondary' : 'sr-only'}>
        {state.message ?? ''}
      </p>
    </form>
  );
}
