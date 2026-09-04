import { cn } from '@/lib/utils';

/**
 * A-089 — `EmptyState` (design brief §5.3).
 *
 * One element, and that is the whole point: "nothing here" is said in six
 * places in the staff app today, each as its own `<p className="text-zinc-500">`,
 * and A-085, A-091 and A-092 are each about to add more. Centralising it is
 * not about the paragraph; it is so the day somebody decides an empty list
 * deserves a border or an icon, it happens once.
 *
 * No `action` slot, no illustration, no bordered box. Nothing in the product
 * has one, and the shell items that follow can add it when they have a caller.
 */
export function EmptyState({ className, ...props }: React.ComponentProps<'p'>) {
  return <p {...props} className={cn('text-body text-ink-muted', className)} />;
}
