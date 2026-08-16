'use client';

/** Shared field markup for both the add form and each service's edit form —
 *  SVC-01's field list, once. */
export function ServiceFormFields({
  idPrefix,
  defaults,
  errors,
}: {
  idPrefix: string;
  defaults?: {
    name: string;
    durationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    priceCents: number;
    cancellationCutoffMinutes: number | null;
  };
  errors?: Record<string, string>;
}) {
  const inputClass =
    'rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950 aria-[invalid=true]:border-red-500';
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2 flex flex-col gap-1.5">
        <label htmlFor={id('name')} className="text-sm font-medium">
          Name
        </label>
        <input
          id={id('name')}
          name="name"
          defaultValue={defaults?.name}
          aria-invalid={errors?.name ? true : undefined}
          aria-describedby={errors?.name ? id('name-error') : undefined}
          className={inputClass}
        />
        {errors?.name && (
          <p id={id('name-error')} className="text-sm text-red-600 dark:text-red-400">
            {errors.name}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={id('durationMinutes')} className="text-sm font-medium">
          Duration (minutes)
        </label>
        <input
          id={id('durationMinutes')}
          name="durationMinutes"
          type="number"
          min={1}
          defaultValue={defaults?.durationMinutes ?? 30}
          aria-invalid={errors?.durationMinutes ? true : undefined}
          className={inputClass}
        />
        {errors?.durationMinutes && <p className="text-sm text-red-600 dark:text-red-400">{errors.durationMinutes}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={id('priceCents')} className="text-sm font-medium">
          Price (cents)
        </label>
        <input
          id={id('priceCents')}
          name="priceCents"
          type="number"
          min={0}
          defaultValue={defaults?.priceCents ?? 0}
          aria-invalid={errors?.priceCents ? true : undefined}
          className={inputClass}
        />
        {errors?.priceCents && <p className="text-sm text-red-600 dark:text-red-400">{errors.priceCents}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={id('bufferBeforeMinutes')} className="text-sm font-medium">
          Buffer before (minutes)
        </label>
        <input
          id={id('bufferBeforeMinutes')}
          name="bufferBeforeMinutes"
          type="number"
          min={0}
          defaultValue={defaults?.bufferBeforeMinutes ?? 0}
          aria-invalid={errors?.bufferBeforeMinutes ? true : undefined}
          className={inputClass}
        />
        {errors?.bufferBeforeMinutes && (
          <p className="text-sm text-red-600 dark:text-red-400">{errors.bufferBeforeMinutes}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={id('bufferAfterMinutes')} className="text-sm font-medium">
          Buffer after (minutes)
        </label>
        <input
          id={id('bufferAfterMinutes')}
          name="bufferAfterMinutes"
          type="number"
          min={0}
          defaultValue={defaults?.bufferAfterMinutes ?? 0}
          aria-invalid={errors?.bufferAfterMinutes ? true : undefined}
          className={inputClass}
        />
        {errors?.bufferAfterMinutes && (
          <p className="text-sm text-red-600 dark:text-red-400">{errors.bufferAfterMinutes}</p>
        )}
      </div>

      <div className="col-span-2 flex flex-col gap-1.5">
        <label htmlFor={id('cancellationCutoffMinutes')} className="text-sm font-medium">
          Cancellation cutoff (minutes) — blank inherits the business default
        </label>
        <input
          id={id('cancellationCutoffMinutes')}
          name="cancellationCutoffMinutes"
          type="number"
          min={0}
          defaultValue={defaults?.cancellationCutoffMinutes ?? ''}
          aria-invalid={errors?.cancellationCutoffMinutes ? true : undefined}
          aria-describedby={errors?.cancellationCutoffMinutes ? id('cutoff-error') : undefined}
          className={inputClass}
        />
        {errors?.cancellationCutoffMinutes && (
          <p id={id('cutoff-error')} className="text-sm text-red-600 dark:text-red-400">
            {errors.cancellationCutoffMinutes}
          </p>
        )}
      </div>
    </div>
  );
}
