import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listOpenedSlots } from '@bookable/db/appointments';
import { listCallMarks } from '@bookable/db/clients';
import { requireStaff } from '@/lib/auth/session';
import { EmptyState } from '@/components/ui/empty-state';
import { FreedSlotRow } from './freed-slot-row';

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
        <Link href="/staff/day" className="text-body text-ink-muted hover:underline">
          &larr; Today
        </Link>
        <h1 className="mt-1 text-page-title font-semibold tracking-tight">What&apos;s opened up</h1>
        <p className="mt-1 text-body text-ink-muted">
          Recently freed &mdash; cancelled, shortened, moved or handed over &mdash; still in the future, and nobody
          has taken it yet. Soonest to expire first.
        </p>
      </div>

      {slots.length === 0 ? (
        <EmptyState>Nothing has opened up lately &mdash; or everything that did has already been filled.</EmptyState>
      ) : (
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
      )}
    </main>
  );
}
