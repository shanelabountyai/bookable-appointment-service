import Link from 'next/link';
import { prisma } from '@bookable/db';
import { type OpenedSlot, listOpenedSlots } from '@bookable/db/appointments';
import { type CallMark, listCallMarks } from '@bookable/db/clients';
import { requireStaff } from '@/lib/auth/session';
import { readableInstant } from '@/lib/customer-format';
import { freedSlotHref } from '@/lib/waitlist/freed-link';
import { OFFER_WORDS } from '@/lib/waitlist/offer-words';

export const dynamic = 'force-dynamic';

/**
 * A-043 — WHAT'S OPENED UP (WAIT-02's missing entry point).
 *
 * The matching machinery has been built and good since A-023 and had exactly
 * one door: a URL assembled on the cancelled appointment's own detail page. So
 * "who wants this slot?" required already knowing WHICH appointment was
 * cancelled — the one thing the desk does not know when the cancellation came
 * in through a manage link on a Saturday.
 *
 * A-067 — and a cancellation was never the only thing that frees time. A visit
 * shortened at the chair, a move off the day and a hand-over to another stylist
 * all leave a sellable span behind, and until now none of them reached this
 * screen. Each row says WHAT freed it in the desk's own words, because the
 * follow-up call is a different call: "shall we find you another time?" is not
 * what you say about the ninety minutes Mrs Hall just gave back.
 *
 * Derived on every read, nothing stored (operator R-7), and ordered by how
 * soon the time expires: a Thursday 2pm dies on Thursday at 2.
 */
export default async function OpenedPage() {
  const staff = await requireStaff();
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });

  const slots = await listOpenedSlots(prisma, { businessId: staff.businessId, now: new Date() });
  // A-072. Who has already been rung about each of these, in ONE read for the
  // whole list. This screen is where the second person at the desk starts at
  // 4pm, so it is the screen that has to say "Mrs Patel is thinking about it"
  // before anybody dials.
  const marks = await listCallMarks(prisma, {
    businessId: staff.businessId,
    subjects: slots.map((slot) => `freed:${slot.key}`),
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/staff/day" className="text-sm text-zinc-500 hover:underline">
          ← Today
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">What&apos;s opened up</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Recently freed — cancelled, shortened, moved or handed over — still in the future, and nobody has taken
          it yet. Soonest to expire first.
        </p>
      </div>

      {slots.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          Nothing has opened up lately — or everything that did has already been filled.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {slots.map((slot) => (
            <li
              key={slot.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
            >
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-medium">
                  {readableInstant(slot.startAt, business.timezone)} · {slot.freedMinutes} min
                </span>
                <span className="text-zinc-600 dark:text-zinc-400">
                  {slot.serviceNames.join(' + ')} · {slot.providerName}
                </span>
                <span className="text-zinc-600 dark:text-zinc-400">
                  {/* Who gave it back, and HOW. On the row for the same reason
                      AVAIL-05's conflicts and A-021's call-down put it there —
                      "shall we find you another time?" is the other half of
                      this errand, and it is the wrong sentence for three of the
                      four ways a span gets here (A-067). */}
                  {freedWords(slot, business.timezone)}
                  {slot.clientPhone ? (
                    <>
                      {' · '}
                      <a href={`tel:${slot.clientPhone}`} className="underline underline-offset-4">
                        {slot.clientPhone}
                      </a>
                    </>
                  ) : null}
                </span>
                {/* A-072. A RECORD, not a hold — the slot below stays sellable
                    to anybody throughout. This only stops the second person at
                    the desk ringing Mrs Patel again, or promising it to the
                    next name while she is still deciding. */}
                {(marks.get(`freed:${slot.key}`) ?? []).length > 0 ? (
                  <span className="text-zinc-600 dark:text-zinc-400">
                    Already asked: {(marks.get(`freed:${slot.key}`) ?? []).map(callSentence).join(' · ')}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                {slot.primaryServiceId ? (
                  <Link
                    href={freedSlotHref({
                      providerId: slot.providerId,
                      serviceId: slot.primaryServiceId,
                      startAt: slot.startAt,
                      freedMinutes: slot.freedMinutes,
                      key: slot.key,
                      appointmentId: slot.appointmentId,
                    })}
                    className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600"
                  >
                    Who wants this slot?
                  </Link>
                ) : null}
                <Link
                  href={`/staff/appointments/${slot.appointmentId}`}
                  className="text-xs text-zinc-500 underline underline-offset-4"
                >
                  Details
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
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
 */
function freedWords(slot: OpenedSlot, zone: string): string {
  const who = slot.clientName ?? 'a walk-in with no name';
  switch (slot.freedBy.kind) {
    case 'cancelled':
      return `${slot.status === 'cancelled_late' ? 'Cancelled late by' : 'Cancelled by'} ${who}`;
    case 'shortened': {
      const dropped = slot.freedBy.droppedServiceNames;
      // "Mrs Hall dropped her colour" — and if the visit only got shorter
      // without losing a line, say that instead of naming nothing.
      return dropped.length > 0 ? `${who} dropped her ${listWords(dropped)}` : `${who}'s visit was shortened`;
    }
    case 'rescheduled':
      return `${who} moved to ${readableInstant(slot.freedBy.movedToStartAt, zone)}`;
    case 'reassigned':
      return `${who} went to ${slot.freedBy.movedToProviderName}`;
    // A-069. Never "cancelled by": she did not cancel, she did not come, and
    // the difference is the whole reason the no-show count exists.
    case 'released':
      return `${who} never came — the rest of her time was put back`;
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
