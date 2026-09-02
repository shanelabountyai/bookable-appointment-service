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
 * `rescheduled`, `provider_changed`, `services_changed`, `client_changed`,
 * `time_released`, `column_pushed`, `conflict_acknowledged`,
 * `hours_changed_underneath`.
 * A further event type is a compile error here rather than a raw enum on screen
 * — the same reflex as the status colour map, and the same reason: this is a
 * list that reads the log, and lists that read the log go stale silently.
 */
import type { AppointmentEventRow } from '@bookable/db/appointments';
import { type ZoneId, fromDate, instantFromIso, toLabel } from '@bookable/core/time';
import { reallyDelivered } from '@bookable/db/notifications';

export const EVENT_TYPES = [
  'booked',
  'override_booked',
  'status_changed',
  'status_corrected',
  'rescheduled',
  'provider_changed',
  'services_changed',
  'client_changed',
  'time_released',
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

/**
 * The actor as a name a sentence can end with — "by Priya", "by the front
 * desk". Exported so other logs that stamp `(actor, actorRef)` render the
 * SAME words rather than growing a second fallback table that drifts from
 * this one (A-052 reuses it for the availability screen's audit trail).
 *
 * `null` is the honest answer for a row written before an actor was ever
 * recorded — never coerced to "the front desk", which would claim knowledge
 * the row does not have.
 */
export function actorWord(actor: string | null, actorName: string | null): string | null {
  if (actorName) return actorName;
  if (!actor) return null;
  return ACTORS[actor] ?? actor;
}

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
  const who = actorWord(event.actor, event.actorName) ?? event.actor;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  return {
    id: event.id,
    when: `${label.day} ${label.time}`,
    sentence: sentenceFor(event.type as EventType, payload, who, zone),
    reason: event.reason,
    isCorrection: event.type === 'status_corrected',
  };
}

/** Payload arrays arrive as JSON, so they are `unknown` until proven
 *  otherwise — a log that throws on a malformed payload takes the whole
 *  screen with it. */
const asNames = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** "a cut", "a cut and a colour", "a cut, a colour and a blow-dry". */
const list = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

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
    // A-055. The sentence names WHAT changed rather than the new total: "what
    // did she have done?" is answered by the lines, and what the log is for is
    // the change nobody can otherwise see afterwards.
    case 'services_changed': {
      const added = asNames(payload.added);
      const removed = asNames(payload.removed);
      const parts = [
        added.length > 0 ? `added ${list(added)}` : '',
        removed.length > 0 ? `dropped ${list(removed)}` : '',
      ].filter(Boolean);
      const ends = `Now ends ${clock(payload.toEndAt, zone)}`;
      return `${who === 'the front desk' ? 'The front desk' : who} ${parts.join(' and ')}. ${ends}.`;
    }
    // A-068. ONE event type, three sentences — attach, change and detach are
    // one write, and the log has to say which of the three it was and who it
    // named on each side. "Moved off Sarah Jones" is the sentence that settles
    // "why is there a no-show on my client's record".
    case 'client_changed': {
      const from = typeof payload.fromClientName === 'string' ? payload.fromClientName : null;
      const to = typeof payload.toClientName === 'string' ? payload.toClientName : null;
      if (payload.fromClientId == null) return `Recorded as ${to ?? 'a client with no name'} by ${who}.`;
      if (payload.toClientId == null) return `Taken off ${from ?? "the client's record"} by ${who}.`;
      return `Moved from ${from ?? 'a client with no name'} to ${to ?? 'a client with no name'} by ${who}.`;
    }
    // A-069 (D-44). The sentence names the INSTANT rather than the minutes,
    // because "we gave up at 10:20" is what somebody is reading this log to
    // find out — the minutes are arithmetic anybody can redo.
    case 'time_released':
      // A-075. ONE type, two sentences — the release and its undo are one
      // column going back to where it was, not two unrelated facts, which is
      // the same reasoning `client_changed` above uses.
      return payload.restored === true
        ? `Her time was put back on the book by ${who} — she arrived after all.`
        : `Her remaining time was put back on the market by ${who}, from ${clock(payload.releasedAt, zone)}.`;
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
  // A-048's fifth state. "Sending" and "queued" are the same thing to the
  // front desk — she has not been told either way — so it reuses the spelling
  // rather than giving the screens a new word for the same decision.
  sending: 'queued',
  sent: 'sent',
  failed: 'failed to send',
  suppressed: 'not sent — no contact details on file',
};

/**
 * A-048 asks the ROW, not the build. `deliveredBy` is stamped by whichever
 * adapter handled it, so a message the console adapter "sent" last March still
 * reads "queued" after a real driver lands — which is the truth about that
 * message, and was not what the build-wide predicate said.
 */
export function deliveryWord(status: string, deliveredBy: string | null = null): string {
  // A `sent` row that no real driver touched never reached anybody. `pending`
  // — "queued" — is the true word for it, and reusing that spelling means the
  // screens gain no extra vocabulary for the same state.
  const honest = status === 'sent' && !reallyDelivered(deliveredBy) ? 'pending' : status;
  return DELIVERY_WORDS[honest] ?? honest;
}

export const TEMPLATE_WORDS: Record<string, string> = {
  'appointment.confirmed': 'Booking confirmation',
  'appointment.rescheduled': 'New time',
  'appointment.running_late': 'Running behind',
  // A-059. A pull-forward is the same action with the opposite sign, and it is
  // a different sentence to the client — "Running behind" on a message telling
  // her to come in twenty minutes EARLIER is the screen lying about what she
  // was sent.
  'appointment.moved_earlier': 'Brought forward',
  'appointment.reminder': 'Reminder',
  'appointment.services_changed': 'What she is having changed',
  'appointment.provider_changed': 'New stylist',
  'appointment.cancelled': 'Cancellation',
};
