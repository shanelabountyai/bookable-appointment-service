import { cn } from '@/lib/utils';

/**
 * A-089 — `Field` and `Input` (design brief §5.3, §8.2).
 *
 * WHY CHILDREN IS A FUNCTION. A field's whole job is wiring: the label's
 * `htmlFor`, the control's `id`, `aria-describedby` pointing at the hint AND
 * the error, and `aria-invalid` when there is one. Those ids are ONE fact, and
 * every other way of doing it writes the fact down twice — a caller that
 * passes `id` to both `<Field>` and `<Input>`, or a `Field` that derives
 * `${id}-hint` while `Input` independently derives the same string. Two copies
 * of one fact under two names is the defect class this repo keeps finding one
 * layer down; the render prop hands the control the ids that were computed
 * once, and the compiler will not let a caller forget to spread them.
 *
 * (`cloneElement` would hide the same wiring and silently do nothing if the
 * child is ever wrapped. `useId` and context both need `'use client'`, and
 * these are server components — the client search box, the settings forms and
 * every filter in the product render on the server.)
 *
 * THE ERROR SLOT IS A LIVE REGION, and that is why its rule is about
 * `undefined` rather than about truthiness. An `aria-live` element has to
 * EXIST before the text lands in it, or nothing is announced; a `<p>` that
 * appears at the same moment as its own error is silent. So:
 *
 *   - `error` omitted entirely → no element, no reserved space. For a field
 *     that cannot fail (the client search box).
 *   - `error={state.error ?? ''}` → the element is always there, empty at
 *     rest, and the announcement works. The line it reserves is also what
 *     stops the form jumping when the error arrives (§4: nothing may jump).
 */
export function Field({
  id,
  label,
  labelHidden = false,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  labelHidden?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  children: (control: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
  }) => React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={id}
        className={cn('text-caption font-medium text-ink-secondary', labelHidden && 'sr-only')}
      >
        {label}
      </label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}

      {hint === undefined ? null : (
        <p id={hintId} className="text-caption text-ink-muted">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} aria-live="polite" className="text-caption font-medium text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A plain `<input>`, sized to the desk's 44px target like `Button` (§4), and
 * carrying its own invalid state off `aria-invalid` rather than off a second
 * prop — the attribute is what the screen reader reads, so making it the thing
 * that also draws the border means the two can never disagree.
 *
 * The red border is never the message: `Field` renders the error text beside
 * it (§4, never colour alone).
 */
export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={cn(
        'min-h-11 rounded-control border border-line-control bg-transparent px-3 py-2 text-body text-ink-primary placeholder:text-ink-muted aria-[invalid=true]:border-danger-line',
        className,
      )}
    />
  );
}
