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

/**
 * True when a plain `@unique` column refused a duplicate write (Prisma P2002).
 *
 * Unlike the exclusion constraint above, this one DOES surface through
 * Prisma's known-error mapping — verified: `PrismaClientKnownRequestError`,
 * `code: 'P2002'`, `meta.target` naming the field. Confirmed against
 * NotificationOutbox.dedupeKey specifically, since A-004 is its first caller.
 *
 * Pass `target` to scope the check to one field (e.g. `'dedupeKey'`) when a
 * model has more than one unique constraint and "which one fired" matters —
 * omit it to match any P2002.
 *
 * Not typed against Prisma's error class via `instanceof`: importing
 * `Prisma.PrismaClientKnownRequestError` for that pulls the generated
 * client's runtime into every module that wants to catch a duplicate. The
 * error code is Prisma's stable public contract; the class identity is not
 * worth the import.
 */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  if (!target) return true;
  const meta = (error as { meta?: { target?: unknown } }).meta;
  return Array.isArray(meta?.target) && meta.target.includes(target);
}
