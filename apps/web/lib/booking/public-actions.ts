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
import { type CalendarDay, addDays, fromDate, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { readableDay } from '@/lib/customer-format';
import { prisma } from '@bookable/db';
import {
  NoResourceFree,
  NotBookableOnline,
  SelfServeBlocked,
  SlotNotOffered,
  SlotTaken,
  anyProviderDays,
  anyProviderTimes,
  bookAppointment,
  providersForVisit,
} from '@bookable/db/booking';
import { computeDaySlots, daysWithAvailability } from '@bookable/db/scheduling';
import { systemActor } from '@bookable/core/auth';
import { isPlausiblePhone, normalizePhone } from '@bookable/core/clients';

export interface OfferedTime {
  /** The appointment's identity is its INSTANT (D-4). An offset-bearing ISO
   *  string, never a `{date, time}` pair — on the day the clocks go back,
   *  "01:30" names two different moments and such a payload is a coin flip. */
  at: string;
  /** Precomputed in the salon's own timezone, server-side. If only instants
   *  reached the browser it would format them in the VISITOR's timezone,
   *  which is the whole of spec §3.D. */
  label: string;
  /** A-056: set only on the "no preference" path — WHO this time would be
   *  with, decided by SVC-02 when the list was built. The flow posts it back,
   *  so what she was shown is what she gets. */
  providerId?: string;
  providerName?: string;
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

/**
 * The public catalogue.
 *
 * Desk-only services (A-058) are RETURNED, not filtered out. A salon that
 * offers balayage and shows a client a list without it has told her it does
 * not do balayage, and she books it somewhere that does. The flow renders them
 * unselectable with the one thing she can act on — call us — which is the same
 * shape as every other refusal on this surface (D-10).
 */
export async function listServices() {
  return prisma.service.findMany({
    where: { active: true },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, durationMinutes: true, priceCents: true, bookableOnline: true },
  });
}

/**
 * A-058. True when any service in this visit is desk-only.
 *
 * Guards the four LIST functions below, so a hand-made request cannot
 * enumerate a desk-only service's availability after the catalogue has
 * declined to offer it. It is defence in depth and says so: the decision that
 * actually matters is `bookAppointment`'s, which refuses the write.
 *
 * Deliberately here and NOT inside `buildSlotQuery` — the manage link
 * reschedules an existing appointment as `audience: 'public'`, and a colour
 * correction booked properly through the desk must stay movable by the client
 * who has it. The flag governs starting a visit, not keeping one.
 */
async function anyDeskOnly(serviceIds: readonly string[]): Promise<boolean> {
  if (serviceIds.length === 0) return true;
  return (
    (await prisma.service.count({ where: { id: { in: [...serviceIds] }, bookableOnline: false } })) > 0
  );
}

/**
 * Providers qualified for the WHOLE visit (VISIT-01). "Anyone available" is
 * offered as a separate choice by the UI, not as a row here.
 *
 * A-058 made this plural and therefore made it all-or-nothing: a stylist who
 * cuts but does not colour must not appear for a cut-and-colour, and half a
 * cut-and-colour with the wrong person is not a partial success. That rule
 * already existed as `providersForVisit` (A-056), so this calls it rather than
 * growing a second copy — the local `serviceProvider` query it replaced would
 * have had to learn the same counting and would have been the fork.
 */
export async function listProvidersFor(serviceIds: string[]) {
  const providers = await providersForVisit(prisma, { businessId: await businessId(), serviceIds });
  return providers.map((p) => ({ id: p.id, name: p.displayName }));
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
export async function listDaysWithOpenings(serviceIds: string[], providerId: string): Promise<OpenDay[]> {
  if (await anyDeskOnly(serviceIds)) return [];
  const business = await theBusiness();
  const now = new Date();
  // A-054: the `fromDay` argument went with `resolvePrefill`. It existed only
  // for CLIENT-02's "jump to the natural interval", which arrived through the
  // public `/book?service=` link A-040 replaced and A-054 deleted — the whole
  // flow starts from today now, which is what every caller already asked for.
  const start = toLabel(fromDate(now), zoneId(business.timezone)).day as CalendarDay;

  const days = await daysWithAvailability(prisma, {
    businessId: business.id,
    providerId,
    serviceIds,
    now,
    audience: 'public',
    fromDay: start,
    toDay: addDays(start, DAYS_AHEAD),
  });
  return days.map((day) => ({ day, label: readableDay(day) }));
}


export async function listTimesOn(serviceIds: string[], providerId: string, day: string): Promise<OfferedTime[]> {
  if (await anyDeskOnly(serviceIds)) return [];
  const { slots } = await computeDaySlots(prisma, {
    businessId: await businessId(),
    providerId,
    serviceIds,
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

/**
 * A-056 (SVC-02) — the days ANY qualified stylist could take this on.
 *
 * The public flow made "Who would you like to see?" a mandatory step with no
 * *no preference* option, so a first-time client who has never heard of Dana
 * or Priya picked the top name or left. That is the operator's account of the
 * utilization gap A-024's dashboard reports and cannot explain.
 */
export async function listAnyProviderDays(serviceIds: string[]): Promise<OpenDay[]> {
  if (await anyDeskOnly(serviceIds)) return [];
  const business = await theBusiness();
  const now = new Date();
  const start = toLabel(fromDate(now), zoneId(business.timezone)).day as CalendarDay;

  const days = await anyProviderDays(prisma, {
    businessId: business.id,
    serviceIds,
    fromDay: start,
    toDay: addDays(start, DAYS_AHEAD),
    now,
    audience: 'public',
  });
  return days.map((day) => ({ day, label: readableDay(day) }));
}

/** A-056 — every time anyone could take it that day, one row per time, each
 *  carrying the stylist SVC-02 assigned it to. */
export async function listAnyProviderTimes(serviceIds: string[], day: string): Promise<OfferedTime[]> {
  if (await anyDeskOnly(serviceIds)) return [];
  const business = await theBusiness();
  const offered = await anyProviderTimes(prisma, {
    businessId: business.id,
    serviceIds,
    day,
    now: new Date(),
    audience: 'public',
  });

  const zone = zoneId(business.timezone);
  return offered.map((time) => ({
    at: time.at.toISOString(),
    label: toLabel(fromDate(time.at), zone).time,
    providerId: time.providerId,
    providerName: time.providerName,
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
  /**
   * The services in this visit, IN ORDER (VISIT-01, D-23).
   *
   * A-058 made this plural. Half the Saturday book is a cut AND a colour, and
   * a flow that could only take one meant she booked "Colour" at two hours,
   * arrived wanting a cut too, and 45 minutes had to come out of a column that
   * was already full. Order matters because the buffers come from the ends.
   */
  serviceIds: string[];
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
  if (!isPlausiblePhone(phone)) fieldErrors.phone = 'Please give us a phone number we can reach you on.';
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  let startAt: Date;
  try {
    startAt = toDate(instantFromIso(input.at));
  } catch {
    return { ok: false, message: 'That time is no longer available. Please choose another.' };
  }

  const business = await businessId();

  // Reuse only on an exact (phone, name) match — see the note above.
  //
  // A client blocked under CLIENT-04 can therefore get past the block by
  // typing her name differently, and that is the deliberate trade rather than
  // an oversight: keying the block on the PHONE NUMBER would block every
  // member of a household that shares one, which is precisely the harm D-17
  // exists to prevent ("the daughter's two no-shows block the mother"). The
  // salon still sees the flag the moment the desk looks the number up, and
  // merging the duplicate (A-015) combines the counts.
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
      serviceIds: input.serviceIds,
      clientId: client.id,
      startAt,
      now: new Date(),
      // A customer acts as themselves, not as staff. D-9's actor is what makes
      // the cancellation cutoff apply to them and not to the front desk.
      actor: systemActor,
      audience: 'public',
      // The SERVICES are part of what makes this request the same request:
      // without them a retry that changed the visit would silently return the
      // first appointment and report success on a booking that was never made.
      idempotencyKey: `public:${input.providerId}:${input.serviceIds.join('+')}:${startAt.toISOString()}:${client.id}`,
    });
  } catch (error) {
    // CLIENT-04's block. The wording says the ONE thing she can act on and
    // nothing about why: an anonymous visitor typing somebody else's phone
    // number must not be told how often that person misses appointments, and
    // the client herself deserves to hear it from a person rather than from a
    // form (D-10, spec §1.3). No alternatives are offered — every other time
    // would be refused identically, and a list of them reads as a bug.
    // A-058. Reachable only from a hand-made request — the catalogue marks
    // these unselectable and the list functions return nothing for them — and
    // it is the boundary that decides, so it answers properly rather than
    // crashing. NAMES the service, because a refused cut-and-balayage without
    // it leaves her removing services at random to find the one at fault.
    if (error instanceof NotBookableOnline) {
      return {
        ok: false,
        message: `${error.serviceName} needs a quick chat first — please call the salon and we'll book it in.`,
      };
    }
    if (error instanceof SelfServeBlocked) {
      return {
        ok: false,
        message: 'We can’t book this one online. Please call the salon and we’ll get you in.',
      };
    }
    // `NoResourceFree` (RES-03) belongs in this branch and NOT one of its own,
    // because the customer's answer is identical: a different time, and the
    // refreshed list beside it. She must not be told that the SALON is full
    // rather than the stylist — that is an occupancy fact about the whole
    // business, and D-10's lexicon keeps it inside (spec §1.3). Before this
    // caught it the error escaped the action entirely and she saw a crash on
    // a time the page had just offered her.
    if (error instanceof SlotTaken || error instanceof SlotNotOffered || error instanceof NoResourceFree) {
      const alternatives = await listTimesOn(input.serviceIds, input.providerId, input.day).catch(() => []);
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
