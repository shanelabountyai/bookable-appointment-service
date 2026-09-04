import { cn } from '@/lib/utils';

/**
 * A-089 — `Badge` (design brief §5.3, §5.5).
 *
 * Built for the three counts §5.5 says must be visible from anywhere: *Opened
 * up (N)*, *Still open (N)*, and messages that failed to send (N). Today two
 * of those are string-concatenated into a link's own text (`Opened up (3)`)
 * and the third is a sentence on `/staff`; A-085 is what puts them in the
 * shell, and this is the thing it puts there.
 *
 * IT IS A NUMBER AND NOTHING ELSE, which is why it has no accessible name of
 * its own. A badge must sit INSIDE the control that names it — `<LinkButton>
 * Opened up <Badge>3</Badge></LinkButton>` reads as "Opened up 3, link". A
 * badge floating beside its label announces a bare "3", which is §4's
 * never-colour-alone rule wearing a different hat: a count with no noun is
 * not information.
 *
 * `.numeric` because these sit in a row and get compared to each other, and a
 * proportional `1` next to a proportional `7` makes two badges different
 * widths for no reason (§5.2).
 *
 * TWO INTENTS, not five. `neutral` is a count; `attention` is a count that
 * means somebody has to do something (failed messages). The other three
 * intent tokens exist in A-088 and get a variant here the day a caller needs
 * one — a variant with no caller has no state anybody has looked at.
 */
export type BadgeIntent = 'neutral' | 'attention';

const INTENT: Record<BadgeIntent, string> = {
  neutral: 'bg-ground-sunken text-ink-secondary',
  attention: 'bg-attention-fill text-attention-ink',
};

export function Badge({
  intent = 'neutral',
  className,
  ...props
}: React.ComponentProps<'span'> & { intent?: BadgeIntent }) {
  return (
    <span
      {...props}
      className={cn(
        'numeric inline-flex min-w-5 items-center justify-center rounded-control px-1.5 py-0.5 text-caption font-medium',
        INTENT[intent],
        className,
      )}
    />
  );
}
