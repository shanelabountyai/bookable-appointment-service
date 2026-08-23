import Link from 'next/link';
import { PX_PER_MINUTE } from '@/lib/day/scale';
import type { GridModel, RoomModel } from '@/lib/day/view-model';

/**
 * A-046 — THE ROOM, ON THE SCREEN THAT REFUSES ON ITS AUTHORITY.
 *
 * Chairs as tracks down the same day the provider columns run down, at the
 * same scale, so the difference the epic is about is visible rather than
 * argued: a colour's block here runs through its developing hour, while the
 * same colour on Dana's column has a hole in it that somebody else is booked
 * into. Four stylists, eight clients, four chairs — and the fifth refused.
 *
 * A server component: nothing here changes without the day changing, and the
 * grid beside it already owns the 15-second refresh that re-renders the page.
 */
export function RoomStrip({ model }: { model: GridModel }) {
  if (model.room.length === 0) return null;
  const height = model.totalMinutes * PX_PER_MINUTE;

  return (
    <div className="flex flex-col gap-4">
      {model.room.map((type) => (
        <RoomType key={type.typeName} type={type} ticks={model.ticks} height={height} />
      ))}
    </div>
  );
}

function RoomType({ type, ticks, height }: { type: RoomModel; ticks: GridModel['ticks']; height: number }) {
  return (
    <section aria-label={`${type.typeName}s — ${type.capacity} in service`}>
      <h2 className="text-sm font-semibold">
        The room
        <span className="ml-2 font-normal text-zinc-600 dark:text-zinc-400">
          {type.capacity} {type.typeName.toLowerCase()}
          {type.capacity === 1 ? '' : 's'} in service
        </span>
        <Link href="/staff/resources" className="ml-2 font-normal text-zinc-600 underline underline-offset-4 dark:text-zinc-400">
          Manage
        </Link>
      </h2>

      {type.tracks.length === 0 ? (
        /* Not decoration: a required type with nothing in service makes every
           slot unbookable, and the engine reports that as an ordinary empty
           day. This is the only place that says WHY. */
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
          No {type.typeName.toLowerCase()} is in service, so nothing that needs one can be booked.
        </p>
      ) : (
        /* WCAG 2.1.1 / axe `scrollable-region-focusable`: a horizontally
           scrollable box whose contents are not focusable is unreachable by
           keyboard, so it needs its own tab stop. It happens to hold links on
           most days — which is exactly why this was invisible until a day with
           an empty room rendered one with none. */
        <div tabIndex={0} className="mt-1 flex gap-2 overflow-x-auto">
          <div className="relative w-14 shrink-0" style={{ height }} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.label + tick.top}
                className="absolute right-1 -translate-y-1/2 text-xs text-zinc-600 dark:text-zinc-400"
                style={{ top: tick.top * PX_PER_MINUTE }}
              >
                {tick.label}
              </span>
            ))}
          </div>

          {type.tracks.map((track) => (
            <section key={track.resourceId} className="min-w-32 flex-1" aria-label={track.name}>
              <h3 className="text-sm font-medium">
                {track.active ? (
                  track.name
                ) : (
                  <>
                    <span className="text-zinc-400 line-through">{track.name}</span>
                    {/* Retiring never rewrites history, so a chair taken out of
                        service keeps whoever is already in it until she
                        leaves. Saying so beats a row the desk cannot explain. */}
                    <span className="ml-2 font-normal text-zinc-600 dark:text-zinc-400">out of service</span>
                  </>
                )}
              </h3>

              <div className="relative rounded-md border border-zinc-200 dark:border-zinc-800" style={{ height }}>
                {ticks.map((tick) => (
                  <div
                    key={tick.top}
                    aria-hidden="true"
                    className="absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800/60"
                    style={{ top: tick.top * PX_PER_MINUTE }}
                  />
                ))}

                <ol className="contents">
                  {track.blocks.map((block) => (
                    <li
                      key={block.key}
                      className="absolute inset-x-1 overflow-hidden rounded-sm border border-zinc-300 bg-zinc-100 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800"
                      style={{ top: block.top * PX_PER_MINUTE, height: Math.max(block.minutes * PX_PER_MINUTE, 18) }}
                    >
                      <Link
                        href={block.href}
                        aria-label={block.label}
                        className="block h-full focus:outline-2 focus:outline-offset-2"
                      >
                        <span className="block truncate font-medium">{block.title}</span>
                        <span className="block truncate text-zinc-600 dark:text-zinc-400">{block.detail}</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
