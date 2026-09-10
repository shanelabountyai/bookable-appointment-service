/**
 * The engine's exclusion reasons, in the salon's words — ONE list, for every
 * staff surface that shows one.
 *
 * It lived inside the booking panel until A-033 needed the same sentences for
 * the move panel. Copying it would have been the "a status enum is never one
 * edit" trap wearing different clothes: A-032 added `no-resource-free` to one
 * map, and a second copy would have shipped a raw identifier on the other
 * screen with nothing failing.
 *
 * STAFF ONLY. These reasons are never rendered on a public surface —
 * `overlaps-booking` tells an anonymous visitor exactly when a provider is
 * with a client (spec §1.3), which is why `explain` is withheld from public
 * queries in the first place.
 */
const REASONS: Record<string, string> = {
  'outside-working-window': 'outside their working hours',
  'inside-break': 'during their break',
  'crosses-window-close': 'it would run past closing',
  'overlaps-booking': 'they already have a client then',
  'overlaps-buffer': 'it runs into another appointment’s buffer',
  'overlaps-time-off': 'they are on time off',
  'overlaps-block': 'that time is blocked out',
  'provider-running-late': 'they are running behind then',
  'no-resource-free': 'every chair is taken then — they are free, the room is not',
  'in-the-past': 'that time has passed',
  'inside-lead-time': 'inside the booking lead time',
  'nonexistent-local-time': 'that clock time does not exist that day',
  'ambiguous-suppressed': 'that clock time happens twice that day',
  'not-on-a-whole-minute': 'that is not a whole minute',
};

/** Falls through readable rather than as a raw identifier, so a reason added
 *  to the engine without a sentence here degrades to "overlaps booking" rather
 *  than to something nobody can act on. */
export function readableReason(reason: string): string {
  return REASONS[reason] ?? reason.replace(/-/g, ' ');
}
