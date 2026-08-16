'use client';

import { useState, useTransition } from 'react';
import {
  type ConfirmResult,
  type OfferedTime,
  type OpenDay,
  confirmAppointment,
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
}

const STEP_ORDER: Step[] = ['service', 'who', 'day', 'time', 'details'];

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const duration = (minutes: number) =>
  minutes % 60 === 0 ? `${minutes / 60} hr` : minutes > 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;

const card = 'rounded-md border border-zinc-300 px-4 py-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900';
const selected = 'border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900';
const primary =
  'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900';

export function BookingFlow({ services }: { services: Service[] }) {
  const [step, setStep] = useState<Step>('service');
  const [service, setService] = useState<Service | null>(null);
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

  const stepIndex = STEP_ORDER.indexOf(step);

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

      {step === 'service' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-lg font-semibold">What would you like booked?</legend>
          {services.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`${card} ${service?.id === s.id ? selected : ''}`}
              onClick={() => {
                setService(s);
                startTransition(async () => {
                  const list = await listProvidersFor(s.id);
                  setProviders(list);
                  setStep('who');
                });
              }}
            >
              <span className="font-medium">{s.name}</span>
              <span className="block text-sm text-zinc-500">
                {duration(s.durationMinutes)} · {money(s.priceCents)}
              </span>
            </button>
          ))}
        </fieldset>
      )}

      {step === 'who' && service && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-lg font-semibold">Who would you like to see?</legend>
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`${card} ${provider?.id === p.id ? selected : ''}`}
              onClick={() => {
                setProvider(p);
                startTransition(async () => {
                  setOpenDays(await listDaysWithOpenings(service.id, p.id));
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

      {step === 'day' && service && provider && (
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
                        setTimes(await listTimesOn(service.id, provider.id, d.day));
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

      {step === 'time' && service && provider && day && (
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

      {step === 'details' && service && provider && day && time && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            startTransition(async () => {
              const outcome = await confirmAppointment({
                serviceId: service.id,
                providerId: provider.id,
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
            {service.name} with {provider.name}
          </h2>
          <p className="text-zinc-500">
            {day.label} at {time.label}
            {time.qualifier ? ` ${time.qualifier}` : ''}
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

      {step === 'done' && service && provider && day && time && (
        <div className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Your appointment is confirmed</h2>
          <p className="text-zinc-600 dark:text-zinc-400">
            {service.name} with {provider.name}, {day.label} at {time.label}
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

