import type { OpenedSlot } from '@bookable/db/appointments';
import type { CallMark } from '@bookable/db/clients';
import { calendarDay, resolve, toDate, wallTime, zoneId } from '@bookable/core/time';

/**
 * A-091 — §8.6's composition, as plain data.
 *
 * "`/staff/opened` composed with all five `freedBy` kinds visible at once, one
 * of them already carrying two call marks."
 *
 * HAND-BUILT, for A-090's reason one item on: a gallery that reads the book
 * shows whatever the book happens to hold, and checkpoint 7 measured a demo
 * install with **zero call marks and zero call-down attempts** — so the mark
 * line, which is the half of this row that stops the second person at the desk
 * ringing Mrs Patel twice, renders on nobody's screen (A-095). Five kinds and
 * two marks are the states the component has to survive.
 *
 * ONE ZONE AND ONE FIXED DAY, converted by the only module allowed to convert
 * (CLAUDE.md): no `new Date(string)`, no clock, and therefore the same five
 * rows in `TZ=UTC` and `TZ=Pacific/Kiritimati`.
 */
export const FIXTURE_ZONE = 'America/Chicago';

/** A Thursday in the middle of nothing — no DST transition near it, because
 *  the ambiguity suffix is `InstantLabel`'s state matrix and not this one's. */
const DAY = '2026-11-19';

function at(time: string): Date {
  const resolution = resolve(calendarDay(DAY), wallTime(time), zoneId(FIXTURE_ZONE));
  if (resolution.kind !== 'unique') throw new Error(`${DAY} ${time} is not unique in ${FIXTURE_ZONE}`);
  return toDate(resolution.at);
}

let seq = 0;

function slot(item: Partial<OpenedSlot> & { startTime: string; freedBy: OpenedSlot['freedBy'] }): OpenedSlot {
  const { startTime, ...rest } = item;
  const startAt = at(startTime);
  return {
    key: `fixture-${(seq += 1)}`,
    appointmentId: `appointment-${seq}`,
    providerId: 'dana',
    providerName: 'Dana',
    startAt,
    blockedStart: startAt,
    blockedEnd: startAt,
    freedMinutes: 45,
    primaryServiceId: 'cut',
    serviceNames: ['Cut'],
    status: 'cancelled',
    clientName: 'Mrs Hall',
    clientPhone: '512 555 0142',
    ...rest,
  };
}

/** The two marks §8.6 asks for, on one row: one still deciding and one who
 *  said yes. The second is the one the desk has to see BEFORE dialling, which
 *  is why it is the only mark that carries an ink of its own. */
const TWO_MARKS: CallMark[] = [
  {
    clientId: 'patel',
    clientName: 'Mrs Patel',
    outcome: 'thinking',
    calledByName: 'Priya',
    calledAt: at('14:10'),
  },
  {
    clientId: 'hart',
    clientName: 'Jo Hart',
    outcome: 'took_it',
    calledByName: 'Dana',
    calledAt: at('16:05'),
  },
];

/** All five kinds, in the order `FreedBy` declares them. */
export const FREED_SLOTS: { slot: OpenedSlot; marks: CallMark[] }[] = [
  {
    slot: slot({
      startTime: '09:30',
      freedBy: { kind: 'cancelled' },
      status: 'cancelled_late',
      clientName: 'Ada Chen',
      serviceNames: ['Cut', 'Blow-dry'],
      freedMinutes: 75,
    }),
    // The row §8.6 names: two calls already made about one span.
    marks: TWO_MARKS,
  },
  {
    slot: slot({
      startTime: '11:00',
      freedBy: { kind: 'shortened', droppedServiceNames: ['Colour', 'Blow-dry'] },
      status: 'booked',
      freedMinutes: 120,
      serviceNames: ['Colour'],
      primaryServiceId: 'colour',
    }),
    marks: [],
  },
  {
    slot: slot({
      startTime: '13:15',
      freedBy: { kind: 'rescheduled', movedToStartAt: at('16:30') },
      status: 'booked',
      clientName: 'Nadia Okafor',
      providerName: 'Priya',
      providerId: 'priya',
    }),
    marks: [],
  },
  {
    slot: slot({
      startTime: '15:00',
      freedBy: { kind: 'reassigned', movedToProviderName: 'Marcus' },
      status: 'booked',
      clientName: 'Tomas Reyes',
      freedMinutes: 60,
    }),
    marks: [],
  },
  {
    slot: slot({
      startTime: '16:45',
      freedBy: { kind: 'released' },
      status: 'no_show',
      // The walk-in with no number: the row still has to work with neither a
      // name nor a `tel:` link on it.
      clientName: null,
      clientPhone: null,
      // No seed service, so no matcher link either — the row's other half has
      // to hold up on its own.
      primaryServiceId: null,
      freedMinutes: 90,
    }),
    marks: [],
  },
];
