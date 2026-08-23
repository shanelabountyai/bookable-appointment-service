'use client';

import { useActionState, useState } from 'react';
import type { ProviderRow } from '@bookable/db/settings';
import { type FormState, editService, toggleQualification, toggleServiceActive } from '@/lib/settings/service-actions';
import { type SegmentDraft, SegmentEditor } from './segment-editor';
import { ServiceFormFields } from './service-form-fields';

const initial: FormState = {};

interface ServiceCardProps {
  service: {
    id: string;
    name: string;
    durationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    priceCents: number;
    active: boolean;
    cancellationCutoffMinutes: number | null;
    requiredResourceTypeId: string | null;
  };
  providers: ProviderRow[];
  /** A-046 (RES-01) — the choices for "Needs", empty when none are defined. */
  resourceTypes: { id: string; name: string }[];
  qualifications: Array<{ providerId: string; durationOverrideMinutes: number | null; priceOverrideCents: number | null }>;
  segments: SegmentDraft[];
}

export function ServiceCard({ service, providers, resourceTypes, qualifications, segments }: ServiceCardProps) {
  const [editState, editAction, editPending] = useActionState(editService, initial);
  const [toggleState, toggleAction, togglePending] = useActionState(toggleServiceActive, initial);
  const [pendingConfirm, setPendingConfirm] = useState(false);

  const needsConfirm = toggleState.errors?._confirm;

  return (
    <li className="rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={service.active ? 'font-medium' : 'font-medium text-zinc-400 line-through'}>{service.name}</span>
          {!service.active && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              Deactivated
            </span>
          )}
        </div>

        {/* Deactivate/reactivate (SVC-03). A refusal because of future
            appointments surfaces the count and a confirm button — nothing can
            produce that count before A-009, but the mechanism is real. */}
        <form
          action={(fd) => {
            if (pendingConfirm) fd.set('confirm', 'true');
            toggleAction(fd);
          }}
        >
          <input type="hidden" name="serviceId" value={service.id} />
          <input type="hidden" name="active" value={service.active ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={togglePending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {service.active ? 'Deactivate' : 'Reactivate'}
          </button>
        </form>
      </div>

      {needsConfirm && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p>{needsConfirm}</p>
          <button
            type="button"
            onClick={() => setPendingConfirm(true)}
            className="mt-2 rounded-md border border-amber-600 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900"
          >
            Deactivate anyway
          </button>
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-sm text-zinc-500">Edit</summary>
        <form action={editAction} className="mt-3 flex flex-col gap-4">
          <input type="hidden" name="serviceId" value={service.id} />
          <ServiceFormFields
            idPrefix={`edit-${service.id}`}
            defaults={service}
            resourceTypes={resourceTypes}
            errors={editState.errors}
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={editPending}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {editPending ? 'Saving…' : 'Save'}
            </button>
            <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
              {editState.ok ? editState.message : ''}
            </p>
          </div>
        </form>
      </details>

      <SegmentEditor
        serviceId={service.id}
        serviceName={service.name}
        durationMinutes={service.durationMinutes}
        segments={segments}
      />

      <details>
        <summary className="mt-2 cursor-pointer text-sm text-zinc-500">
          Qualified providers ({qualifications.length}/{providers.length})
        </summary>
        <ul className="mt-3 flex flex-col gap-2">
          {providers.map((provider) => (
            <QualificationRow
              key={provider.id}
              serviceId={service.id}
              provider={provider}
              qualification={qualifications.find((q) => q.providerId === provider.id) ?? null}
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

function QualificationRow({
  serviceId,
  provider,
  qualification,
}: {
  serviceId: string;
  provider: ProviderRow;
  qualification: { durationOverrideMinutes: number | null; priceOverrideCents: number | null } | null;
}) {
  const [state, action, pending] = useActionState(toggleQualification, initial);
  const qualified = qualification !== null;

  return (
    <li className="flex flex-col gap-2 border-b border-zinc-100 pb-2 last:border-0 dark:border-zinc-900">
      <form action={action} className="flex items-center gap-3">
        <input type="hidden" name="serviceId" value={serviceId} />
        <input type="hidden" name="providerId" value={provider.id} />
        <input type="hidden" name="qualified" value={qualified ? 'false' : 'true'} />
        <span className="w-24 text-sm">{provider.displayName}</span>
        {!qualified && (
          <>
            <label className="sr-only" htmlFor={`${serviceId}-${provider.id}-dur`}>
              Duration override for {provider.displayName}
            </label>
            <input
              id={`${serviceId}-${provider.id}-dur`}
              name="durationOverrideMinutes"
              type="number"
              min={1}
              placeholder="duration override"
              className="w-32 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <label className="sr-only" htmlFor={`${serviceId}-${provider.id}-price`}>
              Price override for {provider.displayName}
            </label>
            <input
              id={`${serviceId}-${provider.id}-price`}
              name="priceOverrideCents"
              type="number"
              min={0}
              placeholder="price override (cents)"
              className="w-36 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {qualified ? 'Remove' : 'Qualify'}
        </button>
      </form>
      {/* EVERY error, not just the confirm prompt. This rendered `_confirm`
          alone until A-029, so a ServiceRejected on an override — a zero
          duration, a price that is not an integer, and now SEG-02's
          "the gap never shortens" — made the button do nothing and say
          nothing. One list, so a new rejection reason cannot go silent. */}
      {Object.values(state.errors ?? {}).map((message) => (
        <p key={message} className="text-xs text-amber-700 dark:text-amber-400">
          {message}
        </p>
      ))}
      {qualified && (
        <p className="pl-24 text-xs text-zinc-500">
          {qualification!.durationOverrideMinutes !== null && `${qualification!.durationOverrideMinutes} min`}
          {qualification!.durationOverrideMinutes !== null && qualification!.priceOverrideCents !== null && ' · '}
          {qualification!.priceOverrideCents !== null && `${qualification!.priceOverrideCents}¢`}
          {qualification!.durationOverrideMinutes === null && qualification!.priceOverrideCents === null && 'standard rate'}
        </p>
      )}
    </li>
  );
}
