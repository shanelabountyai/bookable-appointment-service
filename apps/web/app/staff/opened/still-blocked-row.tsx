import Link from 'next/link';
import type { UnreleasedNoShow } from '@bookable/db/appointments';
import { ReleaseButton } from '@/components/release-button';
import { PhoneLink } from '@/components/ui/phone-link';
import { readableInstant } from '@/lib/customer-format';

/**
 * A-102 — a no-show whose time nobody has given back.
 *
 * DELIBERATELY NOT A `FreedSlotRow`. That row's whole vocabulary is about a
 * span that is already sellable — "who wants this slot?", the call marks, the
 * matcher link — and none of it is true here yet. The only thing to do with
 * this row is decide, so the only control on it is the decision.
 *
 * IT CARRIES THE ATTENTION LINE, the same one the no-show chip wears on the
 * day grid (`appointment-chip.tsx`), because it is the same fact seen from the
 * other end: a chair the salon is paying for and nobody is sitting in. Never
 * colour alone (§4) — the heading above it and the sentence on it both say so
 * in words.
 */
export function StillBlockedRow({ row, timezone }: { row: UnreleasedNoShow; timezone: string }) {
  const who = row.clientName ?? 'A walk-in with no name';

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-control border border-attention-line bg-attention-fill p-4">
      <div className="flex flex-col gap-1 text-body">
        <span className="numeric font-medium">
          {readableInstant(row.startAt, timezone)} &middot; {row.minutes} min still blocked
        </span>
        <span className="text-ink-muted">
          {row.serviceNames.join(' + ')} &middot; {row.providerName}
        </span>
        {/* A-091's rule: no pronoun. The record has no gender field, and this
            sentence renders about whoever the appointment names. */}
        <span className="text-ink-secondary">{who} never came, and the rest of the slot is still on the book</span>
        {/* Before giving it back, the desk rings once more — which is the
            reason D-44 refused a timer, so the number belongs on the row that
            offers the release rather than a screen away from it. */}
        {row.clientPhone ? <PhoneLink phone={row.clientPhone} /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ReleaseButton
          appointmentId={row.appointmentId}
          label={`Put ${row.minutes} min back on the market`}
        />
        <Link
          href={`/staff/appointments/${row.appointmentId}`}
          className="inline-flex min-h-11 items-center text-caption text-ink-muted underline underline-offset-4"
        >
          Details
        </Link>
      </div>
    </li>
  );
}
