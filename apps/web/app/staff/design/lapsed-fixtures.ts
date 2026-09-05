import type { CallMark } from '@bookable/db/clients';
import type { LapsedClient } from '@bookable/db/reports';
import { calendarDay, fromDate, instant, resolve, toDate, wallTime, zoneId } from '@bookable/core/time';

/**
 * A-092 — §8.6a's composition, as plain data.
 *
 * "`/staff/dashboard/lapsed` — a long list of rows that are each a phone call
 * waiting to be made… it will be thirty rows long; the row needs to survive
 * that."
 *
 * HAND-BUILT, and for a second reason on top of A-091's (checkpoint 7 measured
 * a demo install with zero call marks anywhere, so the half of the row that
 * only appears once somebody has started working the list renders on nobody's
 * screen — A-095). The first is arithmetic: `listLapsedClients` needs a client
 * with a completed visit and nothing in the book, so THIRTY of them is thirty
 * clients and thirty appointments in the seed, and the gallery would then be
 * showing the seed's opinion of the report rather than the row's states.
 *
 * `NOW` IS FROZEN and every instant is derived from it by integer arithmetic,
 * so `weeksSince` and `isCallStale` are the same numbers in `TZ=UTC` and
 * `TZ=Pacific/Kiritimati` — the same rule every engine test follows.
 */
export const LAPSED_ZONE = 'America/Chicago';
export const LAPSED_WINDOW_WEEKS = 12;

const DAY = '2026-11-19';
const WEEK_MS = 7 * 86_400_000;

function at(time: string): Date {
  const resolution = resolve(calendarDay(DAY), wallTime(time), zoneId(LAPSED_ZONE));
  if (resolution.kind !== 'unique') throw new Error(`${DAY} ${time} is not unique in ${LAPSED_ZONE}`);
  return toDate(resolution.at);
}

/** The gallery's "today". Everything below is `NOW` minus a whole number of
 *  weeks, so no row's age can drift with the wall clock. */
export const LAPSED_NOW = at('14:00');

const weeksAgo = (weeks: number): Date => toDate(instant(fromDate(LAPSED_NOW) - weeks * WEEK_MS));

function mark(outcome: CallMark['outcome'], weeks: number, by: string | null): CallMark {
  return {
    clientId: '',
    clientName: null,
    outcome,
    calledByName: by,
    calledAt: weeksAgo(weeks),
  };
}

/**
 * THIRTY ROWS, because the length IS the state under test — the row that reads
 * well on its own is not the thing §8.6a asked for. The first six are the
 * states that differ; the rest are filler at the same shape, so the page
 * measures the real height (5044px on a 1024×768 tablet before this item) and
 * the phone target can be measured at the BOTTOM of the list as well as the
 * top.
 */
const SHAPES: {
  name: string | null;
  phone: string | null;
  weeks: number;
  services: string[];
  spendCents: number;
  mark: CallMark | undefined;
}[] = [
  // Never rung: the row in its resting state, and most of a fresh list.
  { name: 'Marguerite Okonkwo-Ferreira', phone: '512 555 0142', weeks: 47, services: ['Colour', 'Cut & finish'], spendCents: 21500, mark: undefined },
  // Rung this week — handled, and it has to read as handled at a glance.
  { name: 'Bea Nakamura', phone: '512 555 0117', weeks: 31, services: ['Cut'], spendCents: 5500, mark: mark('left_message', 1, 'Priya') },
  // Rung, and the call has gone stale on the report's OWN window (A-077).
  { name: 'Hal Whitcombe', phone: '512 555 0163', weeks: 28, services: ['Cut', 'Beard trim'], spendCents: 7000, mark: mark('no_answer', 20, 'Dana') },
  // Still deciding: the one the second person at the desk must not re-ring.
  { name: 'Ines Okafor', phone: '512 555 0108', weeks: 22, services: ['Balayage'], spendCents: 28000, mark: mark('thinking', 2, 'Priya') },
  // No number at all — the row whose whole reason for existing is missing.
  { name: 'Walk-in, no number', phone: null, weeks: 19, services: ['Cut'], spendCents: 5500, mark: undefined },
  // No name and no caller on the mark: both nullable, both on one row.
  { name: null, phone: '512 555 0190', weeks: 17, services: ['Fringe trim'], spendCents: 1500, mark: mark('took_it', 3, null) },
];

const FILLER_NAMES = [
  'Anouk Delacroix', 'Bo Trần', 'Cassandra Villalobos', 'Dev Ramanathan', 'Elke Bergström',
  'Fionnuala Mac Giolla', 'Gus Andersson', 'Hyun-woo Park', 'Imogen Achterberg', 'Jarrah Whitlock',
  'Kwame Osei-Bonsu', 'Lucía Fernández', 'Mattias Kowalczyk', 'Nadia El-Amin', 'Oisín Ó Súilleabháin',
  'Petra Novotná', 'Quinn Adeyemi', 'Rosalind Featherstonehaugh', 'Sunniva Haugen', 'Tobias Lindqvist',
  'Ursula Mbeki', 'Viktor Ivanov', 'Willa Ashcroft', 'Xochitl Ramírez',
];

export const LAPSED_ROWS: { row: LapsedClient; mark: CallMark | undefined }[] = [
  ...SHAPES,
  ...FILLER_NAMES.map((name, i) => ({
    name,
    phone: `512 555 ${String(200 + i).padStart(4, '0')}`,
    weeks: 16 - Math.floor(i / 2),
    services: i % 3 === 0 ? ['Colour', 'Cut & finish'] : ['Cut'],
    spendCents: i % 3 === 0 ? 19500 : 5500,
    mark: i % 5 === 0 ? mark('left_message', 1, 'Dana') : undefined,
  })),
/**
 * THE IDS ARE EMPTY, which is A-091's fixture precedent and the same reason:
 * the row's call marks are a live `<form>`, and a press on the workbench must
 * not write a mark against a client who does not exist. `recordOffer` refuses a
 * blank `clientId` and says so in its own live region, so the data is what says
 * the row is not real. Keyed by index below for the same reason.
 */
].map((shape, i) => ({
  row: {
    clientId: '',
    name: shape.name,
    phone: shape.phone,
    lastVisitAt: weeksAgo(shape.weeks),
    weeksSince: shape.weeks,
    lastProviderName: i % 2 === 0 ? 'Dana' : 'Priya',
    lastServiceNames: shape.services,
    lastSpendCents: shape.spendCents,
    lastAppointmentId: '',
  },
  mark: shape.mark,
}));
