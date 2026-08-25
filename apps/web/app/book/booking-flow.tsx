'use client';

import { useState, useTransition } from 'react';
import {
  type ConfirmResult,
  type OfferedTime,
  type OpenDay,
  confirmAppointment,
  listAnyProviderDays,
  listAnyProviderTimes,
  listDaysWithOpenings,
  listProvidersFor,
  listTimesOn,
} from '@/lib/booking/public-actions';

/**
 * BOOK-01: service → who → day → time → details. Five steps, two required
 * text inputs (name and phone; email is optional), no page reloads.
 *
 * D-10's lexicon throughout: an "appointment", never a "booking" or a "slot".
 * Nothing internal — no id, entity name or status — is ever rendered.
 */
type Step = 'service' | 'who' | 'day' | 'time' | 'details' | 'done';

interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  /** A-058. False = the desk books it, she cannot. Shown anyway, with the one
   *  thing she can act on — a salon that hides balayage has told her it does
   *  not do balayage. */
  bookableOnline: boolean;
}

const STEP_ORDER: Step[] = ['service', 'who', 'day', 'time', 'details'];

/**
 * A-058 (VISIT-01, D-23) — the composed visit, not a list of lines.
 *
 * Catalogue values, deliberately: a stylist's own duration and price overrides
 * (SVC-02) are not known until she has picked one, and the engine applies them
 * for real when it computes the times. What this is for is the honest answer
 * to "how long am I here and what does it cost", which two hours in one row
 * and forty-five minutes in another does not give.
 */
const compose = (chosen: Service[]) => ({
  durationMinutes: chosen.reduce((sum, s) => sum + s.durationMinutes, 0),
  priceCents: chosen.reduce((sum, s) => sum + s.priceCents, 0),
});

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const duration = (minutes: number) =>
  minutes % 60 === 0 ? `${minutes / 60} hr` : minutes > 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;

const card = 'rounded-md border border-zinc-300 px-4 py-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900';
const selected = 'border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900';
const primary =
  'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900';

/** A-056 — the sentinel for "no preference". Never a provider id: the real
 *  stylist arrives on the TIME she picks, chosen by SVC-02. */
const ANYONE = 'any';

/**
 * A-054 removed `Prefill` and the `/book?service=&provider=` contract behind
 * it. A-015 built it for "rebook last visit"; A-040 replaced that with the
 * staff flow (`/staff/book?services=…&client=…`), and nothing in the product
 * has emitted the public form since. Owner confirmed the deletion at demo
 * checkpoint 4. A pasted link now simply starts the flow at the top — which is
 * what it already did for every link with a retired service or a departed
 * stylist.
 */
export function BookingFlow({ services }: { services: Service[] }) {
  const [step, setStep] = useState<Step>('service');
  /** IN TAP ORDER (VISIT-01): "cut then colour" is a different appointment
   *  from "colour then cut", because the buffers come from the ends. Selection
   *  order is the visit order — the same rule and the same shape the staff
   *  panel has used since A-039. */
  const [chosen, setChosen] = useState<Service[]>([]);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [provider, setProvider] = useState<{ id: string; name: string } | null>(null);
  const [openDays, setOpenDays] = useState<OpenDay[]>([]);
  const [day, setDay] = useState<OpenDay | null>(null);
  const [times, setTimes] = useState<OfferedTime[]>([]);
  const [time, setTime] = useState<OfferedTime | null>(null);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [pending, startTransition] = useTransition();

  /** Announced politely whenever the list of times changes (BOOK-01).
   *
   *  Derived during render, not written from an effect: the text is a pure
   *  function of the state above, and an effect would only be a second copy of
   *  it that can disagree. */
  const announcement =
    step !== 'time' || pending
      ? ''
      : times.length === 0
        ? 'No appointments available that day. Please choose another day.'
        : `${times.length} appointment ${times.length === 1 ? 'time' : 'times'} available on ${day?.label ?? ''}.`;

  /** ORDER MATTERS (VISIT-01): tapping adds to the end, so selection order is
   *  the visit order. Re-tapping removes. Changing the visit invalidates
   *  everything chosen after it — a stylist qualified for a cut may not be
   *  qualified for the colour just added, and the times were computed for a
   *  different length — so the flow drops back to the top of that chain rather
   *  than carrying a stale answer forward. */
  function toggle(s: Service) {
    setChosen(chosen.some((c) => c.id === s.id) ? chosen.filter((c) => c.id !== s.id) : [...chosen, s]);
    setProvider(null);
    setDay(null);
    setTime(null);
    setResult(null);
  }

  const stepIndex = STEP_ORDER.indexOf(step);
  const ids = chosen.map((c) => c.id);
  const visit = compose(chosen);
  /** What she is booking, in one line, everywhere it has to be restated. */
  const visitName = chosen.map((c) => c.name).join(' + ');

  return (
    <div className="flex flex-col gap-6">
      {step !== 'done' && (
        <nav aria-label="Progress" className="text-sm text-zinc-500">
          Step {stepIndex + 1} of {STEP_ORDER.length}
        </nav>
      )}

      {/* One live region for the whole flow, so a screen reader hears the
          times change without the focus moving. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* A-058 — MULTI-SELECT ON THE SAME SCREEN, not a sixth step. Half the
          Saturday book is a cut AND a colour (D-23), and BOOK-01 caps the flow
          at five screens; a "would you like to add anything?" step would have
          bought one feature with a screen every single-service client has to
          tap past. */}
      {step === 'service' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-lg font-semibold">What would you like booked?</legend>
          <p className="-mt-2 text-sm text-zinc-500">Pick as many as you like — we&apos;ll book them together.</p>
          {services.map((s) => {
            const index = ids.indexOf(s.id);
            // A-058. Desk-only: present, and saying what to do. Rendered as
            // static markup rather than a disabled button, because a disabled
            // control is skipped by a screen reader's tab order and the note
            // beside it is the entire message.
            if (!s.bookableOnline) {
              return (
                <div
                  key={s.id}
                  className="rounded-md border border-dashed border-zinc-300 px-4 py-3 dark:border-zinc-700"
                >
                  <span className="font-medium text-zinc-500">{s.name}</span>
                  <span className="block text-sm text-zinc-500">
                    {duration(s.durationMinutes)} · {money(s.priceCents)}
                  </span>
                  <span className="mt-1 block text-sm text-zinc-600 dark:text-zinc-400">
                    Give us a call for this one — it needs a quick chat first.
                  </span>
                </div>
              );
            }
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={index >= 0}
                className={`${card} ${index >= 0 ? selected : ''}`}
                onClick={() => toggle(s)}
              >
                <span className="font-medium">
                  {/* The number appears only once there are two, so an
                      ordinary single-service booking is not made to look like
                      a list. */}
                  {index >= 0 && chosen.length > 1 && <span className="mr-1 text-zinc-500">{index + 1}.</span>}
                  {s.name}
                </span>
                <span className="block text-sm text-zinc-500">
                  {duration(s.durationMinutes)} · {money(s.priceCents)}
                </span>
              </button>
            );
          })}

          {chosen.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={pending}
                className={primary}
                onClick={() =>
                  startTransition(async () => {
                    setProviders(await listProvidersFor(ids));
                    setStep('who');
                  })
                }
              >
                Continue
              </button>
              {/* The COMPOSED visit (VISIT-01), not a line per service: what
                  she needs to know is how long she is here and what it costs. */}
              <p className="text-sm text-zinc-500">
                {visitName} · {duration(visit.durationMinutes)} · {money(visit.priceCents)}
              </p>
            </div>
          )}
        </fieldset>
      )}

      {step === 'who' && chosen.length > 0 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-lg font-semibold">Who would you like to see?</legend>
          {/* A-056 (SVC-02) — FIRST, and that position is the point. A client
              who has never been here has no opinion about Dana or Priya, and a
              forced choice is answered by picking the top name or leaving.
              Offering it first is what stops the senior's column absorbing
              every new client while the junior sits at 40%. */}
          <button
            type="button"
            className={`${card} ${provider?.id === ANYONE ? selected : ''}`}
            onClick={() => {
              setProvider({ id: ANYONE, name: 'No preference' });
              startTransition(async () => {
                setOpenDays(await listAnyProviderDays(ids));
                setStep('day');
              });
            }}
          >
            <span className="font-medium">No preference</span>
            <span className="block text-sm text-zinc-500">Whoever is free — we&apos;ll match you up</span>
          </button>
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`${card} ${provider?.id === p.id ? selected : ''}`}
              onClick={() => {
                setProvider(p);
                startTransition(async () => {
                  setOpenDays(await listDaysWithOpenings(ids, p.id));
                  setStep('day');
                });
              }}
            >
              {p.name}
            </button>
          ))}
          <BackButton onClick={() => setStep('service')} />
        </fieldset>
      )}

      {step === 'day' && chosen.length > 0 && provider && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-lg font-semibold">Which day suits you?</legend>
          {openDays.length === 0 ? (
            <p className="text-zinc-500">No appointments available in the next few weeks. Please call us.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {openDays.map((d) => (
                <li key={d.day}>
                  <button
                    type="button"
                    className={`${card} w-full ${day?.day === d.day ? selected : ''}`}
                    onClick={() => {
                      setDay(d);
                      startTransition(async () => {
                        setTimes(
                    provider.id === ANYONE
                      ? await listAnyProviderTimes(ids, d.day)
                      : await listTimesOn(ids, provider.id, d.day),
                  );
                        setStep('time');
                      });
                    }}
                  >
                    {d.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <BackButton onClick={() => setStep('who')} />
        </fieldset>
      )}

      {step === 'time' && chosen.length > 0 && provider && day && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-lg font-semibold">What time on {day.label}?</legend>
          {times.length === 0 ? (
            <p className="text-zinc-500">No appointments left that day. Please choose another.</p>
          ) : (
            // Plain buttons in a list: keyboard operable natively, in DOM
            // order, with no roving-tabindex machinery to get wrong.
            <ul className="flex flex-wrap gap-2">
              {times.map((t) => (
                <li key={t.at}>
                  <button
                    type="button"
                    className={`${card} ${time?.at === t.at ? selected : ''}`}
                    onClick={() => {
                      setTime(t);
                      setStep('details');
                    }}
                  >
                    {t.label}
                    {/* FB-5: on the day the clocks go back the same label
                        happens twice — show which one this is. */}
                    {t.qualifier && <span className="ml-1 text-xs text-zinc-500">{t.qualifier}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <BackButton onClick={() => setStep('day')} />
        </fieldset>
      )}

      {step === 'details' && chosen.length > 0 && provider && day && time && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            startTransition(async () => {
              const outcome = await confirmAppointment({
                serviceIds: ids,
                // On the "no preference" path the stylist comes from the TIME
                // she picked — SVC-02 chose it when the list was built, so what
                // she was shown is what she gets.
                providerId: time.providerId ?? provider.id,
                at: time.at,
                day: day.day,
                name: String(data.get('name') ?? ''),
                phone: String(data.get('phone') ?? ''),
                email: String(data.get('email') ?? ''),
              });
              setResult(outcome);
              if (outcome.ok) setStep('done');
              else if (outcome.alternatives) {
                setTimes(outcome.alternatives);
                setTime(null);
                setStep('time');
              }
            });
          }}
        >
          <h2 className="text-lg font-semibold">
            {visitName} with {provider.name}
          </h2>
          <p className="text-zinc-500">
            {day.label} at {time.label}
            {time.qualifier ? ` ${time.qualifier}` : ''} · {duration(visit.durationMinutes)} ·{' '}
            {money(visit.priceCents)}
          </p>

          <Field label="Your name" name="name" required error={result?.fieldErrors?.name} autoComplete="name" />
          <Field label="Phone" name="phone" required type="tel" error={result?.fieldErrors?.phone} autoComplete="tel" />
          <Field label="Email (optional)" name="email" type="email" autoComplete="email" />

          {result && !result.ok && result.message && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {result.message}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button type="submit" disabled={pending} className={primary}>
              {pending ? 'Confirming…' : 'Confirm appointment'}
            </button>
            <BackButton onClick={() => setStep('time')} />
          </div>
        </form>
      )}

      {step === 'done' && chosen.length > 0 && provider && day && time && (
        <div className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Your appointment is confirmed</h2>
          <p className="text-zinc-600 dark:text-zinc-400">
            {visitName} with {provider.name}, {day.label} at {time.label}
            {time.qualifier ? ` ${time.qualifier}` : ''}.
          </p>
          <p className="text-sm text-zinc-500">
            We&apos;ve sent you a confirmation with a link you can use to change or cancel it.
          </p>
        </div>
      )}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="self-start text-sm text-zinc-500 underline underline-offset-4">
      Back
    </button>
  );
}

function Field({
  label,
  name,
  required,
  type = 'text',
  error,
  autoComplete,
}: {
  label: string;
  name: string;
  required?: boolean;
  type?: string;
  error?: string;
  autoComplete?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
      />
      {error && (
        <p id={`${name}-error`} className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

