/**
 * Detecting the no-overlap violation through Prisma (A-003; consumed by A-009).
 *
 * THREE SHAPES, VERIFIED against Prisma 6.19 + PG17 + node-postgres, because
 * the spec flagged this as unverified and guessing it wrong is expensive:
 *
 *   node-postgres        `code` is '23P01' and `constraint` names it. The
 *                        MESSAGE does not contain the SQLSTATE at all.
 *   Prisma, IMMEDIATE    PrismaClientKnownRequestError, `code: 'P2010'` (the
 *                        raw-query wrapper, NOT 'P2002'), `constraint`
 *                        undefined; '23P01' and the name survive only inside
 *                        the message.
 *   Prisma, DEFERRED     PrismaClientUnknownRequestError, NO `code` at all,
 *                        and — the part A-078 found — NO SQLSTATE ANYWHERE.
 *                        The message is `Error in connector: Error querying
 *                        the database: ERROR: conflicting key value violates
 *                        exclusion constraint "<name>"`. A COMMIT-time
 *                        violation loses the code on its way through the
 *                        connector, so the only evidence left is the NAME.
 *
 * That third shape is why the check below matches the constraint name ALONE
 * rather than requiring '23P01' beside it. `push-column.ts` is the one caller
 * that defers, its catch had never once fired, and A-034's mapping had
 * therefore never worked: the desk met a raw connector error in the middle of
 * a workflow whose entire point is being told what happened.
 *
 * A name of ours is sufficient evidence on its own — `OUR_EXCLUSION_CONSTRAINTS`
 * is exhaustive and every member is an overlap refusal. Anyone reaching for
 * `e.code === 'P2002'` — the reflex, because that is how unique violations
 * surface — gets `undefined`, falls through to the generic handler, and the
 * PRD's "clear *slot taken* error with refreshed alternatives" becomes a 500
 * while the race test still passes.
 *
 * A-009 maps this to the domain error `SlotTaken` -> HTTP 409. This module only
 * answers "was that the exclusion constraint?".
 */

/** SQLSTATE 23P01, exclusion_violation. Not 23505. */
export const EXCLUSION_VIOLATION = '23P01';

/**
 * EVERY exclusion constraint of ours, in ONE list — the module that owns the
 * mapping owns the names, and nothing else keeps a second copy.
 *
 * A CONSTRAINT IS NEVER ONE EDIT (CLAUDE.md). This started as two consts read
 * by one `OURS` array inside the function below. A-063 then added a third
 * constraint to the database and told the migration, the two triggers and the
 * push's deferral list — but not this file. Nine items shipped with the mapper
 * knowing two of three names, so D-45's promise that "the desk is told IN
 * WORDS" reached the desk as a `PrismaClientUnknownRequestError` instead. The
 * guard against a fourth doing the same is `constraint.test.ts`, which asserts
 * this list equals the exclusion constraints `pg_constraint` actually holds —
 * the same shape as the status-predicate test, and for the same reason.
 *
 * Members:
 *   appointment_block_no_overlap         D-2/D-29 — the provider's worked span.
 *                                        A-030 moved it from `Appointment` to
 *                                        `AppointmentBlock`, so a colour's
 *                                        developing time stops being defended
 *                                        as if the provider were in the chair.
 *   appointment_resource_no_overlap      RES-03/D-30 — the chair ENVELOPE.
 *                                        Losing the race for the last free
 *                                        chair is "somebody just took it" in
 *                                        exactly the sense the provider axis
 *                                        means it.
 *   appointment_resource_body_no_overlap A-063 — the chair BODY. Envelopes may
 *                                        overlap for one holder; two bodies in
 *                                        one chair is two people in one seat.
 */
export const OUR_EXCLUSION_CONSTRAINTS = [
  'appointment_block_no_overlap',
  'appointment_resource_no_overlap',
  'appointment_resource_body_no_overlap',
] as const;

/**
 * True when the error is one of OUR no-overlap constraints refusing the write.
 *
 * The constraint name is required in every shape, so an exclusion constraint
 * that is NOT one of ours cannot be misread as a slot collision — with the one
 * exception of a driver-level 23P01 that names no constraint at all, where a
 * bare SQLSTATE is all there is.
 */
export function isSlotTakenError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown };

  // Structured form (node-postgres, and any driver that sets SQLSTATE).
  if (e.code === EXCLUSION_VIOLATION) {
    return (
      e.constraint === undefined ||
      OUR_EXCLUSION_CONSTRAINTS.includes(e.constraint as (typeof OUR_EXCLUSION_CONSTRAINTS)[number])
    );
  }

  // String form (both Prisma shapes). The NAME alone, deliberately: the
  // deferred shape carries no SQLSTATE, and requiring one is what kept the
  // push's catch dark. See the shapes table at the top of this file.
  const message = typeof e.message === 'string' ? e.message : '';
  return OUR_EXCLUSION_CONSTRAINTS.some((name) => message.includes(name));
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
