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

/** The constraint whose violation means "somebody just took that slot".
 *  A-030/D-29 moved it from `Appointment` to `AppointmentBlock` — the unit is
 *  now the worked span, not the whole appointment, so a colour's developing
 *  time stops being defended as if the provider were in the chair. The
 *  violation still surfaces on the appointment's own INSERT/UPDATE, because
 *  the blocks are written by an AFTER trigger inside that statement. */
const NO_OVERLAP_CONSTRAINT = 'appointment_block_no_overlap';

/** RES-03/D-30. Losing the race for the last free chair is "somebody just took
 *  it" in exactly the sense the provider axis means it, so it maps to the same
 *  outcome — the chooser in `resources.ts` picks, this constraint decides. */
const NO_RESOURCE_OVERLAP_CONSTRAINT = 'appointment_resource_no_overlap';

/**
 * True when the error is our no-overlap constraint refusing the write.
 *
 * TWO DRIVERS, TWO ERROR SHAPES, and the difference is not cosmetic:
 *
 *   node-postgres : `code` is '23P01' and `constraint` names it. The MESSAGE
 *                   does NOT contain the SQLSTATE at all.
 *   Prisma        : no `code` (it is a PrismaClientUnknownRequestError — see
 *                   the note above), and the SQLSTATE survives only inside
 *                   the message string.
 *
 * Checking the message alone — which this did until the Milestone 1 operator
 * review — therefore worked through Prisma and silently returned FALSE for a
 * raw `pg` error. That was invisible because A-003's test exercised only the
 * Prisma path. A-018/A-019's deferred multi-row transactions are the first
 * callers likely to hold a driver-level error, and there the miss would turn
 * a "that slot is taken" 409 into a 500.
 *
 * The constraint name is required either way, so an exclusion constraint that
 * is NOT one of ours cannot be misread as a slot collision. Both of ours count:
 * losing the race for the last free chair (D-30) is "somebody just took it" in
 * exactly the sense the provider axis means it (RES-03).
 */
export function isSlotTakenError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown };

  const OURS = [NO_OVERLAP_CONSTRAINT, NO_RESOURCE_OVERLAP_CONSTRAINT];

  // Structured form (node-postgres, and any driver that sets SQLSTATE).
  if (e.code === EXCLUSION_VIOLATION) {
    return e.constraint === undefined || OURS.includes(e.constraint as string);
  }

  // String form (Prisma). Both parts required.
  const message = typeof e.message === 'string' ? e.message : '';
  return message.includes(EXCLUSION_VIOLATION) && OURS.some((name) => message.includes(name));
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
