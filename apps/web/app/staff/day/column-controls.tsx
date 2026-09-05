'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  type DayActionState,
  type PreviewShape,
  clearColumnRunningLate,
  confirmColumnPush,
  previewColumnPush,
  setColumnRunningLate,
  toggleToldAbout,
} from '@/lib/day/actions';
import type { CallRow } from '@/lib/day/view-model';

const initial: DayActionState = {};
const field = 'w-16 rounded-md border border-zinc-400 bg-transparent px-2 py-1 text-sm dark:border-zinc-600';
const small = 'rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600';

/**
 * A-018's two controls, side by side on the column header, because they answer
 * two different questions the desk asks in the same breath:
 *
 *  - "Dana is running forty behind" — a claim, one tap, changes no times.
 *  - "Push everything from 2pm" — an action, previewed, that changes them all.
 *
 * They look different on purpose. Anything that made them feel like the same
 * button would eventually make one do the other's job.
 *
 * A-059 adds the third thing, which is the CONSEQUENCE of the first: a delta
 * tells nobody, so the people on their way have to be rung, and the list of
 * who has been got to was living on a Post-it.
 */
export function ColumnControls({
  providerId,
  providerName,
  day,
  runningLateMinutes,
  calls,
  pushFrom,
}: {
  providerId: string;
  providerName: string;
  day: string;
  runningLateMinutes: number | null;
  /** A-059. Who is still on their way inside the next few hours. Empty unless
   *  a delta is set. */
  calls: CallRow[];
  /** The instant "from here" means: the first appointment still to come. Null
   *  when there is nothing left to push. */
  pushFrom: string | null;
}) {
  const [lateState, setLate, settingLate] = useActionState(setColumnRunningLate, initial);
  const [, clearLate, clearing] = useActionState(clearColumnRunningLate, initial);
  const [pushState, doPush, pushing] = useActionState(confirmColumnPush, initial);

  const [minutes, setMinutes] = useState('15');
  const [preview, setPreview] = useState<PreviewShape | null>(null);
  const [previewing, startPreview] = useTransition();

  return (
    <div className="flex flex-col gap-2 pb-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {runningLateMinutes ? (
          <>
            <span className="rounded-sm bg-amber-200 px-2 py-1 font-semibold text-amber-950 dark:bg-amber-900 dark:text-amber-100">
              +{runningLateMinutes} min
            </span>
            <form action={clearLate}>
              <input type="hidden" name="providerId" value={providerId} />
              <input type="hidden" name="day" value={day} />
              <button type="submit" disabled={clearing} className={small}>
                Back on time
              </button>
            </form>
          </>
        ) : (
          <form action={setLate} className="flex items-center gap-1">
            <input type="hidden" name="providerId" value={providerId} />
            <input type="hidden" name="day" value={day} />
            <label htmlFor={`late-${providerId}`} className="text-zinc-600 dark:text-zinc-400">
              Behind by
            </label>
            <input id={`late-${providerId}`} name="minutes" defaultValue="15" inputMode="numeric" className={field} />
            <button type="submit" disabled={settingLate} className={small}>
              Set
            </button>
          </form>
        )}
      </div>

      {lateState.message && !lateState.ok ? (
        <p aria-live="polite" className="text-amber-800 dark:text-amber-300">
          {lateState.message}
        </p>
      ) : null}

      {runningLateMinutes && calls.length > 0 ? (
        <RingRound providerId={providerId} providerName={providerName} day={day} calls={calls} />
      ) : null}

      {pushFrom ? (
        <details className="rounded-md border border-zinc-300 p-2 dark:border-zinc-700">
          <summary className="cursor-pointer font-medium">Push the column</summary>
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center gap-1">
              <label htmlFor={`push-${providerId}`} className="text-zinc-600 dark:text-zinc-400">
                {/* Not "By": it is a substring of "Behind by" just above,
                    which makes the two controls sound the same read aloud. */}
                Push by
              </label>
              {/* A-059: NOT `inputMode="numeric"`. On a phone that keypad has
                  no minus key, so the one instruction this field newly admits
                  would be untypeable on the device the desk actually holds. */}
              <input
                id={`push-${providerId}`}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                inputMode="text"
                aria-describedby={`push-hint-${providerId}`}
                className={field}
              />
              <button
                type="button"
                className={small}
                onClick={() =>
                  startPreview(async () => {
                    setPreview(await previewColumnPush(providerId, day, pushFrom, Number(minutes)));
                  })
                }
              >
                Preview
              </button>
            </div>

            {/* A-059. The negative was always accepted and nothing said so —
                a hidden feature is a feature nobody has. "She's caught up,
                pull it back 20" is an instruction the desk gives out loud. */}
            <p id={`push-hint-${providerId}`} className="text-zinc-600 dark:text-zinc-400">
              Minus to pull the column earlier — <code>-20</code> when she has caught up.
            </p>

            {previewing ? <p className="text-zinc-600 dark:text-zinc-400">Checking…</p> : null}

            {preview ? (
              <>
                <ul className="flex flex-col gap-1">
                  {preview.rows.map((row) => (
                    <li key={row.appointmentId} className={row.problem ? 'text-amber-800 dark:text-amber-300' : ''}>
                      {row.from} → {row.to} {row.clientName ?? 'Walk-in'}
                      {/* APPT-04's collision preview: named, before anything
                          moves, because a column that half-moved is worse
                          than one that did not. */}
                      {row.problem === 'past-closing' ? ' — stays: would run past closing' : ''}
                      {row.problem === 'before-opening' ? ' — stays: would start before she opens' : ''}
                      {row.problem === 'blocked-by-one-that-stays' ? ' — stays: blocked by one that stays' : ''}
                      {row.problem === 'no-chair-free' ? ' — stays: no chair free at the new time' : ''}
                      {/* A-079. Everything else standing in the column: the
                          visit still running, the no-show still holding its
                          time (D-7), the one that started before here. It was
                          never in the move set — it is here so "pull everyone
                          forward twenty" cannot read as a clean sweep. */}
                      {row.problem === 'still-in-the-chair' ? ' — still in the chair, not moving' : ''}
                    </li>
                  ))}
                </ul>

                {preview.rows.length === 0 ? <p>Nothing left to move.</p> : null}

                {/* D-43. What this leaves the delta at, BEFORE the desk
                    commits — and stated just as plainly when it leaves it
                    standing, because a partial push or a pull-forward not
                    reducing it is a decision the desk has to see. */}
                {preview.runningLateMinutes > 0 ? (
                  <p className={preview.runningLateAfter === preview.runningLateMinutes ? 'text-amber-800 dark:text-amber-300' : ''}>
                    {preview.runningLateAfter === preview.runningLateMinutes
                      ? `${providerName} still shows ${preview.runningLateMinutes} min behind — ` +
                        (preview.minutes < 0
                          ? 'pulling the column earlier does not change the delta.'
                          : 'the ones that stay are still late.')
                      : preview.runningLateAfter === 0
                        ? `${providerName} then shows on time.`
                        : `${providerName} then shows ${preview.runningLateAfter} min behind.`}
                  </p>
                ) : null}

                <form action={doPush} className="flex flex-col gap-2">
                  <input type="hidden" name="providerId" value={providerId} />
                  <input type="hidden" name="day" value={day} />
                  <input type="hidden" name="fromAt" value={pushFrom} />
                  <input type="hidden" name="minutes" value={minutes} />
                  <label className="flex flex-col gap-1">
                    Why?
                    <input
                      name="reason"
                      placeholder={`${providerName} is running behind`}
                      className="rounded-md border border-zinc-400 bg-transparent px-2 py-1 dark:border-zinc-600"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={pushing || !preview.canPush}
                    className="self-start rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {pushing
                      ? 'Moving…'
                      : `Move ${preview.rows.filter((r) => !r.problem).length} and tell them`}
                  </button>
                </form>
              </>
            ) : null}

            {pushState.message ? (
              <p aria-live="polite" className={pushState.ok ? '' : 'text-amber-800 dark:text-amber-300'}>
                {pushState.message}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * A-059 (APPT-03) — THE RING-ROUND.
 *
 * The half of "running late" that was missing. Setting a delta makes the grid
 * amber and stops the website selling the next forty minutes; it tells not one
 * of the four people already on their way, who each arrive at the time on
 * their confirmation. So somebody rings them, and the record of who had been
 * got to was a Post-it — the shadow calendar, one layer down from the one
 * A-018 removed.
 *
 * NOTHING HERE SENDS ANYTHING, and the wording is written so nobody could read
 * it as if it did. There is no driver (D-14), and A-044 established that a
 * screen saying "queued" beside a client's name is read by staff as "no need
 * to call her" — so this says "Told her", in the past tense, about a phone
 * call a person made.
 *
 * Open by default rather than behind a `<details>`, unlike the push: the push
 * is an action somebody goes looking for, and this is a list that has to be
 * seen without being sought.
 */
function RingRound({
  providerId,
  providerName,
  day,
  calls,
}: {
  providerId: string;
  providerName: string;
  day: string;
  calls: CallRow[];
}) {
  const [state, toggle, saving] = useActionState(toggleToldAbout, initial);
  const left = calls.filter((c) => !c.told).length;

  return (
    <section
      aria-label={`Still to ring for ${providerName}`}
      className="rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/40"
    >
      <h3 className="font-semibold">
        {/* The count is of who is LEFT, not of the list: the desk's question is
            "how many more calls", and a heading that counted the rung ones
            would go up as the work got done. */}
        Still to ring: {left} of {calls.length}
      </h3>
      <p className="text-zinc-600 dark:text-zinc-400">
        Nobody has been messaged. Setting the delta changes no times and sends nothing.
      </p>

      <ul className="mt-2 flex flex-col gap-2">
        {calls.map((call) => (
          <li key={call.appointmentId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {/* Scheduled STRUCK THROUGH and the projected time beside it, both
                present: her confirmation still says the first one, and the
                desk opens the call with "you're booked for two". */}
            {/* `line-through` carries this, not an alpha — checkpoint 7: an
                opacity on text is a colour no contrast test can see, and this
                one is 12px mono on a card nobody has ever run axe over with a
                late column on it. */}
            <span className="font-mono line-through">{call.scheduled}</span>
            <span className="font-mono font-semibold">→ {call.projected}</span>
            <a href={call.href} className="font-medium underline underline-offset-4">
              {call.clientName}
            </a>

            {call.phone ? (
              <a href={`tel:${call.phone}`} className="underline underline-offset-4">
                {call.phone}
              </a>
            ) : (
              // Said out loud rather than left blank: "no number" is the fact
              // that decides she cannot be rung at all, and a gap where a
              // number should be reads as a rendering bug.
              <span className="text-zinc-600 dark:text-zinc-400">no number on file</span>
            )}

            <form action={toggle} className="ml-auto">
              <input type="hidden" name="providerId" value={providerId} />
              <input type="hidden" name="day" value={day} />
              <input type="hidden" name="appointmentId" value={call.appointmentId} />
              <input type="hidden" name="told" value={call.told ? '1' : '0'} />
              <button
                type="submit"
                disabled={saving}
                className={`${small} ${call.told ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : ''}`}
              >
                {/* The accessible name names the ACTION and the client, and
                    stops there: who rang her and when is one line down, and a
                    button that repeated it made a screen reader say it twice
                    per row. */}
                <span aria-hidden="true">{call.told ? '✓ Told her' : 'Told her'}</span>
                <span className="sr-only">
                  {call.told ? `Undo told for ${call.clientName}` : `Mark ${call.clientName} as told`}
                </span>
              </button>
            </form>

            {call.told ? <span className="w-full text-zinc-600 dark:text-zinc-400">{call.told}</span> : null}
            {/* The tick stays — she HAS been spoken to — but what she was told
                is no longer what is happening, and only the desk can decide
                whether that is worth a second call. */}
            {call.stale ? (
              <span className="w-full font-medium text-amber-900 dark:text-amber-200">
                ⚑ Told about a different delay — worth ringing again.
              </span>
            ) : null}
            {call.note ? <span className="w-full font-medium text-amber-900 dark:text-amber-200">⚑ {call.note}</span> : null}
            {call.missed ? <span className="w-full font-medium text-amber-900 dark:text-amber-200">⚑ {call.missed}</span> : null}
          </li>
        ))}
      </ul>

      {state.message && !state.ok ? (
        <p aria-live="polite" className="mt-2 font-medium text-amber-900 dark:text-amber-200">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
