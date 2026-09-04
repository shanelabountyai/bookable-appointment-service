import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * A-089 — `Button` and `Link`-as-button (design brief §5.3, §8.2).
 *
 * FOUR VARIANTS AND NOTHING ELSE, because the audit found four shapes in the
 * staff app and no fifth: a filled zinc-900 button (×7), an outlined one (×7),
 * an outlined amber one for the two destructive-ish controls, and bare text.
 * Every one of them is rebuilt here out of A-088's tokens, so the `dark:`
 * twin that used to ride along on each goes away — `bg-ground-inverted`
 * already flips with the scheme.
 *
 * `pending` IS `disabled`, not a second thing beside it. Every mutating
 * control in this app goes through `useActionState` and hands back a `pending`
 * boolean (§5.3); a pending button that is still clickable is a double
 * submit, and this repo's whole correctness story is about not writing the
 * same appointment twice. It also sets `aria-busy`, so the state is in the
 * accessibility tree and not only in the caller's swapped label.
 *
 * SIZE `md` IS 44px TALL. §4's "primary desk targets are ≥44px on the tablet"
 * is a constraint, not a preference, and today's `px-3 py-2` buttons measure
 * 36. `compact` is the exception the brief allows for dense rows (a chip's
 * controls, a table cell) and makes no touch-target claim — the name is the
 * warning.
 *
 * No focus styling here on purpose: A-088 draws the ring once, globally, on
 * `:focus-visible`, because a link, a `<summary>` and a `tabIndex={0}` scroll
 * region are all keyboard stops and none of them is a Button.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive';
export type ButtonSize = 'md' | 'compact';

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] disabled:cursor-not-allowed disabled:opacity-60';

const SIZE: Record<ButtonSize, string> = {
  md: 'min-h-11 px-3 py-2 text-body',
  compact: 'px-2 py-1 text-caption',
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ground-inverted text-ink-inverted hover:opacity-90',
  secondary: 'border border-line-control text-ink-primary hover:bg-ground-sunken',
  quiet: 'text-ink-secondary hover:bg-ground-sunken hover:text-ink-primary',
  // Never colour alone (§4): the danger ink is on top of a word that already
  // says what happens — "Cancel appointment", "Delete". It is not the message.
  destructive: 'border border-danger-line text-danger-ink hover:bg-danger-fill',
};

/** `variant` defaults to `secondary`: emphasis is something a caller opts
 *  into, and a screen where every button is primary has no primary. */
export function Button({
  variant = 'secondary',
  size = 'md',
  pending = false,
  disabled,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cn(BASE, SIZE[size], VARIANT[variant], className)}
    />
  );
}

/**
 * The same shape as a link, and it stays a LINK — role, middle-click, "open in
 * new tab" and the browser's own history all intact. The day toolbar is seven
 * of these; every one of them is a URL the desk needs to be able to keep open
 * on a second tab.
 *
 * No `pending` and no `disabled`: a navigation has neither. A control that
 * needs them is a Button and belongs in a form.
 */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link {...props} className={cn(BASE, SIZE[size], VARIANT[variant], className)} />;
}
