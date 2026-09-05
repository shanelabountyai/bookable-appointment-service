import { cn } from '@/lib/utils';

/**
 * A-092 — `PhoneLink` (design brief §4, §5.3).
 *
 * THE FINDING BEHIND IT. §8.6a calls `/staff/dashboard/lapsed` "the only screen
 * in the product a person works *down*… thirty rows long, each row a phone call
 * waiting to be made", and on that screen the thing you tap to make the call
 * measured **16px tall and 3.9px from a link that navigates away**:
 *
 *     Client Number 0   x=105  w=109  h=16      → /staff/clients/<id>
 *     5125551029        x=218  w=78   h=16      → tel:
 *
 * §4's bar is 44px on the tablet and it is a correctness rule, not a
 * preference. The harm of the mis-tap is not a wasted tap: the neighbour is the
 * client record, so it leaves a list that measured **5044px — 6.6 screens** on
 * a 1024×768 tablet, and coming back puts you at the top of it with no memory
 * of which of the thirty you had reached.
 *
 * IT WAS NEVER ONE COMPONENT, which is why A-091 fixing it did not fix it, and
 * why A-091's own note about it undercounted. That item gave `FreedSlotRow`'s
 * copy `min-h-11` and left behind: *"the `tel:` links on the waitlist, lapsed
 * and call-down rows are still inline `text-sm`; only the freed row's got a
 * target."* Three. A grep says **eight** — those three plus the appointment
 * detail, the stranded list on Providers, the conflicts list, the day column's
 * ring-round and `/staff/opened` itself. A list of known copies written from
 * memory is the same defect as the copies: nobody counted, so seven stayed at
 * 16px. Nothing in the gate can see it either — 44px is WCAG 2.5.5 (AAA) and
 * the AA rule CI runs is 2.5.8 at 24px — so the fix is one component, every
 * caller, a test that MEASURES a rendered box, and a structural guard that
 * fails on the ninth copy rather than on somebody remembering to look.
 *
 * THE HREF IS SANITISED HERE. Every staff call site interpolated the stored
 * string straight into `tel:`, so a number typed as "(512) 555-0188" dialled
 * nothing. `telHref` on the public site has stripped it since the marketing
 * pages were built; the staff app — where the calls are actually made — never
 * did.
 *
 * `.numeric` because these are read DOWN a list and compared (§5.2), and
 * `self-start` so a 44px target inside a `flex-col` does not stretch to the
 * row's full width and swallow taps meant for the row.
 */
export function PhoneLink({
  phone,
  className,
  ...props
}: Omit<React.ComponentProps<'a'>, 'href' | 'children'> & { phone: string }) {
  return (
    <a
      {...props}
      href={`tel:${phone.replace(/[^\d+]/g, '')}`}
      className={cn(
        'numeric inline-flex min-h-11 items-center self-start text-ink-primary underline underline-offset-4',
        className,
      )}
    >
      {phone}
    </a>
  );
}
