'use server';

/**
 * The CUSTOMER booking flow's server actions (BOOK-01).
 *
 * Everything here is the RESTRICTED caller: `audience: 'public'` on every
 * engine call, which caps the booking horizon (D-21) and — more importantly —
 * withholds `explain`, because `overlaps-booking` would tell an anonymous
 * visitor exactly when a provider is with a client (spec §1.3).
 *
 * D-10's lexicon applies to everything these return: "appointment", never
 * "booking" or "slot"; no internal identifier, entity name or status enum
 * crosses this boundary. The only ids returned are the ones the next request
 * must echo back.
 */
import { addDays, fromDate, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { readableDay } from '@/lib/customer-format';
import { prisma } from '@bookable/db';
import { SlotNotOffered, SlotTaken, bookAppointment } from '@bookable/db/booking';
import { computeDaySlots, daysWithAvailability } from '@bookable/db/scheduling';
import { systemActor } from '@bookable/core/auth';

export interface OfferedTime {
  /** The appointment's identity is its INSTANT (D-4). An offset-bearing ISO
   *  string, never a `{date, time}` pair — on the day the clocks go back,
   *  "01:30" names two different moments and such a payload is a coin flip. */
  at: string;
  /** Precomputed in the salon's own timezone, server-side. If only instants
   *  reached the browser it would format them in the VISITOR's timezone,
   *  which is the whole of spec §3.D. */
  label: string;
  /** Shown only when the same wall-clock label occurs twice that day, so the
   *  two are distinguishable on the fall-back day (FB-5). */
  qualifier?: string;
}

async function businessId(): Promise<string> {
  return (await theBusiness()).id;
}

async function theBusiness() {
  return prisma.business.findFirstOrThrow({ select: { id: true, timezone: true } });
}

/** How far ahead the day list looks. Shorter than the booking horizon on
 *  purpose — a customer scrolling ninety days of Tuesdays is not choosing, and
 *  each day costs a slot computation. Past the end they call the salon. */
const DAYS_AHEAD = 28;

export async function listServices() {
  return prisma.service.findMany({
    where: { active: true },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, durationMinutes: true, priceCents: true },
  });
}

/** Providers qualified for this service. "Anyone available" is offered as a
 *  separate choice by the UI, not as a row here. */
export async function listProvidersFor(serviceId: string) {
  const links = await prisma.serviceProvider.findMany({
    where: { serviceId, provider: { active: true } },
    include: { provider: true },
  });
  return links
    .map((l) => ({ id: l.provider.id, name: l.provider.displayName, order: l.provider.displayOrder }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ id, name }) => ({ id, name }));
}

export interface OpenDay {
  /** The salon's own calendar day, "2026-06-09". */
  day: string;
  /** "Tuesday 9 June", formatted SERVER-side in the salon's zone.
   *
   *  The browser must never derive this. Parsing "2026-06-09" in the visitor's
   *  timezone is the exact `@db.Date` shift this project bans (D-3), and a
   *  hand-rolled weekday calculation in a client component is the same bug
   *  waiting to be written by hand instead. The one conversion module already
   *  does it correctly, and it runs here. */
  label: string;
}

/**
 * The days this provider can do this service, starting from TODAY IN THE
 * SALON'S ZONE.
 *
 * The window is computed here rather than passed in from the browser: the
 * customer's "today" is not the salon's, and a visitor in Auckland asking for
 * their own today would be shown a day the salon has not reached yet. The
 * business's own calendar is the only one that decides (spec §1.3).
 */
export async function listDaysWithOpenings(serviceId: string, providerId: string): Promise<OpenDay[]> {
  const business = await theBusiness();
  const now = new Date();
  const today = toLabel(fromDate(now), zoneId(business.timezone)).day;

  const days = await daysWithAvailability(prisma, {
    businessId: business.id,
    providerId,
    serviceIds: [serviceId],
    now,
    audience: 'public',
    fromDay: today,
    toDay: addDays(today, DAYS_AHEAD),
  });
  return days.map((day) => ({ day, label: readableDay(day) }));
}

export async function listTimesOn(serviceId: string, providerId: string, day: string): Promise<OfferedTime[]> {
  const { slots } = await computeDaySlots(prisma, {
    businessId: await businessId(),
    providerId,
    serviceIds: [serviceId],
    day,
    now: new Date(),
    audience: 'public',
  });

  return slots.map((slot) => ({
    at: toDate(slot.start).toISOString(),
    label: slot.label.time,
    // FB-5: two 01:30s an hour apart must be told apart by the customer, or
    // the page shows the same time twice and looks broken.
    ...(slot.labelIsAmbiguous ? { qualifier: slot.label.abbreviation } : {}),
  }));
}

export interface ConfirmResult {
  ok: boolean;
  /** Customer-facing wording only (D-10). */
  message?: string;
  /** Fresh times to choose from when the chosen one has gone. */
  alternatives?: OfferedTime[];
  fieldErrors?: Record<string, string>;
}

/**
 * Creates the appointment.
 *
 * Phone-first identity (CLIENT-01): the client is looked up by normalized
 * phone, which is deliberately NOT unique (D-17) because households share a
 * number. A match is only reused when the NAME matches too — otherwise a
 * mother booking for her daughter would silently inherit the mother's record,
 * her notes and her no-show count.
 */
export async function confirmAppointment(input: {
  serviceId: string;
  providerId: string;
  at: string;
  /**
   * The BUSINESS calendar day the customer was looking at.
   *
   * Passed in rather than sliced off `at`: `at` is UTC, so a 23:00 Chicago
   * appointment carries tomorrow's UTC date, and deriving the day from it
   * would look up alternatives on the wrong day — the axis crossing this
   * project exists to practise not writing (D-3).
   */
  day: string;
  name: string;
  phone: string;
  email?: string;
}): Promise<ConfirmResult> {
  const fieldErrors: Record<string, string> = {};
  const name = input.name.trim();
  const phone = normalizePhone(input.phone);
  if (name.length === 0) fieldErrors.name = 'Please give us a name for the appointment.';
  if (phone.length < 7) fieldErrors.phone = 'Please give us a phone number we can reach you on.';
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  let startAt: Date;
  try {
    startAt = toDate(instantFromIso(input.at));
  } catch {
    return { ok: false, message: 'That time is no longer available. Please choose another.' };
  }

  const business = await businessId();

  // Reuse only on an exact (phone, name) match — see the note above.
  const existing = await prisma.client.findFirst({
    where: { businessId: business, phone, name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
  const client =
    existing ??
    (await prisma.client.create({
      data: { businessId: business, name, phone, email: input.email?.trim() || null },
    }));

  try {
    await bookAppointment(prisma, {
      businessId: business,
      providerId: input.providerId,
      serviceIds: [input.serviceId],
      clientId: client.id,
      startAt,
      now: new Date(),
      // A customer acts as themselves, not as staff. D-9's actor is what makes
      // the cancellation cutoff apply to them and not to the front desk.
      actor: systemActor,
      audience: 'public',
      idempotencyKey: `public:${input.providerId}:${startAt.toISOString()}:${client.id}`,
    });
  } catch (error) {
    if (error instanceof SlotTaken || error instanceof SlotNotOffered) {
      const alternatives = await listTimesOn(input.serviceId, input.providerId, input.day).catch(() => []);
      return {
        ok: false,
        message: 'Sorry — that time has just been taken. Here are the other times still free.',
        alternatives,
      };
    }
    throw error;
  }

  return { ok: true, message: 'Your appointment is confirmed.' };
}

/** Digits only, keeping a leading +. Deliberately forgiving: a customer typing
 *  (512) 555-0101 and 5125550101 is the same person, and refusing one of them
 *  costs a booking. */
function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}
