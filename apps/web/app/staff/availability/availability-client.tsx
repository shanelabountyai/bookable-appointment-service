'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import {
  type FormState,
  type ImpactState,
  addAbsence,
  addWeeklyWindow,
  removeDateOverride,
  removeTimeOff,
  removeWeeklyWindow,
  saveDateOverride,
} from '@/lib/settings/availability-actions';

const initial: ImpactState = {};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const input = 'rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950';
const button =
  'rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900';
const ghost =
  'rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900';

/**
 * A-041's sentence, hoisted by A-047 so all five writes say it the same way.
 *
 * NOT a confirmation gate: the write has already happened by the time this
 * renders (D-2, AVAIL-03). It is the answer to "who did that strand?", and the
 * link is there because the resolution is a phone call, not an acknowledgment.
 *
 * `strandedCount === 0` renders the plain message — a count of nothing said
 * out loud on every save is how a warning becomes wallpaper.
 */
function Impact({ state }: { state: ImpactState }) {
  if (!state.ok) return null;
  return (
    <p aria-live="polite" className="text-sm">
      {state.message}
      {state.strandedCount ? (
        <>
          {' '}
          <span className="font-medium text-amber-800 dark:text-amber-300">
            {state.strandedCount} appointment{state.strandedCount === 1 ? '' : 's'} now stranded.
          </span>{' '}
          <Link href={`/staff/conflicts?day=${state.conflictsDay}`} className="underline underline-offset-4">
            Deal with them
          </Link>
        </>
      ) : null}
    </p>
  );
}

function Errors({ state }: { state: FormState }) {
  const messages = Object.values(state.errors ?? {});
  return (
    <p aria-live="polite" className="min-h-5 text-sm text-red-600 dark:text-red-400">
      {messages[0] ?? ''}
    </p>
  );
}

export interface WindowView {
  id: string;
  weekday: number;
  open: string;
  close: string;
  endsNextDay: boolean;
  breaks: { open: string; close: string }[];
}

export function WeeklyHours({ providerId, windows }: { providerId: string; windows: WindowView[] }) {
  const [state, action, pending] = useActionState(addWeeklyWindow, initial);
  // A-047: the remove's state was DISCARDED — `const [, removeAction]` — so
  // even once the action returned a count there was nothing to render it.
  // Removing a Thursday window is "I don't work Thursdays any more".
  const [removeState, removeAction] = useActionState(removeWeeklyWindow, initial);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        {providerId === '' ? 'Business hours' : 'Weekly hours'}
      </h2>

      {windows.length === 0 ? (
        <p className="text-sm text-zinc-500">No hours set — this {providerId === '' ? 'business' : 'provider'} is closed all week.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {windows.map((w) => (
            <li key={w.id} className="flex items-center gap-3 text-sm">
              <span className="w-24 text-zinc-500">{WEEKDAYS[w.weekday]}</span>
              <span>
                {w.open.trim()}–{w.close.trim()}
                {w.endsNextDay && <span className="text-zinc-500"> (next day)</span>}
              </span>
              {w.breaks.length > 0 && (
                <span className="text-xs text-zinc-500">
                  break {w.breaks.map((b) => `${b.open.trim()}–${b.close.trim()}`).join(', ')}
                </span>
              )}
              <form action={removeAction}>
                <input type="hidden" name="windowId" value={w.id} />
                <button type="submit" className={ghost}>
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <Impact state={removeState} />

      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="providerId" value={providerId} />
        <div className="flex flex-col gap-1">
          <label htmlFor={`weekday-${providerId}`} className="text-xs font-medium">
            Day
          </label>
          <select id={`weekday-${providerId}`} name="weekday" className={input} defaultValue="2">
            {WEEKDAYS.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`open-${providerId}`} className="text-xs font-medium">
            Open
          </label>
          <input id={`open-${providerId}`} name="open" type="time" defaultValue="09:00" className={input} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`close-${providerId}`} className="text-xs font-medium">
            Close
          </label>
          <input id={`close-${providerId}`} name="close" type="time" defaultValue="17:00" className={input} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`breakOpen-${providerId}`} className="text-xs font-medium">
            Break from
          </label>
          <input id={`breakOpen-${providerId}`} name="breakOpen" type="time" className={input} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`breakClose-${providerId}`} className="text-xs font-medium">
            Break to
          </label>
          <input id={`breakClose-${providerId}`} name="breakClose" type="time" className={input} />
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs">
          <input name="endsNextDay" type="checkbox" />
          Ends next day
        </label>
        <button type="submit" disabled={pending} className={button}>
          Add hours
        </button>
      </form>
      <Errors state={state} />
      <Impact state={state} />
    </section>
  );
}

export interface OverrideView {
  id: string;
  day: string;
  isClosed: boolean;
  reason: string | null;
  windows: { open: string; close: string }[];
}

export function DateOverrides({ providerId, overrides }: { providerId: string; overrides: OverrideView[] }) {
  const [state, action, pending] = useActionState(saveDateOverride, initial);
  const [removeState, removeAction] = useActionState(removeDateOverride, initial);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Specific dates</h2>
      <p className="text-xs text-zinc-500">
        An override <strong>replaces</strong> that day&apos;s usual hours — it never adds to them.
      </p>

      {overrides.length > 0 && (
        <ul className="flex flex-col gap-1">
          {overrides.map((o) => (
            <li key={o.id} className="flex items-center gap-3 text-sm">
              <span className="w-28 text-zinc-500">{o.day.trim()}</span>
              <span>{o.isClosed ? 'Closed' : o.windows.map((w) => `${w.open.trim()}–${w.close.trim()}`).join(', ')}</span>
              {o.reason && <span className="text-xs text-zinc-500">{o.reason}</span>}
              <form action={removeAction}>
                <input type="hidden" name="overrideId" value={o.id} />
                <button type="submit" className={ghost}>
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <Impact state={removeState} />

      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="providerId" value={providerId} />
        <div className="flex flex-col gap-1">
          <label htmlFor={`day-${providerId}`} className="text-xs font-medium">
            Date
          </label>
          <input id={`day-${providerId}`} name="day" type="date" required className={input} />
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs">
          <input name="isClosed" type="checkbox" />
          Closed all day
        </label>
        <div className="flex flex-col gap-1">
          <label htmlFor={`ovOpen-${providerId}`} className="text-xs font-medium">
            Open
          </label>
          <input id={`ovOpen-${providerId}`} name="open" type="time" defaultValue="10:00" className={input} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`ovClose-${providerId}`} className="text-xs font-medium">
            Close
          </label>
          <input id={`ovClose-${providerId}`} name="close" type="time" defaultValue="14:00" className={input} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`reason-${providerId}`} className="text-xs font-medium">
            Reason
          </label>
          <input id={`reason-${providerId}`} name="reason" className={input} />
        </div>
        <button type="submit" disabled={pending} className={button}>
          Save date
        </button>
      </form>
      <Errors state={state} />
      <Impact state={state} />
    </section>
  );
}

export interface AbsenceView {
  id: string;
  startAt: string;
  endAt: string;
  reason: string | null;
  kind: 'time_off' | 'ad_hoc_block';
}

export function Absences({ providerId, absences }: { providerId: string; absences: AbsenceView[] }) {
  const [state, action, pending] = useActionState(addAbsence, initial);
  const [, removeAction] = useActionState(removeTimeOff, initial);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Time off &amp; blocks</h2>
      <p className="text-xs text-zinc-500">
        Recording time off always succeeds, even over existing appointments — nothing is ever silently cancelled. Which
        appointments it strands is shown for a person to resolve.
      </p>

      {absences.length > 0 && (
        <ul className="flex flex-col gap-1">
          {absences.map((a) => (
            <li key={a.id} className="flex items-center gap-3 text-sm">
              <span className="text-zinc-500">{a.kind === 'time_off' ? 'Time off' : 'Block'}</span>
              <span>
                {a.startAt} → {a.endAt}
              </span>
              {a.reason && <span className="text-xs text-zinc-500">{a.reason}</span>}
              {a.kind === 'time_off' && (
                <form action={removeAction}>
                  <input type="hidden" name="timeOffId" value={a.id} />
                  <button type="submit" className={ghost}>
                    Remove
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="providerId" value={providerId} />
        <div className="flex flex-col gap-1">
          <label htmlFor={`kind-${providerId}`} className="text-xs font-medium">
            Kind
          </label>
          <select id={`kind-${providerId}`} name="kind" className={input}>
            <option value="time_off">Time off</option>
            <option value="ad_hoc_block">Block</option>
          </select>
        </div>
        {/* Offset-bearing instants, never {date, time} (D-4). */}
        <div className="flex flex-col gap-1">
          <label htmlFor={`startAt-${providerId}`} className="text-xs font-medium">
            From (with offset)
          </label>
          <input
            id={`startAt-${providerId}`}
            name="startAt"
            placeholder="2026-06-09T14:00:00-05:00"
            className={`${input} w-56`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`endAt-${providerId}`} className="text-xs font-medium">
            To (with offset)
          </label>
          <input
            id={`endAt-${providerId}`}
            name="endAt"
            placeholder="2026-06-09T16:00:00-05:00"
            className={`${input} w-56`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`absReason-${providerId}`} className="text-xs font-medium">
            Reason
          </label>
          <input id={`absReason-${providerId}`} name="reason" className={input} />
        </div>
        <button type="submit" disabled={pending} className={button}>
          Add
        </button>
      </form>
      <Errors state={state} />
      {/* AVAIL-05 (operator P-8): the write above already happened — this is
          not a confirmation gate, it is the answer to "who did that strand?" */}
      <Impact state={state} />
    </section>
  );
}
