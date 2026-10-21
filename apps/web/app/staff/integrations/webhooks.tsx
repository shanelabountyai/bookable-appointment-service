'use client';

import { useActionState } from 'react';
import {
  type DeliveryRow,
  type EndpointRow,
  type WebhookState,
  changeEndpointStatus,
  editEndpoint,
  registerEndpoint,
  replayDeliveryAction,
  replayFromSeqAction,
  rotateSecret,
} from '@/lib/webhooks/actions';
import { EVENT_TYPES } from '@/lib/webhooks/event-types';

const initial: WebhookState = {};
const field = 'rounded-md border border-zinc-400 bg-transparent px-2 py-1 text-sm dark:border-zinc-600';
const small = 'rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600';
const muted = 'text-zinc-600 dark:text-zinc-400';

function Secret({ state }: { state: WebhookState }) {
  return (
    <>
      <p aria-live="polite" className="text-sm text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
      {state.secret ? (
        <output className="break-all rounded-md border border-zinc-400 bg-zinc-50 px-3 py-2 font-mono text-sm dark:border-zinc-600 dark:bg-zinc-900">
          {state.secret}
        </output>
      ) : null}
    </>
  );
}

function EndpointFields({ endpoint }: { endpoint?: EndpointRow }) {
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        URL
        <input name="url" type="url" required placeholder="https://example.com/bookable-webhook" defaultValue={endpoint?.url} className={field} />
      </label>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1">
          Events <span className={muted}>— none ticked sends all of them</span>
        </legend>
        {EVENT_TYPES.map((t) => (
          <label key={t.value} className="flex items-center gap-2">
            <input type="checkbox" name="eventType" value={t.value} defaultChecked={endpoint?.eventTypes.includes(t.value)} />
            {t.label}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="includeClientContact" defaultChecked={endpoint?.includeClientContact} />
        <span>
          Include the client’s phone and email <span className={muted}>— off unless this system needs them</span>
        </span>
      </label>
    </>
  );
}

/**
 * W-011 — webhook endpoints. Each one is told about every published change
 * from the moment it is registered, signed with its own secret (shown once).
 */
export function WebhookEndpoints({ endpoints }: { endpoints: EndpointRow[] }) {
  const [state, register, registering] = useActionState(registerEndpoint, initial);
  return (
    <section aria-labelledby="webhooks-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="webhooks-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Webhooks
        </h2>
        <p className={`mt-1 text-sm ${muted}`}>
          Tell another system the moment an appointment changes. Messages are signed, retried when the other end is down, and
          may arrive more than once — the event id says which ones are repeats.
        </p>
      </div>

      <form action={register} className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
        <EndpointFields />
        <div>
          <button type="submit" disabled={registering} className={small}>
            {registering ? 'Registering…' : 'Register endpoint'}
          </button>
        </div>
        <Secret state={state} />
      </form>

      {endpoints.length === 0 ? (
        <p className={`text-sm ${muted}`}>No endpoints registered.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {endpoints.map((e) => (
            <EndpointItem key={e.id} endpoint={e} />
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS_WORD = { active: 'sending', paused: 'paused', disabled: 'switched off' } as const;

function EndpointItem({ endpoint }: { endpoint: EndpointRow }) {
  const [editState, edit, saving] = useActionState(editEndpoint, initial);
  const [statusState, setStatus, changing] = useActionState(changeEndpointStatus, initial);
  const [rotateState, rotate, rotating] = useActionState(rotateSecret, initial);
  const [replayState, replay, replaying] = useActionState(replayFromSeqAction, initial);
  const off = endpoint.status !== 'active';
  return (
    <li className="flex flex-col gap-2 rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 break-all font-medium">{endpoint.url}</span>
        <span className={off ? 'font-medium text-amber-800 dark:text-amber-300' : muted}>{STATUS_WORD[endpoint.status]}</span>
        <span className={muted}>{endpoint.eventTypes.length === 0 ? 'all events' : `${endpoint.eventTypes.length} event types`}</span>
        {endpoint.includeClientContact ? <span className={muted}>with contacts</span> : null}
        {endpoint.consecutiveFailures > 0 ? <span className={muted}>{endpoint.consecutiveFailures} failed in a row</span> : null}
      </div>
      {endpoint.disabledReason ? <p className="text-amber-800 dark:text-amber-300">{endpoint.disabledReason}</p> : null}
      {endpoint.previousSecretUntil ? <p className={muted}>The previous secret also signs until {endpoint.previousSecretUntil}.</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <form action={setStatus}>
          <input type="hidden" name="id" value={endpoint.id} />
          <input type="hidden" name="to" value={off ? 'active' : 'disabled'} />
          <button type="submit" disabled={changing} className={small}>
            {off ? 'Resume' : 'Switch off'}
          </button>
        </form>
        <form action={rotate}>
          <input type="hidden" name="id" value={endpoint.id} />
          <button type="submit" disabled={rotating} className={small}>
            Rotate secret
          </button>
        </form>
        <form action={replay} className="flex items-center gap-1">
          <input type="hidden" name="id" value={endpoint.id} />
          <label className="flex items-center gap-1 text-xs">
            Replay from #
            <input name="fromSeq" type="number" min={1} required defaultValue={Math.max(1, endpoint.cursorSeq)} className={`${field} w-20`} />
          </label>
          <button type="submit" disabled={replaying} className={small}>
            Replay
          </button>
        </form>
      </div>
      <Secret state={rotateState} />
      <p aria-live="polite" className="text-xs">
        {statusState.message ?? replayState.message ?? ''}
      </p>

      <details>
        <summary className="cursor-pointer text-xs font-medium">Edit</summary>
        <form action={edit} className="mt-2 flex flex-col gap-3">
          <input type="hidden" name="id" value={endpoint.id} />
          <EndpointFields endpoint={endpoint} />
          <div>
            <button type="submit" disabled={saving} className={small}>
              Save
            </button>
          </div>
          <p aria-live="polite" className="text-sm">
            {editState.message ?? ''}
          </p>
        </form>
      </details>
    </li>
  );
}

/** W-011 — the delivery log: one row per (endpoint, event), expandable to what was sent and what came back. */
export function DeliveryLog({ deliveries }: { deliveries: DeliveryRow[] }) {
  if (deliveries.length === 0) return <p className={`text-sm ${muted}`}>No deliveries match.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {deliveries.map((d) => (
        <DeliveryItem key={d.id} delivery={d} />
      ))}
    </ul>
  );
}

function DeliveryItem({ delivery: d }: { delivery: DeliveryRow }) {
  const [state, replay, replaying] = useActionState(replayDeliveryAction, initial);
  return (
    <li className="rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs">#{d.seq}</span>
        <span className="font-medium">{d.eventType}</span>
        <span className={d.status === 'dead' || d.status === 'failed' ? 'font-medium text-amber-800 dark:text-amber-300' : muted}>{d.status}</span>
        <span className={muted}>
          {d.attempts} {d.attempts === 1 ? 'attempt' : 'attempts'}
          {d.replayed ? ' · replayed' : ''}
        </span>
        <form action={replay} className="ml-auto">
          <input type="hidden" name="id" value={d.id} />
          <button type="submit" disabled={replaying || d.status === 'sending'} className={small} aria-label={`Replay delivery #${d.seq} ${d.eventType}`}>
            Replay
          </button>
        </form>
      </div>
      <p aria-live="polite" className="text-xs">
        {state.message ?? ''}
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs font-medium">Details</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className={muted}>To</dt>
          <dd className="break-all">{d.endpointUrl}</dd>
          <dt className={muted}>Headers</dt>
          <dd className="break-all font-mono">
            Bookable-Event-Id: {d.eventId}
            <br />
            Bookable-Event-Type: {d.eventType}
            <br />
            Bookable-Delivery-Id: {d.id}
            <br />
            Bookable-Attempt: {d.attempts}
            <br />
            Bookable-Signature: t=…,v1=[redacted]
          </dd>
          <dt className={muted}>First tried</dt>
          <dd>{d.firstAttempt ?? 'not yet'}</dd>
          {d.succeeded ? (
            <>
              <dt className={muted}>Delivered</dt>
              <dd>{d.succeeded}</dd>
            </>
          ) : null}
          {d.nextAttempt ? (
            <>
              <dt className={muted}>Next try</dt>
              <dd>not before {d.nextAttempt}</dd>
            </>
          ) : null}
          <dt className={muted}>Last answer</dt>
          <dd>{d.lastResponseStatus ?? (d.lastError ? 'no response' : '—')}</dd>
          {d.lastError ? (
            <>
              <dt className={muted}>Error</dt>
              <dd className="break-all">{d.lastError}</dd>
            </>
          ) : null}
          {d.lastResponseExcerpt ? (
            <>
              <dt className={muted}>Body</dt>
              <dd className="break-all font-mono">{d.lastResponseExcerpt}</dd>
            </>
          ) : null}
        </dl>
      </details>
    </li>
  );
}
