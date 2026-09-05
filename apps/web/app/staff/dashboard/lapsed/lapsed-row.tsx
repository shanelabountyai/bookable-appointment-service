import Link from 'next/link';
import type { LapsedClient } from '@bookable/db/reports';
import { isCallStale } from '@bookable/db/reports';
import type { CallMark } from '@bookable/db/clients';
import { PhoneLink } from '@/components/ui/phone-link';
import { CallMarkButtons } from '@/components/call-mark-buttons';
import { readableInstant } from '@/lib/customer-format';
import { OFFER_WORDS } from '@/lib/waitlist/offer-words';
import { recordOffer } from '@/lib/waitlist/offer-actions';

/**
 * A-092 — `LapsedRow` (design brief §8.6a).
 *
 * "The only screen in the product a person works *down*, thirty rows long, each
 * row a phone call waiting to be made. The row has to survive that length."
 *
 * ITS OWN FILE for the reason `FreedSlotRow` has one: §8.6a's composition is a
 * LONG list and the demo book cannot produce one (checkpoint 7 measured zero
 * call marks anywhere — A-095), so `/staff/design` draws it from fixtures.
 *
 * MEASURED AT THIRTY ROWS ON A 1024×768 TABLET before any of this was changed:
 * the list is 5044px, **6.6 screens**, and the row is 134px. What that length
 * does to the row is the whole item:
 *
 *  - **The number was a 16px target 3.9px from a link that navigates away.**
 *    The one action every row exists for, at a third of §4's 44px bar, glued to
 *    the client record — and the mis-tap does not just waste a tap, it leaves a
 *    6.6-screen list and returns you to the top of it. Fixed in `PhoneLink`,
 *    which is where the other seven copies of the same 16px link were.
 *  - **The report was dark-scheme AA-failing, and its axe test could not see
 *    it.** `text-zinc-500` on the back link is 4.1:1 on #0a0a0a (checkpoint 7's
 *    value, this page's turn); the spec had never run axe in dark and seeded
 *    one row with NO call mark, so the mark line — the half of the row that is
 *    only drawn once somebody has started working the list — had never been
 *    measured at all.
 *  - **The marks say nothing about WHO they belong to in the accessibility
 *    tree.** Thirty rows × five buttons is 150 controls drawn from five words.
 *
 * NO PRONOUN, anywhere on the row (A-091). The record has no gender field and
 * this is read down a phone in a salon with male clients.
 */
export function LapsedRow({
  row,
  mark,
  now,
  weeks,
  timezone,
}: {
  row: LapsedClient;
  /** The call that stands about THIS client, if anybody has made one. */
  mark: CallMark | undefined;
  /** Injected, never read here — `isCallStale` is derived on every read. */
  now: Date;
  /** The report's own window, which is also the staleness rule (A-077). */
  weeks: number;
  timezone: string;
}) {
  const name = row.name ?? 'No name';
  const stale = mark ? isCallStale(mark.calledAt, now, weeks) : false;

  return (
    <li className="flex flex-col gap-2 rounded-control border border-line-hairline bg-ground-raised p-4 text-body">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <Link href={`/staff/clients/${row.clientId}`} className="font-medium underline underline-offset-4">
          {name}
        </Link>
        {/* The column the eye runs down: tabular figures, so 8 and 30 weeks
            line up on the same edge over thirty rows (§5.2). */}
        <span className="numeric font-medium">{row.weeksSince} weeks</span>
      </div>

      <span className="numeric text-ink-muted">
        Last in {readableInstant(row.lastVisitAt, timezone)} · {row.lastServiceNames.join(' + ')} ·{' '}
        {row.lastProviderName} · {money(row.lastSpendCents)}
      </span>

      {/* THE ROW'S REASON FOR EXISTING, on its own line and at the desk's own
          target size. Beside the name it was a 16px tap next to a 16px tap. */}
      {row.phone ? (
        <PhoneLink phone={row.phone} />
      ) : (
        <span className="text-caption text-ink-muted">No number on the record</span>
      )}

      {/* A-072's marks, reused. Thirty calls do not happen in one sitting, and
          a list that forgets is a list that gets copied onto paper.
          `subject: lapsed` rather than a freed slot's key, and the last
          completed visit is the mark's FK — the visit the call is about. That
          SUBJECT is the only thing that differs from the waitlist matcher's use
          of this control (§5.4.9). */}
      <CallMarkButtons
        words={OFFER_WORDS}
        current={mark?.outcome}
        hidden={{ subject: 'lapsed', appointmentId: row.lastAppointmentId, clientId: row.clientId }}
        action={recordOffer}
        undoLabel="Not asked"
        about={name}
      />

      {/* A-077. WHEN, not only what and who: the lapsed round is quarterly, so
          without a date the owner reads "left a message — Priya" in October
          about a call made in June and skips the name. A mark older than the
          report's own window reads as STALE rather than as handled — derived on
          every read, and the mark itself is never deleted because somebody did
          make that call. The colour is never the message (§4): the sentence
          says "worth ringing again" in words. */}
      {mark ? (
        <span className={stale ? 'text-caption font-medium text-attention-ink' : 'text-caption text-ink-muted'}>
          {OFFER_WORDS[mark.outcome]}
          {mark.calledByName ? ` — ${mark.calledByName}` : ''} · {readableInstant(mark.calledAt, timezone)}
          {stale ? ' · worth ringing again' : ''}
        </span>
      ) : null}
    </li>
  );
}

/** Integer cents, formatted once. Never arithmetic on a formatted string. */
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
