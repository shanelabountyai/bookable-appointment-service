'use server';

/**
 * A-017 — the front desk's own booking actions (BOOK-04, BOOK-05, D-8, D-17).
 *
 * The UNRESTRICTED caller, and the one the write path was shaped around from
 * A-009: nullable client, no horizon (D-21), no lead time (D-25), exclusion
 * reasons visible, and `isOverride` available with a reason. The customer flow
 * in `public-actions.ts` is the restricted one — not the other way round.
 *
 * Every action begins with `requireStaff()`. A route guard is not enough: a
 * server action is its own entry point, and this is the one that can book on
 * top of somebody.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  BookingRejected,
  NoResourceFree,
  type SeriesOccurrenceResult,
  type SkipReason,
  SlotNotOffered,
  SlotTaken,
  type AnyProviderTime,
  anyProviderAt,
  anyProviderTimes,
  bookAppointment,
  clientAlreadyBookedAround,
  createSeries,
  walkInOptions,
} from '@bookable/db/booking';
import { computeDaySlots } from '@bookable/db/scheduling';
import { clientReliability, searchClients } from '@bookable/db/clients';
import { normalizePhone } from '@bookable/core/clients';
import { calendarDay, fromDate, instantFromIso, resolve, toDate, toLabel, wallTime, zoneId } from '@bookable/core/time';
import { InvalidSeries } from '@bookable/core/scheduling';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';
import { readableReason } from '@/lib/scheduling-words';
import { flagSentence } from '@/components/client-flag';

export interface StaffBookingState {
  ok?: boolean;
  message?: string;
  /**
   * True when the ENGINE refused — which is the case BOOK-05 exists for, so
   * the panel offers the override.
   *
   * Separate from `refusedReasons` because that list can legitimately be
   * EMPTY: the engine explains CANDIDATES, and a time outside every working
   * window is never a candidate at all. That is the first case BOOK-05 names
   * ("book outside hours"), and gating the override on having reasons made it
   * the one refusal with no way past — a flat refusal, which is the thing D-8
   * is written to prevent. Found by the e2e spec.
   */
  canOverride?: boolean;
  /** The engine's own words, when it has any. */
  refusedReasons?: string[];
  bookedId?: string;
  /**
   * A-071 — WHO ELSE CAN DO IT, when an "anyone" booking lost the race.
   *
   * Present INSTEAD of `canOverride`, never beside it: the whole defect was
   * offering to knowingly double-book Dana while Priya and Tess were free at
   * the same two o'clock. Never applied silently either (A-056's rule is that
   * what you see is what you book) — this names a person on a button the desk
   * presses.
   */
  fallback?: { providerId: string; providerName: string; at: string; label: string };
  /** A-049 — set when this was a standing appointment rather than one. */
  series?: SeriesSummary;
}

/** One week of a standing appointment, as the desk reads it back. */
export interface SeriesLine {
  /** "Tuesday 9 June", in the salon's zone. */
  day: string;
  /** Set when that week booked — the desk taps through to it. */
  appointmentId?: string;
  /**
   * Why it did not book, or what was odd about the week it did. Empty on an
   * ordinary occurrence. A SENTENCE, never a code: this list is read at a desk
   * with a client standing at it, and "not-offered" is not an answer.
   */
  note?: string;
}

export interface SeriesSummary {
  booked: number;
  requested: number;
  intervalWeeks: number;
  lines: SeriesLine[];
}

export interface ClientChoice {
  id: string;
  name: string | null;
  phone: string | null;
  /** D-17's soft note: this client already holds something overlapping. Never
   *  a refusal — a household shares a number and one person may legitimately
   *  hold two appointments — but an accidental double-book of the same person
   *  is an ordinary slip, and saying so costs nothing. */
  alreadyBooked?: string;
  /** CLIENT-04's flag, already worded (D-27). Also never a refusal: the desk
   *  sees it, books her anyway in one tap, and the booking records that it
   *  happened over a flag. */
  missed?: string;
}

/** Partial phone/name search, with the same-client note computed against the
 *  slot being booked. */
export async function findClientsForBooking(query: string, atIso: string, serviceIds: string[]): Promise<ClientChoice[]> {
  const staff = await requireStaff();
  const matches = await searchClients(prisma, staff.businessId, query);
  if (matches.length === 0) return [];

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const flags = await clientReliability(prisma, {
    businessId: staff.businessId,
    clientIds: matches.map((m) => m.id),
    today: toLabel(fromDate(new Date()), zoneId(business.timezone)).day,
  });
  const flagFor = (id: string) => {
    const sentence = flagSentence(flags.get(id)!);
    return sentence ? { missed: sentence } : {};
  };

  const span = await visitSpan(staff.businessId, atIso, serviceIds);
  if (!span) return matches.map(({ id, name, phone }) => ({ id, name, phone, ...flagFor(id) }));

  return Promise.all(
    matches.map(async ({ id, name, phone }) => {
      const clashes = await clientAlreadyBookedAround(prisma, {
        businessId: staff.businessId,
        clientId: id,
        startAt: span.startAt,
        endAt: span.endAt,
      });
      const first = clashes[0];
      return {
        id,
        name,
        phone,
        ...flagFor(id),
        ...(first
          ? { alreadyBooked: `already has ${await clock(staff.businessId, first.startAt)} with ${first.providerName}` }
          : {}),
      };
    }),
  );
}

/** CLIENT-01's "staff choose or create". Phone-first, and normalized on the
 *  way in so the record is findable by whoever types the number next. */
export async function createClientForBooking(name: string, phone: string): Promise<ClientChoice | null> {
  const staff = await requireStaff();
  const trimmed = name.trim();
  if (trimmed === '') return null;

  const client = await prisma.client.create({
    data: { businessId: staff.businessId, name: trimmed, phone: normalizePhone(phone) || null },
    select: { id: true, name: true, phone: true },
  });
  return client;
}

export interface WalkInChoice {
  providerId: string;
  providerName: string;
  /** The INSTANT, as an offset-bearing string (D-4). The panel echoes this
   *  back verbatim — no client-side `Date` anywhere, so nothing can be
   *  re-read in the browser's timezone. */
  at: string;
  /** Already formatted in the salon's zone. */
  label: string;
}

/** BOOK-04's walk-in: who could take this visit, soonest first. */
export async function findWalkInOptions(
  serviceIds: string[],
  day: string,
  clientId?: string | null,
): Promise<WalkInChoice[]> {
  const staff = await requireStaff();
  const options = await walkInOptions(prisma, {
    businessId: staff.businessId,
    serviceIds,
    day,
    now: new Date(),
    // A-083 — a named walk-in is often a client already in a chair for
    // something else; the stranger at the door is the `null` case.
    holderKey: clientId || null,
  });
  return Promise.all(
    options.map(async (option) => ({
      providerId: option.providerId,
      providerName: option.providerName,
      at: option.startAt.toISOString(),
      label: await clock(staff.businessId, option.startAt),
    })),
  );
}

/**
 * The booking itself, for both the ordinary path and BOOK-05's override.
 *
 * ONE action for both, deliberately: an override is the same booking with a
 * reason attached, and a separate `overrideBooking` action would be a second
 * write path to keep in step with this one.
 */
export async function bookAsStaff(_previous: StaffBookingState, formData: FormData): Promise<StaffBookingState> {
  const staff = await requireStaff();

  // A-071's one-tap fallback carries its own field, because two inputs named
  // `providerId` would resolve to the hidden one above it and re-book the
  // stylist who has just gone.
  const providerId = String(formData.get('insteadProviderId') ?? '') || String(formData.get('providerId') ?? '');
  const serviceIds = formData.getAll('serviceIds').map(String).filter(Boolean);
  const atIso = String(formData.get('at') ?? '');
  const clientIdRaw = String(formData.get('clientId') ?? '');
  const isOverride = formData.get('isOverride') === 'on';
  const overrideReason = String(formData.get('overrideReason') ?? '');
  // A-071. The desk tapped an "anyone at two" row, which MEANS the stylists
  // are interchangeable at that instant — so losing the race for the one it
  // named is not the same refusal as losing the race for a stylist the client
  // asked for by name, and must not get the same answer.
  const fromAnyone = formData.get('fromAnyone') === '1';

  if (serviceIds.length === 0) return { ok: false, message: 'Choose at least one service.' };

  let startAt: Date;
  try {
    startAt = toDate(instantFromIso(atIso));
  } catch {
    return { ok: false, message: 'That time is not readable. Go back to the day and pick again.' };
  }

  // A-049 — "and every four weeks after that". One form and one submit for
  // both, because a standing appointment is the same booking said twice: the
  // panel's whole shape above (services, day, time, who she is) is the anchor
  // occurrence, and the repeat is two numbers beside the button. A second
  // screen for it would be a second booking form to keep in step with this one.
  const repeatCount = Number(formData.get('repeatCount') ?? 1);
  const intervalWeeks = Number(formData.get('repeatEveryWeeks') ?? 4);
  if (Number.isFinite(repeatCount) && repeatCount > 1) {
    // An override is one appointment with a reason typed against it (BOOK-05).
    // Repeating it would apply that one reason to six bookings the desk has
    // not looked at — which is exactly how an override marker stops meaning
    // anything. Refused with the way forward, never silently dropped.
    if (isOverride) {
      return {
        ok: false,
        message: 'An override books one appointment. Book this one, then set the repeat up from a time she is free.',
      };
    }
    return bookStandingSeries(staff, {
      providerId,
      serviceIds,
      clientId: clientIdRaw || null,
      startAt,
      intervalWeeks,
      count: repeatCount,
    });
  }

  try {
    const appointment = await bookAppointment(prisma, {
      businessId: staff.businessId,
      providerId,
      serviceIds,
      // BOOK-04: "walk-in, no name" is a real appointment. The empty string is
      // the form's way of saying nobody, and it must not become an id.
      clientId: clientIdRaw || null,
      startAt,
      now: new Date(),
      actor: staffActor(staff.id),
      audience: 'staff',
      isOverride,
      overrideReason: isOverride ? overrideReason : null,
    });

    revalidatePath('/staff/day');
    return {
      ok: true,
      bookedId: appointment.id,
      message: isOverride ? 'Booked as an override, and recorded.' : 'Booked.',
    };
  } catch (error) {
    // A-071 — THE ANYONE PATH LOSES THE RACE.
    //
    // The row said 14:00, Dana, 3 free. The desk took a phone call, came back,
    // submitted, and the public flow had taken Dana in between. Offering an
    // override HERE would be offering to knowingly double-book her while Priya
    // and Tess are both free at the same two o'clock — so the desk either
    // takes it (wrong) or starts the search again with the client on the
    // phone, and A-056's whole premise is thrown away at the last step.
    //
    // BOTH refusals, because both mean "not for HER": a lost race, and a
    // stylist who has gone off since the list was drawn. `anyProviderAt` asks
    // across everybody, so it can legitimately find somebody in either case —
    // and returns null when it cannot, which is when the ordinary
    // refusal-plus-override below is the right answer.
    if (fromAnyone && (error instanceof SlotTaken || error instanceof SlotNotOffered)) {
      const instead = await anyProviderAt(prisma, {
        businessId: staff.businessId,
        serviceIds,
        at: startAt,
        now: new Date(),
        // A-083 — the same holder the write just used, or the search that
        // answers "who else could take her" is stricter than the booking it
        // is recovering from.
        holderKey: clientIdRaw || null,
        audience: 'staff',
      });
      // A DIFFERENT person, because re-offering the one just refused is a dead
      // end — which happens when the refusal was about the room (RES-04)
      // rather than about her.
      if (instead && instead.providerId !== providerId) {
        return {
          ok: false,
          message: `${await providerName(staff.businessId, providerId)} has just gone — ${instead.providerName} can do it at ${await clock(staff.businessId, instead.at)}. Book that?`,
          // NO override offered. That is the defect.
          fallback: {
            providerId: instead.providerId,
            providerName: instead.providerName,
            at: instead.at.toISOString(),
            label: await clock(staff.businessId, instead.at),
          },
        };
      }
      // Nobody else qualified is free at that instant, so the ordinary
      // refusal below IS the right answer and BOOK-05 is the right escape.
    }
    if (error instanceof SlotTaken || error instanceof SlotNotOffered) {
      // NOT an error message and a dead end. The operator's hardest-won point
      // (D-8) is that every platform he abandoned died of a flat refusal — so
      // the refusal comes back with the reasons and the panel offers the
      // override that BOOK-05 exists for.
      return {
        ok: false,
        message: 'That time is not free.',
        canOverride: true,
        // BOTH errors now carry the engine's reasons. `SlotTaken`'s can still
        // be empty — a lost race arrives through the exclusion constraint with
        // nothing to say — and 'overlaps-booking' is the right guess THERE,
        // because something was genuinely written on top of this time.
        refusedReasons:
          error.reasons.length > 0
            ? [...error.reasons]
            : error instanceof SlotTaken
              ? ['overlaps-booking']
              : [],
      };
    }
    // RES-04 — the room is full, and that is a decision, not a refusal.
    // "We'll do her at the backwash" is a real answer, so the shortage comes
    // back the same way a double-book does: named, with the override one click
    // away. An override holds no chair at all (D-30), which is what makes the
    // retry succeed and what makes it worth recording.
    if (error instanceof NoResourceFree) {
      return {
        ok: false,
        message: 'That time is not free.',
        canOverride: true,
        refusedReasons: ['no-resource-free'],
      };
    }
    if (error instanceof BookingRejected) return { ok: false, message: error.message };
    throw error;
  }
}

export interface GridTime {
  /** The INSTANT (D-4). On fall-back day two entries share the label "01:30"
   *  and differ only here, which is the whole point of carrying it. */
  at: string;
  label: string;
  /**
   * Empty when the engine offered this time. Otherwise the engine's OWN
   * reasons, which the panel renders beside the time and which make picking
   * it a decision rather than a guess (A-042, A-032's deferred half).
   *
   * Staff only — `overlaps-booking` tells whoever reads it exactly when the
   * provider is with a client (spec §1.3). Every caller of this action is
   * behind `requireStaff()`; there is no public equivalent and there must not
   * be one.
   */
  reasons: readonly string[];
}

/**
 * The times this provider could actually START this visit on this day.
 *
 * ADDED BY DEMO CHECKPOINT 2, which found the seam between A-016's gaps and
 * this panel. A gap runs from the previous appointment's buffer end — 13:35,
 * say — and the slot grid is anchored to window-open on the salon's interval,
 * so 13:35 is not a candidate at all. Booking the gap's raw start was refused
 * with `SlotNotOffered` and NO reasons, and the panel then offered an
 * OVERRIDE for a slot that was genuinely free. Routing ordinary bookings
 * through the override path is precisely what makes the override marker
 * meaningless (VISIT-01 refuses two-adjacent-appointments for the same
 * reason).
 *
 * So a gap link now means "book around here": the panel lists the real
 * offered times and preselects the first one at or after it.
 */
/**
 * A-083 — THE DESK KNOWS WHO IT IS BOOKING, SO IT MUST SAY SO.
 *
 * `clientId` is A-063's holder: one client's own overlapping envelopes may
 * share her chair, so the room's answer DEPENDS on who would be sitting in it.
 * `null` is the strict question and is right for a visitor who has not said
 * who she is — it was also what this panel passed for a client it had already
 * resolved, so the desk was told "every chair is taken then" about a chair
 * that was hers and empty, and the only way through was a BOOK-05 override
 * that by D-30 holds no chair at all.
 */
export async function staffSlotsFor(
  providerId: string,
  serviceIds: string[],
  day: string,
  clientId?: string | null,
): Promise<GridTime[]> {
  const staff = await requireStaff();
  if (serviceIds.length === 0 || !providerId) return [];

  const { slots, excluded } = await computeDaySlots(prisma, {
    businessId: staff.businessId,
    providerId,
    serviceIds,
    day,
    now: new Date(),
    // Staff: no horizon, no lead time, and exclusion reasons available.
    audience: 'staff',
    holderKey: clientId || null,
  });

  // A-042 — THE WHOLE COLUMN, not only the sellable part of it.
  //
  // Until now the panel listed `slots` alone, so a fully booked stylist showed
  // an empty list and BOOK-05's override could only be reached by hand-typing
  // an `?at=` the product never emits. The engine has always returned the
  // refused candidates WITH their reasons on `audience: 'staff'`; nothing read
  // them. "10:00 — she already has a client" with the time still tappable is
  // the feature, and it is D-8's knowing double-book finally having a door.
  const candidates = [
    ...slots.map((slot) => ({ start: slot.start, label: slot.label.time, reasons: [] as readonly string[] })),
    ...excluded
      // "That time has passed" on every morning candidate is noise on every
      // afternoon of the year, and it is the one exclusion nobody can act on.
      // A past time that is ALSO occupied stays listed, with the reason that
      // matters — this drops the pure case only.
      .filter((e) => !(e.reasons.length === 1 && e.reasons[0] === 'in-the-past'))
      .map((e) => ({ start: e.candidateStart, label: e.label.time, reasons: e.reasons as readonly string[] })),
  ];

  // Sorted on the INSTANT, never the label: on fall-back day two candidates
  // are both called "01:30" and only the instant orders them (D-4).
  return candidates
    .sort((a, b) => a.start - b.start)
    .map(({ start, label, reasons }) => ({ at: toDate(start).toISOString(), label, reasons }));
}

export interface AnyoneChoice {
  /** The INSTANT (D-4), echoed back verbatim by the panel. */
  at: string;
  label: string;
  /** WHO she would get — decided by SVC-02 here, and booked as an ordinary
   *  booking of that provider. What the desk reads is what it books. */
  providerId: string;
  providerName: string;
  /** How many stylists are free then. "3 free" is slack the desk can offer
   *  around; "1" is a time it should sell now. */
  freeCount: number;
}

/**
 * A-056 — "anything Thursday? I don't mind who" (SVC-02).
 *
 * THE CALL THE DESK COULD NOT ANSWER. `staffSlotsFor` needs a provider before
 * it will say anything, so one day was four passes and two days were eight —
 * and a desk that has to do that says "let me ring you back", which is a
 * booking lost. Every time here still comes from the engine, once per
 * qualified stylist; this only merges them and applies SVC-02's assignment.
 */
export async function anyoneTimesFor(
  serviceIds: string[],
  day: string,
  clientId?: string | null,
): Promise<AnyoneChoice[]> {
  const staff = await requireStaff();
  if (serviceIds.length === 0) return [];

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const zone = zoneId(business.timezone);

  const offered: AnyProviderTime[] = await anyProviderTimes(prisma, {
    businessId: staff.businessId,
    serviceIds,
    day,
    now: new Date(),
    // Staff: no horizon, no lead time (D-21, D-25).
    audience: 'staff',
    // A-083 — the same holder as the provider path above; "I don't mind who"
    // never meant "I don't mind whose chair".
    holderKey: clientId || null,
  });

  return offered.map((time) => ({
    at: time.at.toISOString(),
    // Formatted in the SALON's zone, server-side — the browser would use the
    // visitor's.
    label: toLabel(fromDate(time.at), zone).time,
    providerId: time.providerId,
    providerName: time.providerName,
    freeCount: time.freeCount,
  }));
}

export interface ComposedTime {
  /** The instant, offset-bearing (D-4). */
  at: string;
  label: string;
  /** Set only on fall-back day, when the typed label names two instants. */
  note?: string;
}

/**
 * A-042 — "move her to 6pm, we'll stay late", composed SERVER-SIDE.
 *
 * The grid above covers the working windows and nothing else: with the grid
 * anchored to window-open, a time after close is never an engine candidate at
 * all, so it can never appear as a refused chip. That is exactly the case
 * BOOK-05 names first, the case A-038 routes back here, and the case the e2e
 * spec was faking with a hand-built `?at=18:00`.
 *
 * The browser sends `{day, "18:00"}` and gets back an INSTANT. It never
 * composes one itself: a `new Date("2026-06-09T18:00")` in the browser is the
 * visitor's timezone, which is the silent axis-crossing this whole project
 * exists to practise avoiding. `resolve()` is the one module allowed to cross,
 * and its three arms are all answered here rather than collapsed to a bare
 * instant — a spring-forward 02:30 does not exist and a fall-back 01:30 names
 * two chairs' worth of different times.
 */
export async function instantForTime(day: string, time: string): Promise<{ times: ComposedTime[]; error?: string }> {
  const staff = await requireStaff();
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });

  let resolution: ReturnType<typeof resolve>;
  try {
    resolution = resolve(calendarDay(day), wallTime(time), zoneId(business.timezone));
  } catch {
    return { times: [], error: 'That is not a time. Use the 24-hour clock, like 18:00.' };
  }

  if (resolution.kind === 'unique') return { times: [{ at: toDate(resolution.at).toISOString(), label: time }] };
  if (resolution.kind === 'gap') {
    return { times: [], error: `There is no ${time} that day — the clocks go forward. Pick either side of it.` };
  }
  // Fall-back. BOTH are offered and the desk picks which one it means: the
  // salon is open through the repeated hour and the two are an hour apart.
  return {
    times: [
      { at: toDate(resolution.earlier).toISOString(), label: time, note: 'first time round' },
      { at: toDate(resolution.later).toISOString(), label: time, note: 'second time round' },
    ],
  };
}

/**
 * A-049 — the standing appointment, written from the instant the desk tapped.
 *
 * The rule is stored on the CALENDAR axis (D-34): a day and a wall time, never
 * an instant plus an offset, because four weeks is 168 hours only when no
 * clock changes in between. So the picked instant is LABELLED back into
 * `(day, time)` here, at the boundary, and `createSeries` never sees an
 * instant at all.
 *
 * Partial by design: it books what it can and names every week it could not.
 * The summary this returns is that list, already in sentences — the desk reads
 * it and makes two phone calls.
 */
async function bookStandingSeries(
  staff: { id: string; businessId: string },
  input: {
    providerId: string;
    serviceIds: string[];
    clientId: string | null;
    startAt: Date;
    intervalWeeks: number;
    count: number;
  },
): Promise<StaffBookingState> {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const zone = zoneId(business.timezone);
  const anchor = toLabel(fromDate(input.startAt), zone);

  // THE ROUND TRIP HAS TO HOLD. Writing the rule down as a wall time and
  // reading it back gives the same instant every day of the year except one:
  // on fall-back day "01:30" names two, and `bookableInstant` takes the
  // earlier (reusing `offer-earlier-only`). If the desk deliberately tapped
  // the SECOND 01:30 — a real choice the panel offers by name — the anchor
  // occurrence would silently book the first, an hour from the appointment
  // just agreed with the client. Refused, with both ways out.
  const roundTrip = resolve(calendarDay(anchor.day), wallTime(anchor.time), zone);
  if (roundTrip.kind === 'ambiguous' && toDate(roundTrip.earlier).getTime() !== input.startAt.getTime()) {
    return {
      ok: false,
      message: `${anchor.time} happens twice that day — the clocks go back. Start the repeat from the first ${anchor.time}, or book this one on its own.`,
    };
  }

  let result;
  try {
    result = await createSeries(prisma, {
      businessId: staff.businessId,
      providerId: input.providerId,
      clientId: input.clientId,
      serviceIds: input.serviceIds,
      anchorDay: anchor.day,
      time: anchor.time,
      intervalWeeks: input.intervalWeeks,
      count: input.count,
      now: new Date(),
      actor: staffActor(staff.id),
    });
  } catch (error) {
    // A mistyped "600" or "every 0 weeks" comes back at the form with its own
    // sentence. Anything else is a real fault and is not dressed up as one.
    if (error instanceof InvalidSeries) return { ok: false, message: error.message };
    throw error;
  }

  revalidatePath('/staff/day');
  return {
    ok: true,
    bookedId: result.occurrences.find((occurrence) => occurrence.appointmentId)?.appointmentId,
    message:
      result.booked === input.count
        ? `Booked all ${input.count}.`
        : result.booked === 0
          ? 'Nothing could be booked. Every week is below, with the reason.'
          : `Booked ${result.booked} of ${input.count}. The rest are below, with the reason.`,
    series: {
      booked: result.booked,
      requested: input.count,
      intervalWeeks: input.intervalWeeks,
      lines: result.occurrences.map((occurrence) => {
        const note = seriesNote(occurrence, anchor.time);
        return {
          day: readableDay(occurrence.day),
          ...(occurrence.appointmentId ? { appointmentId: occurrence.appointmentId } : {}),
          ...(note ? { note } : {}),
        };
      }),
    },
  };
}

/** A week's outcome as a sentence somebody can act on, never a code. */
function seriesNote(occurrence: SeriesOccurrenceResult, time: string): string | null {
  if (occurrence.doubledHour) return `the clocks go back — booked the first ${time}`;
  if (!occurrence.skipped) return null;
  const skipped: SkipReason = occurrence.skipped;
  switch (skipped.kind) {
    case 'no-such-time':
      return `there is no ${time} that day — the clocks go forward`;
    case 'taken':
      return readableReason('overlaps-booking');
    case 'no-chair':
      return readableReason('no-resource-free');
    case 'not-offered':
      // The engine's OWN words, carried through. An empty list means this time
      // was never a candidate at all — outside her hours entirely.
      return skipped.reasons.length > 0
        ? skipped.reasons.map(readableReason).join('; ')
        : readableReason('outside-working-window');
  }
}

// ─────────────────────────── internals ───────────────────────────

/** The instants a visit would occupy, for the same-client note. Composed from
 *  the live catalogue because the appointment does not exist yet. */
async function visitSpan(businessId: string, atIso: string, serviceIds: string[]) {
  if (serviceIds.length === 0) return null;
  let startAt: Date;
  try {
    startAt = toDate(instantFromIso(atIso));
  } catch {
    return null;
  }

  const services = await prisma.service.findMany({
    where: { businessId, id: { in: serviceIds } },
    select: { durationMinutes: true },
  });
  const minutes = services.reduce((total, s) => total + s.durationMinutes, 0);
  return { startAt, endAt: toDate((fromDate(startAt) + minutes * 60_000) as ReturnType<typeof fromDate>) };
}

/** A-071 — the stylist the desk just lost the race for, by name, because
 *  "Dana has just gone" is the sentence and an id is not. */
async function providerName(businessId: string, providerId: string): Promise<string> {
  const provider = await prisma.provider.findFirst({
    where: { id: providerId, businessId },
    select: { displayName: true },
  });
  return provider?.displayName ?? 'That stylist';
}

/** A wall-clock label in the SALON's zone. Server-side, always: the browser
 *  would format it in the visitor's. */
async function clock(businessId: string, at: Date): Promise<string> {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
  return toLabel(fromDate(at), zoneId(business.timezone)).time;
}
