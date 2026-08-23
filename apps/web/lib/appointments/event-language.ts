import 'server-only';

/**
 * A-027 — THE EVENT LOG IN PLAIN LANGUAGE (APPT-07).
 *
 * "Rendered in plain language on the appointment detail" is the requirement,
 * and it is not decoration: this log is what settles an argument at the front
 * desk six weeks later. A row reading `status_changed {"from":"booked","to":
 * "no_show"}` is a database record; "Marked as a no-show by the front desk" is
 * an answer.
 *
 * TOTAL OVER EVERY TYPE THE CODEBASE WRITES, and typed so it stays that way:
 * `booked`, `override_booked`, `status_changed`, `status_corrected`,
 * `rescheduled`, `provider_changed`, `column_pushed`, `conflict_acknowledged`.
 * A ninth event type is a compile error here rather than a raw enum on screen
 * — the same reflex as the status colour map, and the same reason: this is a
 * list that reads the log, and lists that read the log go stale silently.
 */
import type { AppointmentEventRow } from '@bookable/db/appointments';
import { type ZoneId, fromDate, instantFromIso, toLabel } from '@bookable/core/time';
import { notificationsReallySend } from '@bookable/db/notifications';

export const EVENT_TYPES = [
  'booked',
  'override_booked',
  'status_changed',
  'status_corrected',
  'rescheduled',
  'provider_changed',
  'column_pushed',
  'conflict_acknowledged',
  'hours_changed_underneath',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Who did it when there is no name — D-9's actor, read aloud. A-037 gave
 *  staff events a real name; these remain the fallback for a customer's own
 *  link, for the system, and for events stamped before anybody was named. */
const ACTORS: Record<string, string> = {
  staff: 'the front desk',
  customer_token: 'the client, using her link',
  system: 'the system',
};

const STATUS_WORDS: Record<string, string> = {
  booked: 'booked',
  confirmed: 'confirmed',
  checked_in: 'checked in',
  in_progress: 'in progress',
  completed: 'completed',
  no_show: 'a no-show',
  cancelled: 'cancelled',
  cancelled_late: 'cancelled late',
};

export interface ReadableEvent {
  id: string;
  when: string;
  sentence: string;
  reason: string | null;
  /** A correction is a different KIND of fact from a status change — "we got
   *  this wrong" rather than "this happened" — and it renders differently. */
  isCorrection: boolean;
}

export function toReadableEvent(event: AppointmentEventRow, zone: ZoneId): ReadableEvent {
  const label = toLabel(fromDate(event.createdAt), zone);
  // A-037: the name if the log knows one. "Changed to checked in by Priya" is
  // the answer; "by the front desk" was four people and a shrug.
  const who = event.actorName ?? ACTORS[event.actor] ?? event.actor;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  return {
    id: event.id,
    when: `${label.day} ${label.time}`,
    sentence: sentenceFor(event.type as EventType, payload, who, zone),
    reason: event.reason,
    isCorrection: event.type === 'status_corrected',
  };
}

function sentenceFor(type: EventType, payload: Record<string, unknown>, who: string, zone: ZoneId): string {
  switch (type) {
    case 'booked':
      return `Booked by ${who}.${overFlag(payload)}`;
    case 'override_booked':
      // BOOK-05's marker, in the log as well as on the appointment: an
      // override nobody can explain is one staff learn to ignore.
      return `Booked by ${who} as an override.${overFlag(payload)}`;
    case 'status_changed':
      return `Changed from ${word(payload.from)} to ${word(payload.to)} by ${who}.`;
    case 'status_corrected':
      return `Corrected from ${word(payload.from)} to ${word(payload.to)} by ${who}.`;
    case 'rescheduled':
      return `Moved from ${clock(payload.from, zone)} to ${clock(payload.to, zone)} by ${who}.`;
    case 'provider_changed':
      return `Handed to another stylist by ${who}.`;
    case 'column_pushed':
      return `Pushed ${String(payload.minutes ?? '')} minutes later by ${who}, with the day running behind.`;
    case 'conflict_acknowledged':
      return `Kept despite a clash, by ${who}.`;
    // A-047. The availability row that carried the actor is gone — a delete
    // takes it with it — so this is where "who did that?" survives, on the
    // appointment it stranded.
    case 'hours_changed_underneath':
      return `${HOURS_CHANGE[String(payload.change)] ?? 'The working hours changed'} by ${who}, leaving this one outside them.`;
  }
}

const HOURS_CHANGE: Record<string, string> = {
  weekly_window_added: 'Weekly hours were added',
  weekly_window_removed: 'The weekly hours this sat in were removed',
  override_saved: 'The hours for this day were changed',
  override_removed: 'The one-off hours for this day were removed',
};

const word = (status: unknown): string => STATUS_WORDS[String(status)] ?? String(status);

/**
 * D-27's record: the desk booked her while the no-show flag was showing.
 *
 * A CLAUSE on the booking event rather than an event of its own — it is not a
 * separate thing that happened, it is a fact about this booking, and a
 * standalone row would sit in the log next to "Booked by the front desk"
 * saying almost the same thing.
 */
function overFlag(payload: Record<string, unknown>): string {
  const flag = payload.overNoShowFlag as { noShows?: unknown } | undefined;
  if (!flag) return '';
  return ` Booked over the no-show flag (${String(flag.noShows)} in the last 12 months).`;
}

/** An instant from a payload, in the salon's zone. Payloads carry ISO strings
 *  with offsets (D-4) — never a `{date, time}` pair — so this is a lookup, not
 *  a guess. */
function clock(iso: unknown, zone: ZoneId): string {
  try {
    const label = toLabel(instantFromIso(String(iso)), zone);
    return `${label.day} ${label.time}`;
  } catch {
    return 'an earlier time';
  }
}

/**
 * Operator R-4's answer to "was she actually told?" — the outbox row's fate,
 * in words rather than an enum.
 *
 * A-044: `sent` is not the same claim as "she has a text". Until a real driver
 * exists (D-14) every send is a line on the server console, and a screen that
 * says "Told: Cancellation — sent" is read by staff as "no need to call her".
 * `deliveryWord()` is what every surface goes through, so that reading cannot
 * be fixed on one screen and left standing on the other — the map itself is no
 * longer exported, which is what makes that structural rather than a habit.
 */
const DELIVERY_WORDS: Record<string, string> = {
  pending: 'queued',
  sent: 'sent',
  failed: 'failed to send',
  suppressed: 'not sent — no contact details on file',
};

export function deliveryWord(status: string): string {
  // With no real driver, a `sent` row never reached anybody. `pending` —
  // "queued" — is the true word for it, and reusing that spelling means the
  // screens gain no fourth vocabulary for the same state.
  const honest = status === 'sent' && !notificationsReallySend ? 'pending' : status;
  return DELIVERY_WORDS[honest] ?? honest;
}

export const TEMPLATE_WORDS: Record<string, string> = {
  'appointment.confirmed': 'Booking confirmation',
  'appointment.rescheduled': 'New time',
  'appointment.running_late': 'Running behind',
  'appointment.reminder': 'Reminder',
  'appointment.provider_changed': 'New stylist',
  'appointment.cancelled': 'Cancellation',
};
