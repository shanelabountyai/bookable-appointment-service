/**
 * Availability reads and writes (A-007, AVAIL-01..04).
 *
 * `packages/core/availability` owns the precedence chain; this file loads the
 * rows it operates on and writes new ones. The split is the same one used
 * everywhere else here: the rules have unit tests with no database, the
 * storage has integration tests with no rules.
 */
import {
  type DayPattern,
  InvalidAvailability,
  type MinuteWindow,
  resolveAvailableWindows,
  toMinuteWindow,
  toWindowInput,
} from '../../core/availability';
import type { Actor } from '../../core/auth';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** Who is making this change (D-9, operator R-8). Every write here takes one:
 *  an availability edit with no actor is the audit gap R-8 is about. */
export interface ActorStamp {
  createdByActor: Actor['type'];
  actorRef: string | null;
}

// ─────────────────────────── reading ───────────────────────────

export interface ResolvedDay {
  /** Wall-clock windows the provider is actually available, business hours
   *  already intersected in. Ready for A-026 to resolve to instants. */
  windows: Required<{ open: string; close: string; endsNextDay: boolean; breaks: { open: string; close: string }[] }>[];
  /** True when nothing is available — a closed day, a holiday, or a
   *  non-overlapping pair. Distinct from "windows we could not load". */
  closed: boolean;
}

/**
 * The wall-clock half of the chain for one provider on one calendar day.
 *
 * Takes `day` as a CalendarDay string and `weekday` as an explicit number
 * rather than deriving the weekday itself: deriving it would mean parsing a
 * date, which is an axis crossing this module is not allowed to make (D-3).
 * The caller — which already holds a zone — passes it in.
 */
export async function resolveDayWindows(
  db: Db,
  args: { businessId: string; providerId: string; day: string; weekday: number },
): Promise<ResolvedDay> {
  const [businessPattern, providerPattern] = await Promise.all([
    loadPattern(db, { businessId: args.businessId, providerId: null, day: args.day, weekday: args.weekday }),
    loadPattern(db, { businessId: args.businessId, providerId: args.providerId, day: args.day, weekday: args.weekday }),
  ]);

  const windows = resolveAvailableWindows(businessPattern, providerPattern);
  return { windows: windows.map(toWindowInput), closed: windows.length === 0 };
}

async function loadPattern(
  db: Db,
  args: { businessId: string; providerId: string | null; day: string; weekday: number },
): Promise<DayPattern> {
  const [weeklyRows, overrideRow] = await Promise.all([
    db.weeklyWindow.findMany({
      where: { businessId: args.businessId, providerId: args.providerId, weekday: args.weekday },
      include: { breaks: true },
    }),
    db.dateOverride.findFirst({
      where: { businessId: args.businessId, providerId: args.providerId, day: args.day },
      include: { windows: true },
    }),
  ]);

  const weekly = weeklyRows.map((w) =>
    toMinuteWindow({
      open: w.open.trim(),
      close: w.close.trim(),
      endsNextDay: w.endsNextDay,
      breaks: w.breaks.map((b) => ({ open: b.open.trim(), close: b.close.trim() })),
    }),
  );

  // null override and an isClosed override are DIFFERENT days (AVAIL-02), so
  // this preserves the distinction rather than collapsing both to "no windows".
  const override = overrideRow
    ? {
        isClosed: overrideRow.isClosed,
        windows: overrideRow.windows.map((w) =>
          toMinuteWindow({ open: w.open.trim(), close: w.close.trim(), endsNextDay: w.endsNextDay }),
        ) as readonly MinuteWindow[],
      }
    : null;

  return { weekly, override };
}

/**
 * Time off and ad-hoc blocks overlapping an instant range (AVAIL-03).
 *
 * An INSTANT-overlap predicate, never `WHERE date(startAt) = day`: a block
 * running 23:30–00:30 belongs to both days, and a date filter would drop it
 * from one of them and leave that half bookable.
 */
export async function findAbsences(
  db: Db,
  args: { providerId: string; windowStart: Date; windowEnd: Date },
): Promise<{ id: string; start: Date; end: Date; kind: 'time_off' | 'ad_hoc_block'; reason: string | null }[]> {
  const where = {
    providerId: args.providerId,
    startAt: { lt: args.windowEnd },
    endAt: { gt: args.windowStart },
  };
  const [timeOff, blocks] = await Promise.all([
    db.timeOff.findMany({ where, select: { id: true, startAt: true, endAt: true, reason: true } }),
    db.adHocBlock.findMany({ where, select: { id: true, startAt: true, endAt: true, reason: true } }),
  ]);
  return [
    ...timeOff.map((t) => ({ id: t.id, start: t.startAt, end: t.endAt, kind: 'time_off' as const, reason: t.reason })),
    ...blocks.map((b) => ({ id: b.id, start: b.startAt, end: b.endAt, kind: 'ad_hoc_block' as const, reason: b.reason })),
  ];
}

// ─────────────────────────── writing ───────────────────────────

export interface WeeklyWindowInput {
  businessId: string;
  /** null = a BUSINESS-level window (AVAIL-04's business hours). */
  providerId: string | null;
  weekday: number;
  open: string;
  close: string;
  endsNextDay: boolean;
  breaks?: { open: string; close: string }[];
}

/**
 * Writes one weekly window and its breaks, validating through the same pure
 * rules the engine's view of the day is built from — so a window that could
 * never resolve cannot be stored in the first place (AVAIL-01).
 */
export async function createWeeklyWindow(db: Db, input: WeeklyWindowInput, actor: ActorStamp) {
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    throw new InvalidAvailability('weekday', 'Weekday must be 0 (Sunday) through 6 (Saturday).');
  }
  // Throws InvalidAvailability for close<=open, a bad overnight flag, or a
  // break outside its window — before anything is written.
  // `breaks: input.breaks` would pass an explicit `undefined`, which
  // exactOptionalPropertyTypes correctly rejects as different from omitting it.
  toMinuteWindow({
    open: input.open,
    close: input.close,
    endsNextDay: input.endsNextDay,
    breaks: input.breaks ?? [],
  });

  return db.weeklyWindow.create({
    data: {
      businessId: input.businessId,
      providerId: input.providerId,
      weekday: input.weekday,
      open: input.open,
      close: input.close,
      endsNextDay: input.endsNextDay,
      createdByActor: actor.createdByActor,
      actorRef: actor.actorRef,
      breaks: {
        create: (input.breaks ?? []).map((b) => ({
          businessId: input.businessId,
          open: b.open,
          close: b.close,
        })),
      },
    },
    include: { breaks: true },
  });
}

/**
 * A-047. Scoped to the BUSINESS, not just to the id.
 *
 * The id arrives from a form field, which makes it ordinary untrusted input:
 * `delete({ where: { id } })` deletes whatever that id names, including
 * another tenant's Thursday. `deleteMany` with both keys is the whole fix —
 * it deletes nothing when the row is not this business's, rather than
 * throwing, which is the right answer for a button clicked twice.
 */
export async function deleteWeeklyWindow(db: Db, args: { businessId: string; id: string }): Promise<void> {
  await db.weeklyWindow.deleteMany({ where: { id: args.id, businessId: args.businessId } });
}

export interface DateOverrideInput {
  businessId: string;
  providerId: string | null;
  day: string;
  isClosed: boolean;
  reason?: string | null;
  windows?: { open: string; close: string; endsNextDay: boolean }[];
}

/**
 * Creates or replaces the override for one (business, provider, day).
 *
 * AVAIL-02 says two overrides on one date is a validation error; the schema
 * already makes that impossible with a unique index, so this UPSERTS — editing
 * a holiday should not require deleting it first, and racing two edits should
 * end with one row rather than a constraint error the staff member cannot act
 * on.
 */
export async function upsertDateOverride(db: Db, input: DateOverrideInput, actor: ActorStamp) {
  if (input.isClosed && (input.windows?.length ?? 0) > 0) {
    throw new InvalidAvailability('isClosed', 'A closed day cannot also have opening hours.');
  }
  if (!input.isClosed && (input.windows?.length ?? 0) === 0) {
    // An open override with no windows resolves to "closed" but records itself
    // as open — two states that must stay distinguishable (AVAIL-02).
    throw new InvalidAvailability('windows', 'An open override needs at least one window, or mark the day closed.');
  }
  for (const w of input.windows ?? []) toMinuteWindow(w);

  const existing = await db.dateOverride.findFirst({
    where: { businessId: input.businessId, providerId: input.providerId, day: input.day },
    select: { id: true },
  });

  if (existing) {
    // Replace the children wholesale: an override REPLACES the pattern, and a
    // half-updated set of child windows would be a pattern nobody chose.
    await db.dateOverrideWindow.deleteMany({ where: { dateOverrideId: existing.id } });
    return db.dateOverride.update({
      where: { id: existing.id },
      data: {
        isClosed: input.isClosed,
        reason: input.reason ?? null,
        createdByActor: actor.createdByActor,
        actorRef: actor.actorRef,
        windows: {
          create: (input.windows ?? []).map((w) => ({
            businessId: input.businessId,
            open: w.open,
            close: w.close,
            endsNextDay: w.endsNextDay,
          })),
        },
      },
      include: { windows: true },
    });
  }

  return db.dateOverride.create({
    data: {
      businessId: input.businessId,
      providerId: input.providerId,
      day: input.day,
      isClosed: input.isClosed,
      reason: input.reason ?? null,
      createdByActor: actor.createdByActor,
      actorRef: actor.actorRef,
      windows: {
        create: (input.windows ?? []).map((w) => ({
          businessId: input.businessId,
          open: w.open,
          close: w.close,
          endsNextDay: w.endsNextDay,
        })),
      },
    },
    include: { windows: true },
  });
}

/** Business-scoped for the same reason as `deleteWeeklyWindow`. */
export async function deleteDateOverride(db: Db, args: { businessId: string; id: string }): Promise<void> {
  await db.dateOverride.deleteMany({ where: { id: args.id, businessId: args.businessId } });
}

export interface AbsenceInput {
  businessId: string;
  providerId: string;
  startAt: Date;
  endAt: Date;
  reason?: string | null;
}

/**
 * Time off and ad-hoc blocks (AVAIL-03).
 *
 * These are INSTANT intervals and they live OUTSIDE the exclusion constraint's
 * table deliberately (D-2): blocking over an existing booking must SURFACE the
 * conflict for a human (AVAIL-05, A-019), not be refused by the database. So
 * nothing here checks for overlapping appointments — that is not an oversight,
 * it is the requirement. Recording "Dana called in sick" must always succeed,
 * even when she has nine appointments booked; what happens to those nine is a
 * decision for a person.
 */
export async function createTimeOff(db: Db, input: AbsenceInput, actor: ActorStamp) {
  assertInterval(input);
  const created = await db.timeOff.create({
    data: { ...input, reason: input.reason ?? null, createdByActor: actor.createdByActor, actorRef: actor.actorRef },
  });
  await freshenAcknowledgments(db, input);
  return created;
}

export async function createAdHocBlock(db: Db, input: AbsenceInput, actor: ActorStamp) {
  assertInterval(input);
  const created = await db.adHocBlock.create({
    data: { ...input, reason: input.reason ?? null, createdByActor: actor.createdByActor, actorRef: actor.actorRef },
  });
  await freshenAcknowledgments(db, input);
  return created;
}

/**
 * OPERATOR R-7. A "keep-flagged" acknowledgment is about ONE conflict; when
 * the absence causing it changes, that conflict is a different conflict, and
 * a stale flag hides a client behind a decision somebody made about a
 * situation that no longer exists.
 *
 * Deliberately in THIS file rather than in A-019's impact module, for two
 * reasons: every path that writes an absence gets it for free and cannot
 * forget it, and the import stays one-directional — `impact.ts` needs
 * `resolveDayWindows` from here, so anything here needing `impact.ts` would
 * be a cycle.
 */
export async function clearConflictAcknowledgments(
  db: Db,
  args: { businessId: string; providerId: string; startAt: Date; endAt: Date },
): Promise<number> {
  const cleared = await db.appointment.updateMany({
    where: {
      businessId: args.businessId,
      providerId: args.providerId,
      conflictAckAt: { not: null },
      startAt: { lt: args.endAt },
      endAt: { gt: args.startAt },
    },
    data: { conflictAckAt: null, conflictAckReason: null },
  });
  return cleared.count;
}

async function freshenAcknowledgments(db: Db, input: AbsenceInput): Promise<void> {
  await clearConflictAcknowledgments(db, {
    businessId: input.businessId,
    providerId: input.providerId,
    startAt: input.startAt,
    endAt: input.endAt,
  });
}

function assertInterval(input: AbsenceInput): void {
  if (!(input.endAt > input.startAt)) {
    throw new InvalidAvailability('endAt', 'The end of an absence must come after its start.');
  }
}

export async function deleteTimeOff(db: Db, args: { businessId: string; id: string }): Promise<void> {
  // Read before deleting: the range is what says WHICH acknowledgments were
  // about this absence. Removing an absence resolves the conflict, so the
  // acknowledgment about it is equally out of date.
  //
  // A-047 scoped both halves to the business — the read decides what gets
  // freshened, so an unscoped one would let another tenant's id clear THIS
  // business's acknowledgments even when the delete itself matched nothing.
  const row = await db.timeOff.findFirst({ where: { id: args.id, businessId: args.businessId } });
  await db.timeOff.deleteMany({ where: { id: args.id, businessId: args.businessId } });
  if (row) await freshenAcknowledgments(db, row);
}

export async function deleteAdHocBlock(db: Db, args: { businessId: string; id: string }): Promise<void> {
  const row = await db.adHocBlock.findFirst({ where: { id: args.id, businessId: args.businessId } });
  await db.adHocBlock.deleteMany({ where: { id: args.id, businessId: args.businessId } });
  if (row) await freshenAcknowledgments(db, row);
}

export async function listWeeklyWindows(db: Db, businessId: string, providerId: string | null) {
  return db.weeklyWindow.findMany({
    where: { businessId, providerId },
    orderBy: [{ weekday: 'asc' }, { open: 'asc' }],
    include: { breaks: true },
  });
}

export async function listDateOverrides(db: Db, businessId: string, providerId: string | null) {
  return db.dateOverride.findMany({
    where: { businessId, providerId },
    orderBy: { day: 'asc' },
    include: { windows: true },
  });
}
