import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listOpenedSlots, listUnreleasedNoShows } from '@bookable/db/appointments';
import { listCallMarks } from '@bookable/db/clients';
import { requireStaff } from '@/lib/auth/session';
import { EmptyState } from '@/components/ui/empty-state';
import { FreedSlotRow } from './freed-slot-row';
import { StillBlockedRow } from './still-blocked-row';

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

  // ONE clock for both lists. They are two halves of one question — what can
  // this salon still sell today — and two `new Date()`s a query apart is how a
  // row appears on one and not the other on the minute a no-show's body ends.
  const now = new Date();

  const slots = await listOpenedSlots(prisma, { businessId: staff.businessId, now });
  // A-102. Time that is still BLOCKED and nobody is coming for. Not a fifth
  // `freedBy` kind: `listOpenedSlots` ends with a still-empty bound, and this
  // span is not empty — it is held by the no-show itself, which is the whole
  // finding. It goes ABOVE the freed list because it is the only thing on this
  // screen that expires while the desk reads it, and because it is the only
  // thing on it that needs a decision rather than a phone call.
  const stillBlocked = await listUnreleasedNoShows(prisma, { businessId: staff.businessId, now });
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
        <Link href="/staff/day" className="text-body text-ink-muted hover:underline">
          &larr; Today
        </Link>
        <h1 className="mt-1 text-page-title font-semibold tracking-tight">What&apos;s opened up</h1>
        <p className="mt-1 text-body text-ink-muted">
          Recently freed &mdash; cancelled, shortened, moved or handed over &mdash; still in the future, and nobody
          has taken it yet. Soonest to expire first.
        </p>
      </div>

      {stillBlocked.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-section font-semibold tracking-tight">Nobody came &mdash; still blocked</h2>
            <p className="mt-1 text-body text-ink-muted">
              A no-show keeps the time on the book, which is right for the record. Giving the rest of it back is a
              decision, never a timer &mdash; they may be eight minutes away.
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            {stillBlocked.map((row) => (
              <StillBlockedRow key={row.appointmentId} row={row} timezone={business.timezone} />
            ))}
          </ul>
        </section>
      )}

      {/* The empty state answers for the WHOLE screen, so it asks about both
          lists. A page saying "nothing has opened up" above a no-show with
          seventy minutes on it is the screen contradicting itself. */}
      {slots.length === 0 && stillBlocked.length === 0 ? (
        <EmptyState>Nothing has opened up lately &mdash; or everything that did has already been filled.</EmptyState>
      ) : null}

      {slots.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {slots.map((slot) => (
            <FreedSlotRow
              key={slot.key}
              slot={slot}
              marks={marks.get(`freed:${slot.key}`) ?? []}
              timezone={business.timezone}
            />
          ))}
        </ul>
      ) : null}
    </main>
  );
}
