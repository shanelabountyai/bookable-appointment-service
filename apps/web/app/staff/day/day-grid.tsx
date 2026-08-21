'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { GridColumn, GridItem, GridModel } from '@/lib/day/view-model';
import { STATUS_WORDS } from '@/lib/day/view-model';
import { ColumnControls } from './column-controls';
import { StatusActions } from './status-actions';

/**
 * The day grid (A-016, Goal 3).
 *
 * The client half does exactly two things: position what the server measured,
 * and keep it fresh. Every time on screen was formatted server-side in the
 * salon's zone — there is no `Date` in this file, deliberately.
 */

/**
 * Vertical scale. One minute of the salon's day is one and a half pixels:
 * a 45-minute cut is a chip tall enough to hold two lines of text.
 *
 * The greys below are zinc-600 rather than the zinc-400/500 that reads better
 * at a glance, because at 12px on white those measure 2.6:1 and 4.4:1 — both
 * under WCAG AA's 4.5:1, and axe said so before this shipped. Small grey text
 * is exactly where contrast quietly fails.
 */
const PX_PER_MINUTE = 1.5;

/**
 * The staleness bound the backlog asks for is 30 seconds, so the grid
 * re-reads every 15 — half the budget, which leaves room for a slow request
 * without the screen ever being older than promised.
 *
 * `router.refresh()` re-runs the server component, so the refresh path is the
 * SAME code as the first render. A client-side fetch-and-merge would be a
 * second way of building the grid, and the two would drift.
 */
const REFRESH_MS = 15_000;

export function DayGrid({ model }: { model: GridModel }) {
  useAutoRefresh();

  const height = model.totalMinutes * PX_PER_MINUTE;

  return (
    <div className="flex gap-2 overflow-x-auto">
      <div className="relative w-14 shrink-0" style={{ height }} aria-hidden="true">
        {model.ticks.map((tick) => (
          <span
            key={tick.label + tick.top}
            className="absolute right-1 -translate-y-1/2 text-xs text-zinc-600 dark:text-zinc-400"
            style={{ top: tick.top * PX_PER_MINUTE }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      {model.columns.map((column) => (
        <Column key={column.providerId} column={column} model={model} height={height} />
      ))}
    </div>
  );
}

function Column({ column, model, height }: { column: GridColumn; model: GridModel; height: number }) {
  return (
    <section
      className="min-w-52 flex-1"
      aria-label={`${column.providerName}${column.closed ? ', not working today' : ''}${column.runningLateMinutes ? `, running ${column.runningLateMinutes} minutes behind` : ''}`}
    >
      <h2 className="text-sm font-semibold">
        {column.providerName}
        {column.closed ? <span className="ml-2 font-normal text-zinc-500">off today</span> : null}
        {/* A-042 — the way INTO the booking panel that does not depend on
            there being a gap. Until this link, the only per-stylist door was a
            gap chip, so a fully booked column could not be booked into at all
            and BOOK-05's override was unreachable from any screen. No `at`:
            the panel lists the day's real times, refusals and all. */}
        <Link
          href={`/staff/book?provider=${column.providerId}&day=${model.day}`}
          className="ml-2 font-normal text-zinc-600 underline underline-offset-4 dark:text-zinc-400"
        >
          Book with {column.providerName}
        </Link>
      </h2>

      {column.closed ? null : (
        <ColumnControls
          providerId={column.providerId}
          providerName={column.providerName}
          day={model.day}
          runningLateMinutes={column.runningLateMinutes}
          pushFrom={column.pushFrom}
        />
      )}

      <div className="relative rounded-md border border-zinc-200 dark:border-zinc-800" style={{ height }}>
        {/* Working hours, shaded. Decorative: the same information is in every
            item's accessible name and in the column's own label. */}
        {column.windows.map((window, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="absolute inset-x-0 bg-zinc-50 dark:bg-zinc-900/50"
            style={{ top: window.top * PX_PER_MINUTE, height: window.minutes * PX_PER_MINUTE }}
          />
        ))}

        {model.ticks.map((tick) => (
          <div
            key={tick.top}
            aria-hidden="true"
            className="absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800/60"
            style={{ top: tick.top * PX_PER_MINUTE }}
          />
        ))}

        {/* DOM order is chronological (see the view model), so tab order and
            screen-reader order follow the day even though every item is
            absolutely positioned. */}
        <ol className="contents">
          {column.items.map((item) => (
            <Item key={item.key} item={item} />
          ))}
        </ol>

        {model.nowTop !== null ? (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-red-500"
            style={{ top: model.nowTop * PX_PER_MINUTE }}
          >
            <span className="sr-only">Now</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Item({ item }: { item: GridItem }) {
  const style = { top: item.top * PX_PER_MINUTE, height: Math.max(item.minutes * PX_PER_MINUTE, 18) };
  const shell = 'absolute inset-x-1 overflow-hidden rounded-sm px-2 py-1 text-xs';

  if (item.kind !== 'appointment') {
    const body = (
      <>
        <span className="font-medium">{item.title}</span>
        {item.detail ? <span className="ml-1 text-zinc-600 dark:text-zinc-400">{item.detail}</span> : null}
      </>
    );
    return (
      // A-030: a gap can now fall INSIDE an appointment — a colour's
      // developing time is real bookable provider time — so gaps paint above
      // appointment chips rather than under them. Without this the one gap the
      // desk most wants to click is the one hidden behind the colour.
      <li className={`${shell} ${item.kind === 'gap' ? 'z-10 ' : ''}${DECORATION[item.kind]}`} style={style}>
        {/* A-017 gave gaps somewhere to go, so they are links now. Breaks and
            absences stay plain text: there is nothing to do with a lunch
            break, and a focusable element that does nothing when activated is
            worse than no target at all. */}
        {item.href ? (
          <Link href={item.href} className="block h-full focus:outline-2 focus:outline-offset-2" aria-label={item.label}>
            {body}
          </Link>
        ) : (
          <span aria-label={item.label}>{body}</span>
        )}
      </li>
    );
  }

  const body = (
    <>
      <span className="block truncate font-medium">
        {item.time} {item.title}
      </span>
      {item.detail ? <span className="block truncate opacity-80">{item.detail}</span> : null}
      {/* APPT-03's projected start, BESIDE the scheduled time rather than
          instead of it: she was booked for 14:00 and her confirmation still
          says so. */}
      {item.projected ? (
        <span className="block truncate font-medium text-amber-900 dark:text-amber-200">→ likely {item.projected}</span>
      ) : null}
      {item.pinnedNote ? (
        // CLIENT-03's safety surface. Marked, not merely present: the front
        // desk has to be able to spot it without reading every chip.
        <span className="block truncate font-medium text-amber-900 dark:text-amber-200">⚑ {item.pinnedNote}</span>
      ) : null}
      {item.missed ? (
        <span className="block truncate font-medium text-amber-900 dark:text-amber-200">⚑ {item.missed}</span>
      ) : null}
      {item.isOverride ? <span className="block text-[10px] uppercase tracking-wide">override</span> : null}
    </>
  );

  const className = `${shell} border ${STATUS_COLOUR[item.status ?? 'booked']}`;

  /**
   * A-035 — THE ONE BUTTON THE CHIP HAS ROOM FOR.
   *
   * Check-in is the most frequent action in the salon and it cost four
   * interactions and two page loads; this makes it one tap on the surface the
   * desk is already looking at. It is `available[0]` — the next step through
   * the visit, from the §7 table — never a hardcoded status, so a chip already
   * checked in offers "Start" and one in the chair offers "Finish".
   *
   * WHY ONE AND NOT FOUR: this chip is `minutes * 1.5` pixels tall, and the
   * seeded fringe trim is ten minutes. A row of four buttons does not fit and
   * a chip taller than its duration would overlap the next client. The
   * stylist's own list has no such constraint and carries the whole set; the
   * link below still leads to the panel that carries everything.
   *
   * The height test is a geometry fact, not a rule about appointments: under
   * it, the chip is the link alone. Nothing becomes unreachable — it becomes
   * one tap further away, which is where every one of them was yesterday.
   */
  // Every line on a chip is truncated to exactly one line, so the space a
  // button needs is countable rather than guessable: the title line, plus one
  // per extra line already claimed. A chip clips what does not fit, and a
  // CLIPPED BUTTON is worse than an absent one — invisible to the eye and
  // still in the tab order.
  const linesInUse = [item.detail, item.projected, item.pinnedNote, item.missed, item.isOverride].filter(
    Boolean,
  ).length;
  const roomForAButton = item.minutes >= ONE_LINE_AND_A_BUTTON + linesInUse * MINUTES_PER_LINE;

  const controls =
    item.appointmentId && item.status && item.available?.length && roomForAButton ? (
      <StatusActions
        appointmentId={item.appointmentId}
        status={item.status}
        moves={item.available.slice(0, 1)}
        className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]"
        buttonClassName="rounded-sm border border-current px-1.5 py-0.5 font-medium disabled:opacity-60"
      />
    ) : null;

  return (
    <li className={className} style={style}>
      {/* The button is a SIBLING of the link, never inside it: a button nested
          in an anchor is invalid, and it is the accessibility footgun A-033
          named when it declined to put a second control on this chip. */}
      {item.href ? (
        <Link
          href={item.href}
          className={`block focus:outline-2 focus:outline-offset-2 ${controls ? '' : 'h-full'}`}
          aria-label={item.label}
        >
          {body}
        </Link>
      ) : (
        <span aria-label={item.label}>{body}</span>
      )}
      {controls}
    </li>
  );
}

/**
 * Chip geometry, in MINUTES because that is the unit the chip is measured in:
 * 30 minutes is 45 pixels at the scale above, which holds one line of text and
 * a control; each further line costs about ten more.
 */
const ONE_LINE_AND_A_BUTTON = 30;
const MINUTES_PER_LINE = 10;

/**
 * Status colours, as a TOTAL map — a ninth status is a compile error here
 * rather than an invisible chip on a Saturday.
 *
 * Colour is never the only signal: the status word is in every chip's
 * accessible name, and cancelled chips are struck through as well as faded, so
 * the grid does not depend on colour vision (WCAG 1.4.1).
 */
const STATUS_COLOUR = {
  booked: 'border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900',
  confirmed: 'border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950',
  checked_in: 'border-sky-400 bg-sky-50 dark:border-sky-700 dark:bg-sky-950',
  in_progress: 'border-sky-500 bg-sky-100 dark:border-sky-600 dark:bg-sky-900',
  completed: 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
  no_show: 'border-amber-500 bg-amber-50 dark:border-amber-700 dark:bg-amber-950',
  cancelled: 'border-zinc-300 bg-white text-zinc-600 line-through dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400',
  cancelled_late: 'border-zinc-300 bg-white text-zinc-600 line-through dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400',
} satisfies Record<keyof typeof STATUS_WORDS, string>;

const DECORATION: Record<Exclude<GridItem['kind'], 'appointment'>, string> = {
  gap: 'border border-dashed border-zinc-400 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
  break: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  absence: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
};

/** Re-reads the server component on a timer. An interval is a subscription to
 *  an external system (the clock), which is what effects are for. */
function useAutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);
}
