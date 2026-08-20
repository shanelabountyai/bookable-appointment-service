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
  SlotNotOffered,
  SlotTaken,
  bookAppointment,
  clientAlreadyBookedAround,
  walkInOptions,
} from '@bookable/db/booking';
import { computeDaySlots } from '@bookable/db/scheduling';
import { clientReliability, searchClients } from '@bookable/db/clients';
import { normalizePhone } from '@bookable/core/clients';
import { fromDate, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { staffActor } from '@bookable/core/auth';
import { requireStaff } from '@/lib/auth/session';
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
export async function findWalkInOptions(serviceIds: string[], day: string): Promise<WalkInChoice[]> {
  const staff = await requireStaff();
  const options = await walkInOptions(prisma, { businessId: staff.businessId, serviceIds, day, now: new Date() });
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

  const providerId = String(formData.get('providerId') ?? '');
  const serviceIds = formData.getAll('serviceIds').map(String).filter(Boolean);
  const atIso = String(formData.get('at') ?? '');
  const clientIdRaw = String(formData.get('clientId') ?? '');
  const isOverride = formData.get('isOverride') === 'on';
  const overrideReason = String(formData.get('overrideReason') ?? '');

  if (serviceIds.length === 0) return { ok: false, message: 'Choose at least one service.' };

  let startAt: Date;
  try {
    startAt = toDate(instantFromIso(atIso));
  } catch {
    return { ok: false, message: 'That time is not readable. Go back to the day and pick again.' };
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
    if (error instanceof SlotTaken || error instanceof SlotNotOffered) {
      // NOT an error message and a dead end. The operator's hardest-won point
      // (D-8) is that every platform he abandoned died of a flat refusal — so
      // the refusal comes back with the reasons and the panel offers the
      // override that BOOK-05 exists for.
      return {
        ok: false,
        message: 'That time is not free.',
        canOverride: true,
        refusedReasons: error instanceof SlotNotOffered ? [...error.reasons] : ['overlaps-booking'],
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

export interface OfferedSlot {
  at: string;
  label: string;
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
export async function staffSlotsFor(providerId: string, serviceIds: string[], day: string): Promise<OfferedSlot[]> {
  const staff = await requireStaff();
  if (serviceIds.length === 0 || !providerId) return [];

  const { slots } = await computeDaySlots(prisma, {
    businessId: staff.businessId,
    providerId,
    serviceIds,
    day,
    now: new Date(),
    // Staff: no horizon, no lead time, and exclusion reasons available.
    audience: 'staff',
  });

  return slots.map((slot) => ({ at: toDate(slot.start).toISOString(), label: slot.label.time }));
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

/** A wall-clock label in the SALON's zone. Server-side, always: the browser
 *  would format it in the visitor's. */
async function clock(businessId: string, at: Date): Promise<string> {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
  return toLabel(fromDate(at), zoneId(business.timezone)).time;
}
