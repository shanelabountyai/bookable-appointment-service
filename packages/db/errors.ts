/**
 * Detecting the no-overlap violation through Prisma (A-003; consumed by A-009).
 *
 * VERIFIED against Prisma 6.19 + PG17, because the spec flagged this as
 * unverified and guessing it wrong is expensive:
 *
 *   class : PrismaClientUnknownRequestError   (NOT PrismaClientKnownRequestError)
 *   code  : undefined                         (NOT 'P2002' — there is no code at all)
 *   meta  : null
 *   message contains '23P01'
 *
 * So there is nothing structured to match on: the SQLSTATE only survives inside
 * the message string. Anyone reaching for `e.code === 'P2002'` — the reflex,
 * because that is how unique violations surface — gets `undefined`, falls
 * through to the generic handler, and the PRD's "clear *slot taken* error with
 * refreshed alternatives" becomes a 500 while the race test still passes.
 *
 * A-009 maps this to the domain error `SlotTaken` -> HTTP 409. This module only
 * answers "was that the exclusion constraint?".
 */

/** SQLSTATE 23P01, exclusion_violation. Not 23505. */
export const EXCLUSION_VIOLATION = '23P01';

/** True when the error is our no-overlap constraint refusing the write.
 *  Checks the constraint name too, so a future second exclusion constraint
 *  cannot be silently misread as a slot collision. */
export function isSlotTakenError(error: unknown): boolean {
  const message =
    typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : '';
  return message.includes(EXCLUSION_VIOLATION) && message.includes('appointment_no_overlap');
}
