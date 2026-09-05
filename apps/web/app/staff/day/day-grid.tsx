'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PX_PER_MINUTE } from '@/lib/day/scale';
import type { GridColumn, GridItem, GridModel } from '@/lib/day/view-model';
import { AppointmentChip, CHIP_SHELL } from './appointment-chip';
import { ColumnControls } from './column-controls';

/**
 * The day grid (A-016, Goal 3).
 *
 * The client half does exactly two things: position what the server measured,
 * and keep it fresh. Every time on screen was formatted server-side in the
 * salon's zone — there is no `Date` in this file, deliberately.
 */

/**
 * Vertical scale — one minute is one and a half pixels, so a 45-minute cut is
 * a chip tall enough to hold two lines of text. Shared with the room strip
 * (A-046) from `lib/day/scale`.
 *
 * A-090: every colour on this file is now a token (A-088). The greys it used
 * to hard-code were zinc-600 rather than the zinc-400/500 that reads better at
 * a glance, because at 12px those measure 2.6:1 and 4.4:1 — the reasoning is
 * now `--ink-muted`'s, asserted by `tokens.test.ts` instead of repeated here.
 */

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

export function DayGrid({ model, live = true }: { model: GridModel; live?: boolean }) {
  // `live` is off in the gallery only (A-090). Four grids on `/staff/design`
  // each holding a 15-second `router.refresh()` would reload the workbench
  // under whoever is reading it, and the fixtures cannot change anyway.
  useAutoRefresh(live);

  const height = model.totalMinutes * PX_PER_MINUTE;

  return (
    /**
     * A-090 — ONE GRID, TWO ROWS, AND THAT IS WHAT MAKES THE TIME AXIS SHARED.
     *
     * This was a flex row of independent columns, each of which laid out its own
     * header, then its own controls, and THEN its positioned box — so every
     * column's minute zero sat wherever its own chrome happened to end. Measured
     * on a seeded Tuesday with nothing running late:
     *
     *     gutter 380 | Dana 480 | Priya 480 | Marcus 438 | Tess 438
     *
     * The hour labels were **100px — 67 minutes — above the rows they label**,
     * and Marcus and Tess were drawn **42px (28 minutes) above** their two
     * colleagues, because a column with nothing left in it renders no "push the
     * column" control and its chrome is shorter. A day grid whose columns do not
     * share a vertical axis is not a day grid: "who is free at two?" is a
     * question you answer by looking ACROSS, and the answer was off by half an
     * hour, differently per column, according to the data.
     *
     * The fix is structural rather than a measurement anybody has to maintain:
     * a two-row grid, with every column a `subgrid` spanning both. Row one takes
     * the height of the TALLEST chrome — a column running late with a ring-round
     * on it is much taller than an empty one — and every row-two cell therefore
     * starts on the same pixel, the gutter included. No JavaScript, no measuring,
     * and nothing to keep in step: a column that grows a new control cannot
     * shift its own minute zero any more, because it no longer owns it.
     */
    // Same tab stop as the room strip, for the same reason: a day where every
    // provider is off has no gap chips and no appointments, so this box holds
    // nothing focusable and a keyboard cannot scroll it.
    <div tabIndex={0} className="grid grid-flow-col auto-cols-[minmax(13rem,1fr)] grid-rows-[auto_auto] gap-x-2 overflow-x-auto">
      <div className="row-span-2 grid w-14 shrink-0 grid-rows-subgrid" aria-hidden="true">
        {/* Row one: the gutter has no chrome of its own and takes whatever
            height the tallest column's does. */}
        <div />
        {/* `data-day-axis` is a TEST HOOK and says so: `day-grid.spec.ts`
            asserts that every element carrying it starts on the same pixel.
            A structural locator ("the last div of the section") would go on
            passing while pointing at the wrong box the first time anybody
            wraps something — A-085 lost a whole server-side check to exactly
            that, and a locator that names what it wants cannot drift. */}
        <div data-day-axis="gutter" className="relative" style={{ height }}>
          {model.ticks.map((tick) => (
            <span
              key={tick.label + tick.top}
              className="absolute right-1 -translate-y-1/2 text-caption text-ink-muted numeric"
              style={{ top: tick.top * PX_PER_MINUTE }}
            >
              {tick.label}
            </span>
          ))}
        </div>
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
      className="row-span-2 grid grid-rows-subgrid"
      aria-label={`${column.providerName}${column.closed ? ', not working today' : ''}${column.runningLateMinutes ? `, running ${column.runningLateMinutes} minutes behind` : ''}`}
    >
      {/* ROW ONE — everything above the day. Wrapped, so that however much of
          it a column happens to have, its box below still starts where every
          other column's does. */}
      <div>
      <h2 className="text-sm font-semibold">
        {column.providerName}
        {column.closed ? <span className="ml-2 font-normal text-ink-muted">off today</span> : null}
        {/* A-042 — the way INTO the booking panel that does not depend on
            there being a gap. Until this link, the only per-stylist door was a
            gap chip, so a fully booked column could not be booked into at all
            and BOOK-05's override was unreachable from any screen. No `at`:
            the panel lists the day's real times, refusals and all. */}
        <Link
          href={`/staff/book?provider=${column.providerId}&day=${model.day}`}
          className="ml-2 font-normal text-ink-muted underline underline-offset-4"
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
          calls={column.calls}
          pushFrom={column.pushFrom}
        />
      )}
      </div>

      {/* ROW TWO — the day itself, on the shared axis. */}
      <div
        data-day-axis={column.providerId}
        className="relative rounded-control border border-line-hairline"
        style={{ height }}
      >
        {/* Working hours, shaded. Decorative: the same information is in every
            item's accessible name and in the column's own label. */}
        {column.windows.map((window, i) => (
          <div
            key={i}
            aria-hidden="true"
            // A FILL *AND* AN EDGE. `--ground-sunken` is deliberately near
            // the page ground in dark (depth is drawn with the hairline there,
            // not with a fill — see the token header), so a band relying on the
            // fill alone would simply vanish on the tablet under the window.
            className="absolute inset-x-0 border-y border-line-hairline bg-ground-sunken"
            style={{ top: window.top * PX_PER_MINUTE, height: window.minutes * PX_PER_MINUTE }}
          />
        ))}

        {model.ticks.map((tick) => (
          <div
            key={tick.top}
            aria-hidden="true"
            className="absolute inset-x-0 border-t border-line-hairline"
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
            // `--intent-danger-line` for its VALUE and its checked 3:1, not
            // for its meaning: a now-line is red in every calendar anyone at
            // the desk has ever used. A `--now-line` token would be one fact
            // under two names (A-088's own rule) with exactly one caller.
            className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-danger-line"
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

  // A-090 — the appointment chip is its own component, drawn as a full state
  // matrix on `/staff/design`. Everything else on the grid is a band of time
  // with a label on it and has no states to speak of.
  if (item.kind === 'appointment') return <AppointmentChip item={item} style={style} />;

  const body = (
    <>
      <span className="font-medium">{item.title}</span>
      {item.detail ? <span className="ml-1 text-ink-muted">{item.detail}</span> : null}
    </>
  );

  return (
    // A-030: a gap can now fall INSIDE an appointment — a colour's developing
    // time is real bookable provider time — so gaps paint above appointment
    // chips rather than under them. Without this the one gap the desk most
    // wants to click is the one hidden behind the colour.
    <li className={`${CHIP_SHELL} ${item.kind === 'gap' ? 'z-10 ' : ''}${DECORATION[item.kind]}`} style={style}>
      {/* A-017 gave gaps somewhere to go, so they are links now. Breaks and
          absences stay plain text: there is nothing to do with a lunch break,
          and a focusable element that does nothing when activated is worse
          than no target at all. */}
      {item.href ? (
        <Link href={item.href} className="block h-full" aria-label={item.label}>
          {body}
        </Link>
      ) : (
        <span aria-label={item.label}>{body}</span>
      )}
    </li>
  );
}

const DECORATION: Record<Exclude<GridItem['kind'], 'appointment'>, string> = {
  gap: 'border border-dashed border-line-control text-ink-muted hover:bg-ground-sunken',
  break: 'bg-ground-sunken text-ink-muted',
  absence: 'bg-ground-sunken text-ink-secondary',
};

/** Re-reads the server component on a timer. An interval is a subscription to
 *  an external system (the clock), which is what effects are for. */
function useAutoRefresh(live: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router, live]);
}
