import Link from 'next/link';
import type { OpenedSlot } from '@bookable/db/appointments';
import type { CallMark } from '@bookable/db/clients';
import { LinkButton } from '@/components/ui/button';
import { PhoneLink } from '@/components/ui/phone-link';
import { readableInstant } from '@/lib/customer-format';
import { freedSlotHref } from '@/lib/waitlist/freed-link';
import { OFFER_WORDS } from '@/lib/waitlist/offer-words';

/**
 * A-091 — `FreedSlotRow` (design brief §5.4.8, §8.6).
 *
 * ITS OWN FILE so §8.6's composition can exist: "`/staff/opened` composed with
 * all five `freedBy` kinds visible at once, one of them already carrying two
 * call marks." The demo book cannot produce that — checkpoint 7 measured zero
 * call marks and A-095 is the row for it — so `/staff/design` draws the five
 * from fixtures, exactly as A-090 drew the eight statuses.
 *
 * A SERVER COMPONENT with no state of its own: everything on the row is
 * derived, nothing is stored (operator R-7), and the only interactive things
 * are a phone number and two links.
 *
 * THE THREE THINGS THE DESIGN HAD TO FIX, all of them length:
 *
 *  - **The reason shared a line with the phone number.** The five kinds are
 *    five different phone calls and the sentence is the whole point of the
 *    row; a `tel:` link trailing off the end of it is not a target on a
 *    tablet. They are two lines now, and the number is 44px tall (§4).
 *  - **The marks were joined with " · " into one line.** Two names, two
 *    outcomes and two callers is a sentence nobody reads at 4pm. It is a list.
 *  - **"She took it" read exactly like "no answer".** It is the one mark that
 *    means STOP RINGING — the second person at the desk has to see it before
 *    dialling — so it carries the positive ink as well as its word.
 */
export function FreedSlotRow({
  slot,
  marks,
  timezone,
}: {
  slot: OpenedSlot;
  /** Everyone already rung about THIS span, oldest first. */
  marks: readonly CallMark[];
  timezone: string;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-control border border-line-hairline bg-ground-raised p-4">
      <div className="flex flex-col gap-1 text-body">
        {/* The span itself: read DOWN the list, so tabular figures (§5.2). */}
        <span className="numeric font-medium">
          {readableInstant(slot.startAt, timezone)} · {slot.freedMinutes} min
        </span>
        <span className="text-ink-muted">
          {slot.serviceNames.join(' + ')} · {slot.providerName}
        </span>
        {/* Who gave it back, and HOW. On the row for the same reason AVAIL-05's
            conflicts and A-021's call-down put it there — "shall we find you
            another time?" is the other half of this errand, and it is the
            wrong sentence for four of the five ways a span gets here (A-067). */}
        <span className="text-ink-secondary">{freedWords(slot, timezone)}</span>
        {slot.clientPhone ? <PhoneLink phone={slot.clientPhone} /> : null}

        {/* A-072. A RECORD, not a hold — the slot below stays sellable to
            anybody throughout. This only stops the second person at the desk
            ringing Mrs Patel again, or promising it to the next name while she
            is still deciding. */}
        {marks.length > 0 ? (
          <div className="mt-1 flex flex-col gap-0.5">
            <span className="text-caption font-medium text-ink-secondary">Already asked</span>
            <ul className="flex flex-col gap-0.5 text-caption">
              {marks.map((mark) => (
                <li
                  key={mark.clientId}
                  className={mark.outcome === 'took_it' ? 'font-medium text-positive-ink' : 'text-ink-muted'}
                >
                  {callSentence(mark)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {slot.primaryServiceId ? (
          <LinkButton
            href={freedSlotHref({
              providerId: slot.providerId,
              serviceId: slot.primaryServiceId,
              startAt: slot.startAt,
              freedMinutes: slot.freedMinutes,
              key: slot.key,
              appointmentId: slot.appointmentId,
            })}
          >
            Who wants this slot?
          </LinkButton>
        ) : null}
        <Link
          href={`/staff/appointments/${slot.appointmentId}`}
          className="inline-flex min-h-11 items-center text-caption text-ink-muted underline underline-offset-4"
        >
          Details
        </Link>
      </div>
    </li>
  );
}

/**
 * A-067. What freed it, in the desk's words — one sentence per kind, because
 * the phone call differs: you offer a cancelled client another time, you offer
 * a dropped colour to the waitlist, and a hand-over is nobody's call at all.
 *
 * The wording lives here rather than in the query for the same reason
 * `event-language.ts` does: `packages/db` returns the structure, the web layer
 * turns it into English.
 *
 * A-091 TOOK THE PRONOUN OUT. Two of the five sentences said "her" about
 * whoever the row happens to name — "Mr Hart dropped her Colour", on a screen
 * the desk reads down the phone. The salon has male clients and the record has
 * no gender field to consult, so the sentence must not assert one.
 */
function freedWords(slot: OpenedSlot, zone: string): string {
  const who = slot.clientName ?? 'a walk-in with no name';
  switch (slot.freedBy.kind) {
    case 'cancelled':
      return `${slot.status === 'cancelled_late' ? 'Cancelled late by' : 'Cancelled by'} ${who}`;
    case 'shortened': {
      const dropped = slot.freedBy.droppedServiceNames;
      // "Mrs Hall dropped the Colour" — and if the visit only got shorter
      // without losing a line, say that instead of naming nothing.
      return dropped.length > 0 ? `${who} dropped the ${listWords(dropped)}` : `${who}'s visit was shortened`;
    }
    case 'rescheduled':
      return `${who} moved to ${readableInstant(slot.freedBy.movedToStartAt, zone)}`;
    case 'reassigned':
      return `${who} went to ${slot.freedBy.movedToProviderName}`;
    // A-069. Never "cancelled by": she did not cancel, she did not come, and
    // the difference is the whole reason the no-show count exists.
    case 'released':
      return `${who} never came — the rest of the time was put back`;
  }
}

/** "colour", "colour and blow-dry", "colour, cut and blow-dry". */
const listWords = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** A-072 — one call, in the desk's words. The NAME first, because the question
 *  being answered is "has anybody rung her yet?" */
function callSentence(mark: CallMark): string {
  const who = mark.clientName ?? 'somebody';
  const by = mark.calledByName ? ` (${mark.calledByName})` : '';
  return `${who} — ${OFFER_WORDS[mark.outcome].toLowerCase()}${by}`;
}
