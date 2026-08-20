/**
 * THE BOOKING WRITE PATH (A-009; BOOK-02, BOOK-03, BOOK-06; D-2).
 *
 * STAFF-SHAPED FROM DAY ONE (operator S-3). The signature takes a nullable
 * client, an actor, an override flag and no horizon cap; self-serve is the
 * RESTRICTED caller that passes `audience: 'public'`, not the other way round.
 * Seven of ten bookings in a real salon are staff-made, and shaping this
 * around the customer flow first would mean reopening it — along with the
 * manage token, the outbox enqueue and the race tests — at A-017.
 *
 * WHAT DEFENDS CORRECTNESS, in order:
 *
 *  1. The exclusion constraint (D-2). Absolute, enforced by Postgres against
 *     every path including psql. It is what makes READ COMMITTED sufficient
 *     and why there is no retry loop here.
 *  2. A transaction-scoped advisory lock on (provider, business day) — D-24.
 *     NOT a substitute for the constraint. It exists because a staff override
 *     stores a ZERO-WIDTH range (D-8), so the constraint deliberately does not
 *     defend overridden time, and only the in-transaction engine re-check
 *     does. Without serialization, a self-serve booking racing a staff
 *     override both pass their re-checks and both commit — the accidental
 *     double-book Goal 2 forbids. The lock is per provider-day, so it costs
 *     nothing at salon scale.
 *  3. The engine re-run inside the transaction. Catches everything that is not
 *     an overlap: closed day, break, lead time, horizon.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../core/auth';
import { type Slot, type VisitLine, composeVisit, computeSlots } from '../../core/scheduling';
import { type ZoneId, fromDate, instant, toDate, toLabel } from '../../core/time';
import { effectivePriceCents, effectiveDurationMinutes, visitPattern } from '../../core/settings';
import { issueManageToken } from '../appointments';
import { type ClientReliability, reliabilityFor } from '../clients';
import { enqueueNotification } from '../notifications';
import { buildSlotQuery } from '../scheduling';
import { isSlotTakenError } from '../errors';
import type { Prisma, PrismaClient } from '../generated/client/index.js';
import { BookingRejected, NoResourceFree, SelfServeBlocked, SlotNotOffered, SlotTaken } from './errors';
import { findFreeResource, requiredResourceTypeId, resourceTypeName } from './resources';

const MIN = 60_000;

export interface BookAppointmentInput {
  businessId: string;
  providerId: string;
  /** The services in this visit, IN ORDER (VISIT-01, D-23). One entry is the
   *  ordinary case. Order matters: buffers come from the ends. */
  serviceIds: readonly string[];
  /** NULLABLE — BOOK-04's "walk-in, no name". Identity attaches later. */
  clientId?: string | null;
  /** The slot's identity is its INSTANT (D-4). No `{date, time}` pair ever
   *  reaches here: on fall-back day "01:30" names two instants. */
  startAt: Date;
  /**
   * INJECTED, never read from the clock here.
   *
   * The engine already refuses to read the clock (CLAUDE.md); a write path
   * that reads it instead is the same defect one layer out — it cannot be
   * tested against a fixed booking date without waiting for that date to
   * arrive. Composition roots pass `new Date()`.
   */
  now: Date;
  actor: Actor;
  /** Makes the write safely retryable (BOOK-03f). */
  idempotencyKey?: string | null;
  /** BOOK-05. Staff only, reason required. Customers NEVER override. */
  isOverride?: boolean;
  overrideReason?: string | null;
  /** Defaults to the RESTRICTED value, so a route that forgets gets the
   *  customer's rules. */
  audience?: 'public' | 'staff';
  notes?: string | null;
  /**
   * TEST SEAM. Skips D-24's advisory lock so the EXCLUSION CONSTRAINT's own
   * defence — and the 23P01 -> SlotTaken mapping below — can be exercised.
   *
   * With the lock in place the loser of a race is refused by the engine
   * re-check and never reaches the constraint, which makes that mapping
   * unreachable and therefore untestable through this function. BOOK-02
   * requires a test that provokes a real 23P01 and asserts the mapping, so
   * the seam exists to make defence-in-depth code reachable rather than
   * merely asserted. Deliberately ugly: production never sets it.
   */
  __unsafeSkipSerialization?: boolean;
}

export interface BookedAppointment {
  id: string;
  startAt: Date;
  endAt: Date;
  status: string;
  isOverride: boolean;
  /** True when an existing appointment was returned unchanged for a repeated
   *  idempotency key, rather than a new one being created. */
  deduplicated: boolean;
}

export async function bookAppointment(
  prisma: PrismaClient,
  input: BookAppointmentInput,
): Promise<BookedAppointment> {
  const audience = input.audience ?? 'public';
  const isOverride = input.isOverride ?? false;

  if (isOverride && audience !== 'staff') {
    // D-8: "customer self-serve can never create a conflict". Not a 409 —
    // a customer reaching this is a bug or an attack, not a lost race.
    throw new BookingRejected('isOverride', 'Only staff can override.');
  }
  if (isOverride && !input.overrideReason?.trim()) {
    // BOOK-05: every override needs a reason. An override marker nobody can
    // explain is one staff learn to ignore.
    throw new BookingRejected('overrideReason', 'An override needs a reason.');
  }
  if (fromDate(input.startAt) % MIN !== 0) {
    // The whole-minute CHECK would refuse this anyway; failing here names the
    // field instead of surfacing a constraint violation.
    throw new BookingRejected('startAt', 'A booking must start on a whole minute.');
  }

  // Idempotency BEFORE the transaction: a retry of a request that already
  // succeeded must not take a lock or re-run the engine (BOOK-03f).
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(prisma, input.businessId, input.idempotencyKey);
    if (existing) return { ...existing, deduplicated: true };
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const { timezone } = await tx.business.findUniqueOrThrow({
          where: { id: input.businessId },
          select: { timezone: true },
        });
        const businessDay = businessDayOf(input.startAt, timezone);

        // CLIENT-04, before anything is locked or computed: whether this
        // client may book HERSELF is not a scheduling question, and finding
        // out after the engine has run would mean holding the provider-day
        // lock to answer it.
        //
        // Counted against the salon's TODAY, not the appointment's day: the
        // rolling window is "the last 12 months" from now, and a booking made
        // today for March must be judged by what her record says today.
        const reliability = input.clientId
          ? await reliabilityFor(tx, {
              businessId: input.businessId,
              clientId: input.clientId,
              today: businessDayOf(input.now, timezone),
            })
          : null;

        if (audience === 'public' && reliability?.selfServeBlocked) {
          throw new SelfServeBlocked(reliability.noShows, reliability.threshold);
        }

        // Before the engine re-check, so the read and the write are one
        // serialized unit for this provider-day (D-24).
        if (!input.__unsafeSkipSerialization) {
          await lockProviderDay(tx, input.providerId, businessDay);
        }

        const { query } = await buildSlotQuery(tx, {
          businessId: input.businessId,
          providerId: input.providerId,
          serviceIds: input.serviceIds,
          day: businessDay,
          now: input.now,
          audience,
        });

        const result = computeSlots({ ...query, explain: true });
        const offered = result.slots.find((s) => s.start === fromDate(input.startAt));

        if (!offered && !isOverride) {
          const excluded = result.excluded.find((e) => e.candidateStart === fromDate(input.startAt));
          const reasons = excluded?.reasons ?? [];
          // WHY THIS SPLIT MATTERS. D-24's advisory lock serializes bookings
          // for a provider-day, so the loser of a race no longer reaches the
          // exclusion constraint at all — it re-runs the engine against the
          // winner's committed row and finds the time occupied. That is
          // "somebody just took it" (SlotTaken -> 409 with alternatives), NOT
          // "this was never on offer" (SlotNotOffered). Reporting a lost race
          // as "outside working hours" would be actively misleading.
          //
          // The 23P01 -> SlotTaken mapping below still exists and is still
          // tested: it defends every path that does NOT take the lock.
          const occupied =
            reasons.includes('overlaps-booking') ||
            reasons.includes('overlaps-buffer') ||
            reasons.includes('overlaps-time-off') ||
            reasons.includes('overlaps-block');
          if (occupied) throw new SlotTaken([...result.slots]);
          // A-032, RES-03. The room is full and the STYLIST IS FREE, which is
          // neither of the two answers above: nobody took this slot, and it
          // was genuinely on offer. Its own error because its own answer —
          // staff get RES-04's override, the customer gets another time with
          // the same stylist. `findFreeResource` throws the identical error
          // further down when a concurrent booking takes the last chair
          // between this check and the write; the engine catching it here is
          // what stops the screen offering a time it will then refuse.
          if (reasons.includes('no-resource-free')) {
            throw new NoResourceFree(await resourceTypeName(tx, input.serviceIds));
          }
          throw new SlotNotOffered(reasons, [...result.slots]);
        }

        return writeAppointment(tx, input, offered, audience, isOverride, reliability);
      },
      // Above Prisma's 5s default: a booking waits behind the advisory lock
      // for anyone already booking that provider-day, and that queue time
      // counts against the interactive-transaction timeout. A timeout here
      // surfaces as P2028, which looks nothing like a conflict.
      { timeout: 15_000 },
    );
  } catch (error) {
    if (isSlotTakenError(error)) {
      // The constraint refused it — somebody committed between our re-check
      // and our write. Recompute alternatives from the state that caused the
      // failure, not the stale list the customer was looking at.
      throw new SlotTaken(await freshAlternatives(prisma, input, audience));
    }
    throw error;
  }
}

// ─────────────────────────── internals ───────────────────────────

/** The business-calendar day an instant falls on. Goes through the ONE
 *  conversion module (D-3) — nothing here parses a date, and the zone is the
 *  business's own, never the server's. */
function businessDayOf(at: Date, zone: string): string {
  return toLabel(fromDate(at), zone as ZoneId).day;
}

/**
 * Serializes bookings for one provider on one business day (D-24).
 *
 * `pg_advisory_xact_lock` takes a lock on a KEY rather than a row, so it works
 * before the row exists — `SELECT ... FOR UPDATE` cannot, because the first
 * booker of a slot finds nothing to lock. Transaction-scoped (`_xact_`) so it
 * is released at COMMIT or ROLLBACK with no cleanup path to forget, and no
 * risk of leaking into whichever request gets the pooled connection next.
 *
 * hashtext collisions merely serialize two unrelated provider-days for a
 * moment, which costs nothing and can never let an extra booking through.
 */
async function lockProviderDay(
  tx: Prisma.TransactionClient,
  providerId: string,
  businessDay: string,
): Promise<void> {
  // Keyed on the BUSINESS day, not a UTC day bucket. Bucketing by
  // `floor(epochMs / 86_400_000)` is an axis crossing: in America/Chicago a
  // 6pm and an 8pm booking on the same evening fall either side of UTC
  // midnight, land in different buckets, and are never serialized against
  // each other — which is precisely the case this lock exists for. Found by
  // mutation-testing this file.
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `${providerId}:${businessDay}`);
}

async function findByIdempotencyKey(
  db: Prisma.TransactionClient | PrismaClient,
  businessId: string,
  idempotencyKey: string,
) {
  const row = await db.appointment.findFirst({
    where: { businessId, idempotencyKey },
    select: { id: true, startAt: true, endAt: true, status: true, isOverride: true },
  });
  return row ?? null;
}

async function writeAppointment(
  tx: Prisma.TransactionClient,
  input: BookAppointmentInput,
  offered: Slot | undefined,
  audience: 'public' | 'staff',
  isOverride: boolean,
  reliability: ClientReliability | null,
): Promise<BookedAppointment> {
  // Loaded in the CALLER's order, not the database's — the buffers come from
  // the ends, so reordering the lines would change the appointment.
  const found = await tx.serviceProvider.findMany({
    where: { providerId: input.providerId, serviceId: { in: [...input.serviceIds] } },
    include: {
      service: {
        include: {
          // D-29's snapshot is taken from these, here, once — never read live
          // at render or at check time.
          segments: { where: { status: 'active' }, orderBy: { ordinal: 'asc' } },
        },
      },
    },
  });
  const byService = new Map(found.map((row) => [row.serviceId, row]));
  const links = input.serviceIds.map((serviceId) => {
    const row = byService.get(serviceId);
    if (!row) throw new BookingRejected('serviceIds', `Provider is not qualified for service ${serviceId}.`);
    return row;
  });

  const lines: VisitLine[] = links.map((row) => ({
    serviceId: row.serviceId,
    durationMinutes: effectiveDurationMinutes(row.service.durationMinutes, row.durationOverrideMinutes),
    bufferBeforeMinutes: row.service.bufferBeforeMinutes,
    bufferAfterMinutes: row.service.bufferAfterMinutes,
    priceCents: effectivePriceCents(row.service.priceCents, row.priceOverrideCents),
  }));
  const visit = composeVisit(lines);
  const endAt = toDate(instant(fromDate(input.startAt) + visit.durationMinutes * MIN));

  // D-29 — the shape the block trigger will cut this appointment into, frozen
  // at booking time for the same reason the buffers and the price are (D-18).
  // Empty for every unsegmented visit, which is the common case and the reason
  // this changed nothing for existing bookings.
  const segmentPattern = visitPattern(
    links.map((row, i) => ({
      durationMinutes: lines[i]!.durationMinutes,
      serviceDurationMinutes: row.service.durationMinutes,
      segments: row.service.segments,
    })),
  );

  const business = await tx.business.findUniqueOrThrow({
    where: { id: input.businessId },
    select: { timezone: true },
  });
  const label = toLabel(fromDate(input.startAt), business.timezone as ZoneId);

  // RES-01..04 — the chair, chosen here and never by a human. A staff override
  // holds NO chair, deliberately: the same reasoning as D-8's zero-width
  // provider range, since the constraint must never be what refuses staff a
  // knowing decision. The desk is standing in the room and can see it.
  let resourceId: string | null = null;
  const resourceTypeId = isOverride ? null : await requiredResourceTypeId(tx, input.serviceIds);
  if (resourceTypeId) {
    const blockedStart = toDate(instant(fromDate(input.startAt) - visit.bufferBeforeMinutes * MIN));
    const blockedEnd = toDate(instant(fromDate(endAt) + visit.bufferAfterMinutes * MIN));
    resourceId = await findFreeResource(tx, {
      businessId: input.businessId,
      resourceTypeId,
      start: blockedStart,
      end: blockedEnd,
    });
    if (!resourceId) throw new NoResourceFree(await resourceTypeName(tx, input.serviceIds));
  }

  const appointment = await tx.appointment.create({
    data: {
      resourceId,
      businessId: input.businessId,
      providerId: input.providerId,
      clientId: input.clientId ?? null,
      startAt: input.startAt,
      endAt,
      // Snapshotted onto the appointment so the blocked-range trigger can
      // recompute on UPDATE without re-deriving which buffers applied.
      // The VISIT's buffers, not any single line's: inner buffers do not
      // stack, because the client never leaves the chair between services.
      segmentPattern,
      bufferBeforeMinutes: visit.bufferBeforeMinutes,
      bufferAfterMinutes: visit.bufferAfterMinutes,
      isOverride,
      overrideReason: isOverride ? (input.overrideReason ?? null) : null,
      idempotencyKey: input.idempotencyKey ?? null,
      // P1-6: denormalized business-date grouping for RPT-02 and the day view,
      // written by the same code that writes the instants.
      startDay: label.day,
      startWallTime: label.time,
      notes: input.notes ?? null,
      // blockedStart/blockedEnd are TRIGGER-written (A-003); the values here
      // are placeholders the trigger overwrites before the row is visible.
      blockedStart: input.startAt,
      blockedEnd: endAt,
      lines: {
        // One ordered line per service, EACH snapshotting its own price and
        // duration (D-18): a January price rise must not rewrite last year's
        // history, and a per-visit total would lose which service cost what.
        create: lines.map((line, ordinal) => ({
          businessId: input.businessId,
          serviceId: line.serviceId,
          ordinal,
          priceCents: line.priceCents,
          durationMinutes: line.durationMinutes,
        })),
      },
      events: {
        create: {
          businessId: input.businessId,
          type: isOverride ? 'override_booked' : 'booked',
          actor: input.actor.type,
          actorRef: input.actor.ref,
          reason: isOverride ? (input.overrideReason ?? null) : null,
          payload: {
            audience,
            startAt: input.startAt.toISOString(),
            offered: offered !== undefined,
            // D-27: the front desk may always book her, and the fact that
            // they did it over a flag is ON THE RECORD rather than costing
            // them a typed reason. Written only when the flag was actually
            // showing, so the owner's report can find these bookings and the
            // ordinary ones carry nothing extra.
            ...(reliability?.selfServeBlocked
              ? { overNoShowFlag: { noShows: reliability.noShows, threshold: reliability.threshold } }
              : {}),
          },
        },
      },
    },
    select: { id: true, startAt: true, endAt: true, status: true, isOverride: true },
  });

  // BOOK-06 — enqueued INSIDE the transaction (D-14's whole design): a booking
  // must never commit without its confirmation, nor a confirmation without its
  // booking. The manage token is minted in the same breath and for the same
  // reason: a confirmation whose link does not work is worse than no link.
  const client = input.clientId
    ? await tx.client.findUnique({ where: { id: input.clientId }, select: { email: true, phone: true } })
    : null;

  const { token } = await issueManageToken(tx, {
    businessId: input.businessId,
    appointmentId: appointment.id,
    endAt: appointment.endAt,
    now: input.now,
  });

  await enqueueNotification(tx, {
    businessId: input.businessId,
    // Derived from the FACT, not the attempt: a retry must collapse onto the
    // same row (P1-7's shape).
    dedupeKey: `confirmation:${appointment.id}`,
    // The FK, not just the id inside the payload — see EnqueueInput.
    appointmentId: appointment.id,
    channel: client?.email ? 'email' : 'sms',
    template: 'appointment.confirmed',
    // Absent for a walk-in with no record — enqueue records it suppressed
    // rather than throwing, so a booking never fails for want of a phone
    // number (P2-4).
    recipient: client?.email ?? client?.phone ?? null,
    payload: {
      appointmentId: appointment.id,
      startAt: appointment.startAt.toISOString(),
      // The RAW token, which exists only here and in the message. Nothing
      // reads it back out of the outbox to act on — the row is the record of
      // what was sent (operator R-4), so the link in it has to be the real one.
      manageUrl: `/manage/${token}`,
    },
  });

  return { ...appointment, deduplicated: false };
}

async function freshAlternatives(
  prisma: PrismaClient,
  input: BookAppointmentInput,
  audience: 'public' | 'staff',
): Promise<Slot[]> {
  try {
    const business = await prisma.business.findUniqueOrThrow({
      where: { id: input.businessId },
      select: { timezone: true },
    });
    const { query } = await buildSlotQuery(prisma, {
      businessId: input.businessId,
      providerId: input.providerId,
      serviceIds: input.serviceIds,
      day: businessDayOf(input.startAt, business.timezone),
      now: input.now,
      audience,
    });
    return [...computeSlots(query).slots];
  } catch {
    // Never let the alternatives lookup turn a clean 409 into a 500.
    return [];
  }
}

export { randomUUID as newIdempotencyKey };
