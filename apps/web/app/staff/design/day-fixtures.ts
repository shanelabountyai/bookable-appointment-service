import type { GridItem, GridModel } from '@/lib/day/view-model';

/**
 * A-090 — THE FOUR DAYS §8.5 ASKS FOR, as plain data.
 *
 * "`/staff/day` fully composed, at: four stylists, one stylist, a column
 * running forty minutes late, and a day with a stylist off."
 *
 * HAND-BUILT, NOT SEEDED, and that is the point rather than a shortcut. A
 * gallery that reads the database shows whatever happens to be in the book
 * this morning — which for the three interesting compositions is nothing at
 * all, because the demo install has no running-late column and no stylist off
 * (checkpoint 7 measured exactly that, and A-095 is the row for it). These four
 * are the states the component has to survive, pinned so they are on the screen
 * every time anybody opens the page and every time the e2e spec runs axe over
 * it.
 *
 * NO CLOCK AND NO ZONE. Every label here is a literal string, because
 * `toGridModel` is the only thing allowed to turn an instant into a wall time
 * (CLAUDE.md) and a fixture that re-derives one would be a second conversion
 * for a lint rule to catch. These are the OUTPUT of that conversion, typed as
 * what the component consumes.
 *
 * `appointmentId` AND `available` are deliberately absent on every item, which
 * is what stops the one status button rendering against an invented row. That
 * is the data saying so rather than a `gallery` flag on the component saying
 * it — a prop with one caller is a second source of truth for a fact the item
 * already carries.
 */

/** 09:00 as minute 0; the grid runs to 18:00. */
const HOURS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];

const ticks = HOURS.map((label, i) => ({ top: i * 60, label }));
const windows = [{ top: 0, minutes: 540 }];
/** A-093 — the same hours in words, the way the printed sheet says them. */
const hours = ['09:00–18:00'];

let seq = 0;

/**
 * One chip. `minutes` is the ENVELOPE the chip is drawn at and `startTime` is
 * its first line — the two the real model computes separately, kept separate
 * here so the fixture cannot accidentally prove something the product does not.
 */
function chip(item: Partial<GridItem> & { top: number; minutes: number; startTime: string; title: string }): GridItem {
  const { top, minutes, startTime, title, ...rest } = item;
  return {
    key: `fixture-${(seq += 1)}`,
    kind: 'appointment',
    top,
    minutes,
    startTime,
    time: `${startTime}–?`,
    title,
    status: 'booked',
    // The accessible name is what §4 calls the risk on a running-late chip, so
    // the fixture writes real ones: the gallery is axe'd, and a chip whose name
    // is "undefined" would pass axe and prove nothing.
    label: `${startTime}, ${title}`,
    ...rest,
  };
}

function column(over: Partial<GridModel['columns'][number]> & { providerName: string }): GridModel['columns'][number] {
  return {
    providerId: over.providerName.toLowerCase(),
    closed: false,
    runningLateMinutes: null,
    calls: [],
    pushFrom: null,
    items: [],
    windows,
    hours,
    ...over,
  };
}

function model(over: Partial<GridModel> & { columns: GridModel['columns'] }): GridModel {
  return {
    day: '2026-06-09',
    dayLabel: 'Tuesday 9 June',
    totalMinutes: 540,
    ticks,
    nowTop: null,
    room: [],
    ...over,
  };
}

/** §8.5.1 — four stylists, the tablet's real shape. */
export const FOUR_STYLISTS = model({
  nowTop: 195,
  columns: [
    column({
      providerName: 'Dana',
      items: [
        chip({ top: 0, minutes: 45, startTime: '09:00', title: 'Ada Chen', detail: 'Cut · 5125550101', status: 'completed' }),
        chip({ top: 60, minutes: 90, startTime: '10:00', title: 'Mei Chen', detail: 'Colour · 5125550101', status: 'in_progress' }),
        chip({ top: 180, minutes: 45, startTime: '12:00', title: 'Rae Whitfield', detail: 'Cut & finish', status: 'checked_in' }),
        chip({ top: 300, minutes: 60, startTime: '14:00', title: 'Tom Byrne', detail: 'Root touch-up', status: 'confirmed' }),
      ],
    }),
    column({
      providerName: 'Priya',
      items: [
        chip({ top: 30, minutes: 120, startTime: '09:30', title: 'Marcy Dunn', detail: 'Balayage', status: 'completed' }),
        chip({
          top: 210,
          minutes: 45,
          startTime: '12:30',
          title: 'Ellie Dunn',
          detail: 'Cut · 5125550107',
          pinnedNote: 'Allergic to PPD.',
        }),
        chip({ top: 285, minutes: 60, startTime: '13:45', title: 'Sam Okafor', detail: 'Treatment', visitNote: '6.3 + 20 vol, 35 min.' }),
      ],
    }),
    column({
      providerName: 'Marcus',
      items: [
        chip({ top: 45, minutes: 30, startTime: '09:45', title: 'Walk-in, no name', detail: 'Fringe trim', status: 'no_show' }),
        chip({ top: 150, minutes: 75, startTime: '11:30', title: 'Nadia Rahman', detail: 'Cut & finish', isOverride: true }),
        {
          key: 'fixture-break',
          kind: 'break',
          top: 240,
          minutes: 30,
          time: '13:00–13:30',
          title: 'Break',
          label: 'Break, 13:00–13:30',
        },
      ],
    }),
    column({
      providerName: 'Tess',
      items: [
        chip({ top: 0, minutes: 45, startTime: '09:00', title: 'Jenny Moore', detail: 'Blow-dry', status: 'cancelled' }),
        {
          key: 'fixture-gap',
          kind: 'gap',
          top: 60,
          minutes: 120,
          time: '10:00–12:00',
          title: '120 minutes free',
          label: 'Book 120 minutes free, 10:00–12:00, with Tess',
          href: '/staff/design',
        },
        chip({ top: 195, minutes: 60, startTime: '12:15', title: 'Alice Hall', detail: 'Colour', missed: '2 no-shows in the last 12 months' }),
      ],
    }),
  ],
});

/** §8.5.2 — one stylist, which is what the desk filters to on a quiet Monday
 *  and what a stylist opens on her own phone. */
export const ONE_STYLIST = model({ columns: [FOUR_STYLISTS.columns[0]!] });

/**
 * §8.5.3 — A COLUMN FORTY MINUTES BEHIND, the composition this item's row calls
 * the risk.
 *
 * Every chip that has not started yet carries BOTH times. `in_progress` is in
 * the column and deliberately carries only one: she is in the chair, so a
 * projected START on her would be wrong rather than late — which is the
 * boundary `AWAITING_START_STATUSES` draws and the reason it is not
 * `PUSHABLE_STATUSES`. The `completed` chip above her is the other boundary.
 */
export const RUNNING_FORTY_LATE = model({
  columns: [
    column({
      providerName: 'Dana',
      runningLateMinutes: 40,
      pushFrom: '2026-06-09T18:00:00.000Z',
      calls: [
        {
          appointmentId: 'fixture-call-1',
          clientName: 'Rae Whitfield',
          phone: '5125550104',
          scheduled: '12:00',
          projected: '12:40',
          href: '/staff/design',
        },
        {
          appointmentId: 'fixture-call-2',
          clientName: 'Tom Byrne',
          phone: '5125550106',
          scheduled: '14:00',
          projected: '14:40',
          href: '/staff/design',
          told: 'Told at 11:12 by Sam',
        },
      ],
      items: [
        chip({ top: 0, minutes: 45, startTime: '09:00', title: 'Ada Chen', detail: 'Cut', status: 'completed' }),
        chip({ top: 60, minutes: 90, startTime: '10:00', title: 'Mei Chen', detail: 'Colour', status: 'in_progress' }),
        chip({
          top: 180,
          minutes: 45,
          startTime: '12:00',
          title: 'Rae Whitfield',
          detail: 'Cut & finish',
          status: 'checked_in',
          projected: '12:40',
          label: 'Rae Whitfield, Cut & finish, Checked in, booked for 12:00, likely to start 12:40',
        }),
        chip({
          top: 300,
          minutes: 60,
          startTime: '14:00',
          title: 'Tom Byrne',
          detail: 'Root touch-up',
          status: 'confirmed',
          projected: '14:40',
          label: 'Tom Byrne, Root touch-up, Confirmed, booked for 14:00, likely to start 14:40',
        }),
        chip({
          top: 375,
          minutes: 45,
          startTime: '15:15',
          title: 'Alice Hall',
          detail: 'Blow-dry',
          projected: '15:55',
          label: 'Alice Hall, Blow-dry, Booked, booked for 15:15, likely to start 15:55',
        }),
      ],
    }),
  ],
});

/** §8.5.4 — a day with a stylist off. The column is still drawn, because a
 *  missing column reads as a missing stylist rather than a day off. */
export const A_STYLIST_OFF = model({
  columns: [
    FOUR_STYLISTS.columns[0]!,
    column({ providerName: 'Priya', closed: true, windows: [] }),
    column({
      providerName: 'Marcus',
      items: [
        {
          key: 'fixture-absence',
          kind: 'absence',
          top: 120,
          minutes: 180,
          time: '11:00–14:00',
          title: 'Time off',
          detail: 'Dentist',
          label: 'Time off, 11:00–14:00, Dentist',
        },
        chip({ top: 330, minutes: 60, startTime: '14:30', title: 'Nadia Rahman', detail: 'Cut' }),
      ],
    }),
  ],
});

/** One of each status, at the same size, so the eight can be compared. The
 *  modifiers below them are drawn on `booked`, which is the ground every one of
 *  them is most often seen against. */
export const STATUS_MATRIX: GridItem[] = [
  chip({ top: 0, minutes: 45, startTime: '10:00', title: 'Ada Chen', detail: 'Cut · 5125550101' }),
  chip({ top: 0, minutes: 45, startTime: '10:00', title: 'Ada Chen', detail: 'Cut · 5125550101', status: 'confirmed' }),
  chip({ top: 0, minutes: 45, startTime: '10:00', title: 'Ada Chen', detail: 'Cut · 5125550101', status: 'checked_in' }),
  chip({ top: 0, minutes: 45, startTime: '10:00', title: 'Ada Chen', detail: 'Cut · 5125550101', status: 'in_progress' }),
  chip({ top: 0, minutes: 45, startTime: '10:00', title: 'Ada Chen', detail: 'Cut · 5125550101', status: 'completed' }),
  chip({ top: 0, minutes: 45, startTime: '10:00', title: 'Ada Chen', detail: 'Cut · 5125550101', status: 'no_show' }),
  chip({ top: 0, minutes: 45, startTime: '10:00', title: 'Ada Chen', detail: 'Cut · 5125550101', status: 'cancelled' }),
  chip({ top: 0, minutes: 45, startTime: '10:00', title: 'Ada Chen', detail: 'Cut · 5125550101', status: 'cancelled_late' }),
];

/** The five modifiers §5.4.1 lists, each on its own chip so the matrix is
 *  states × modifiers rather than one chip carrying all of them at once — which
 *  is the only composition that never happens in a salon. */
export const MODIFIER_MATRIX: { caption: string; item: GridItem }[] = [
  {
    caption: 'override',
    item: chip({ top: 0, minutes: 60, startTime: '10:00', title: 'Ada Chen', detail: 'Cut', isOverride: true }),
  },
  {
    caption: 'pinned client note',
    item: chip({ top: 0, minutes: 60, startTime: '10:00', title: 'Ada Chen', detail: 'Cut', pinnedNote: 'Allergic to PPD.' }),
  },
  {
    caption: 'note about today',
    item: chip({ top: 0, minutes: 60, startTime: '10:00', title: 'Ada Chen', detail: 'Cut', visitNote: '6.3 + 20 vol, 35 min.' }),
  },
  {
    caption: 'reliability flag',
    item: chip({
      top: 0,
      minutes: 60,
      startTime: '10:00',
      title: 'Ada Chen',
      detail: 'Cut',
      missed: '2 no-shows in the last 12 months',
    }),
  },
  {
    caption: 'running late — both times',
    item: chip({
      top: 0,
      minutes: 60,
      startTime: '10:00',
      title: 'Ada Chen',
      detail: 'Cut',
      projected: '10:40',
      label: 'Ada Chen, Cut, Booked, booked for 10:00, likely to start 10:40',
    }),
  },
  {
    caption: 'time given back (A-069)',
    item: chip({
      top: 0,
      minutes: 60,
      startTime: '10:00',
      title: 'Ada Chen',
      detail: 'Cut',
      status: 'no_show',
      released: '10:15',
    }),
  },
];
