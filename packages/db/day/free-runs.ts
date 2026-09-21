/**
 * A-124 / D-60 — WHAT A FREED SPAN *IS*, ONCE THE BOOK AROUND IT CHANGES.
 *
 * Until this file there were two answers to "how much of that time is for
 * sale", and only one of them asked the book. The day grid derived gaps from
 * the busy set and drew the truth; `/staff/opened` and `matchFreedSlot`
 * measured the APPOINTMENT THAT LEFT — `blockedEnd - blockedStart` of a row
 * that has already been cancelled — and then compared minutes. Three wrong
 * answers came out of that one substitution (operator review at the Phase 15
 * close, finding 1):
 *
 *  - a 215-minute balayage with a blow-dry sold into its first 35 minutes
 *    DISAPPEARED from `/staff/opened` (the still-empty bound was
 *    all-or-nothing) while 13:35–17:00 sat free and a 185-minute cut and
 *    colour booked into it;
 *  - the appointment page's door into the matcher still named a client, and
 *    its Book link's instant was refused `SlotTaken` — the offered-then-refused
 *    shape, on the screen the desk makes phone calls from;
 *  - a 55-minute cancellation on an otherwise empty morning matched NOBODY,
 *    because 185 > 55, while the same client booked at its start.
 *
 * D-60(a) settles it: **the span is the contiguous free run of that provider
 * that overlaps the freed range, recomputed from the busy set on every read.**
 * Not a stored column and not a number carried in a URL — "this is free" stops
 * being true the moment somebody books it, which is the same reflex A-043's
 * header states for the list itself.
 *
 * SO THE GAP DERIVATION MOVES HERE AND BECOMES THE ONE COPY. `loadColumn`
 * calls `freeRunsFrom` for its `gaps`, and the freed-time screens call it too:
 * the waitlist now sells exactly the run the grid draws, which was the
 * operator's own argument for (a). A second implementation of "free" is a
 * second set of bugs that shows up on one row in a thousand — the thing this
 * file's neighbour, `day-view.ts`, opens by refusing to do three times.
 *
 * WHAT THIS DOES *NOT* DECIDE: whether a particular VISIT can start inside a
 * run. Fitting by minutes is what got us here. Only the engine knows about the
 * grid, the lead time, the room (`canSeat`) and a per-provider duration
 * override, so `matchFreedSlot` runs it through `computeSlotsIn` and uses the
 * run only as the bound the offered range must lie inside. A run is a
 * necessary condition, never a sufficient one.
 */
import { type Span, resolveWindow, subtractSpans, wallTime } from '../../core/scheduling';
import { addDays, calendarDay, fromDate, instant, startOfDay, toDate, toLabel, weekdayOf, zoneId } from '../../core/time';
import { findAbsences, resolveDayWindows } from '../availability';
import { findBusyAppointments } from '../scheduling';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

const MIN = 60_000;

/** A contiguous stretch of a provider's working day that nothing occupies. */
export interface FreeRun {
  start: Date;
  end: Date;
  minutes: number;
}

/**
 * The pure half: working windows minus breaks, absences and the busy set.
 *
 * Breaks are subtracted because lunch is not bookable time, and a screen that
 * offered it would send the front desk to interrupt a stylist eating.
 */
export function freeRunsFrom(args: {
  windows: readonly Span[];
  breaks: readonly Span[];
  absences: readonly { start: Date; end: Date }[];
  busy: readonly { start: Date; end: Date }[];
}): FreeRun[] {
  const taken: Span[] = [
    ...args.breaks,
    ...args.absences.map((a) => ({ start: fromDate(a.start), end: fromDate(a.end) })),
    ...args.busy.map((b) => ({ start: fromDate(b.start), end: fromDate(b.end) })),
  ];
  return subtractSpans(args.windows, taken).map((span) => ({
    start: toDate(span.start),
    end: toDate(span.end),
    minutes: (span.end - span.start) / MIN,
  }));
}

/**
 * The same runs, for a caller that holds only a provider and a day.
 *
 * The queries span local midnight ±24h for the reason `loadDayView` states:
 * the busy set needs that width so a neighbouring day's buffers still subtract
 * correctly, and an overnight window needs it to exist at all. The WINDOWS are
 * this day's only — a run that crosses midnight does so because
 * `resolveWindow` placed an `endsNextDay` close there, not because two days
 * were glued together.
 *
 * NO `active` FILTER, deliberately, and this is where it differs from the day
 * column. A-098's `gaps: []` for a departed stylist is about not drawing a
 * BOOKING LINK that names her; it is not a claim that the hour is occupied.
 * A freed Saturday afternoon is the salon's most valuable thing and is most
 * likely to come free the week somebody leaves — the span is sellable either
 * way, it is only she who is unbookable, and `providerActive` carries that to
 * the row.
 */
export async function freeRunsFor(
  db: Db,
  args: { businessId: string; providerId: string; day: string; timezone: string },
): Promise<FreeRun[]> {
  const zone = zoneId(args.timezone);
  const day = calendarDay(args.day);
  const from = toDate(instant(startOfDay(day, zone) - 24 * 60 * MIN));
  const to = toDate(instant(startOfDay(addDays(day, 1), zone) + 24 * 60 * MIN));

  const [resolved, busy, absences] = await Promise.all([
    resolveDayWindows(db, {
      businessId: args.businessId,
      providerId: args.providerId,
      day: args.day,
      weekday: weekdayOf(day),
    }),
    findBusyAppointments(db, { providerId: args.providerId, windowStart: from, windowEnd: to }),
    findAbsences(db, { providerId: args.providerId, windowStart: from, windowEnd: to }),
  ]);

  const windows = resolved.windows.map((w) =>
    resolveWindow(
      {
        open: wallTime(w.open),
        close: wallTime(w.close),
        endsNextDay: w.endsNextDay,
        breaks: w.breaks.map((b) => ({ open: wallTime(b.open), close: wallTime(b.close) })),
      },
      day,
      zone,
    ),
  );

  return freeRunsFrom({
    windows: windows.map((w) => w.span),
    breaks: windows.flatMap((w) => [...w.breaks]),
    absences,
    busy,
  });
}

/**
 * D-60(a) — the run a freed range now lives in, and what is left OF that range.
 *
 * Two facts, one read, because the two freed-time surfaces want different ones
 * and deriving them twice is how they would come to disagree:
 *
 *  - **`run`** is what the MATCHER asks about. A visit the engine offers is
 *    wholly free and contiguous, so if its blocked range overlaps a MAXIMAL
 *    free run it lies entirely inside it — which is why "overlaps the run" and
 *    "fits in the run" are the same test, and why the run's length is a sound
 *    cheap pre-filter before paying for an engine call.
 *  - **`remainder`** is what `/staff/opened` and the appointment page SAY. The
 *    listing is right to call a 55-minute cancellation on an empty morning
 *    "55 minutes opened up" — the rest was already open — so the words stay
 *    clipped to the freed range, while the matcher sells the whole morning.
 *
 * `null` means there is nothing to sell and nobody to ring: the span is wholly
 * past, or it has been resold, or the stylist is now off that day. Both doors
 * into the matcher read that as "say so in words", which is the half that used
 * to offer a client an instant the database then refused.
 *
 * The remainder is clipped at `now` — a span half gone is still worth a phone
 * call for what is left of it (A-067's bound 1), and a span wholly gone is
 * not. The RUN is not clipped: the engine is given `now` and applies the lead
 * time itself, and clipping here would be a second opinion about it. But the
 * run is CHOSEN against the clipped range (A-128), because a choice made
 * against the whole range can land on a part of it the afternoon has already
 * eaten.
 */
export async function freedSpanNow(
  db: Db,
  args: {
    businessId: string;
    providerId: string;
    timezone: string;
    /** The range that was freed, buffer-inclusive — what the exclusion
     *  constraint let go of. */
    blockedStart: Date;
    blockedEnd: Date;
    now: Date;
  },
): Promise<{ run: FreeRun; remainder: FreeRun } | null> {
  // The day the freed range STARTS on, in the salon's zone. A range that runs
  // past midnight is rare (the 23:30 booking) and its run is this day's
  // overnight window, which `resolveWindow` places across the boundary.
  const day = toLabel(fromDate(args.blockedStart), zoneId(args.timezone)).day;
  const runs = await freeRunsFor(db, {
    businessId: args.businessId,
    providerId: args.providerId,
    timezone: args.timezone,
    day,
  });

  // A-128 — THE RANGE THE RUNS ARE MEASURED AGAINST IS THE LIVE PART OF IT,
  // NOT THE WHOLE OF IT. The afternoon moves the freed range's start forward
  // exactly as a sale moves it, and the choice below has to see that or it
  // picks a run that stopped existing at lunchtime. With a Cut sold at 15:00
  // into a cancelled 13:05–16:40 balayage, at 15:05 the pre-clip range still
  // weighed the 13:05–15:00 morning stub at 115 minutes against the live
  // 15:55–17:00 run's 45, picked the stub, clipped it to nothing and returned
  // `null` — so the door said "this time has gone" and the matcher offered
  // nobody, while the same instants were sellable enough that a Cut booked at
  // 16:00. `null` has to mean the range is gone, never that its earliest part
  // is. (Clipping the RUN is still not done: the engine is given `now` and
  // applies the lead time itself.)
  const freedStart = Math.max(fromDate(args.blockedStart), fromDate(args.now));
  const freedEnd = fromDate(args.blockedEnd);
  if (freedEnd <= freedStart) return null;

  // THE RUN HOLDING THE MOST OF WHAT WAS FREED — not the longest run, and not
  // the first. A freed range can straddle a break or have a booking sold into
  // its middle, and then it touches two runs. Choosing by RUN length picked the
  // afternoon for a tail that ran 10:55–13:05 across a 12:00 lunch: the whole
  // afternoon overlaps it by five minutes, so the "remainder" was a 5-minute
  // sliver, fell under A-109's floor, and the row vanished — the exact defect
  // this file was written to remove, reached by a different road. Ties go to
  // the longer run, which is the bigger sale.
  let run: FreeRun | null = null;
  let best = 0;
  for (const candidate of runs) {
    const overlap = Math.min(fromDate(candidate.end), freedEnd) - Math.max(fromDate(candidate.start), freedStart);
    if (overlap <= 0) continue;
    if (run === null || overlap > best || (overlap === best && candidate.minutes > run.minutes)) {
      run = candidate;
      best = overlap;
    }
  }
  if (run === null) return null;

  const start = Math.max(fromDate(run.start), freedStart);
  const end = Math.min(fromDate(run.end), freedEnd);
  if (end <= start) return null;

  return {
    run,
    remainder: { start: toDate(instant(start)), end: toDate(instant(end)), minutes: (end - start) / MIN },
  };
}
