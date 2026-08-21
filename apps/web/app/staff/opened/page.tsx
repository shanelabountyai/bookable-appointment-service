import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listOpenedSlots } from '@bookable/db/appointments';
import { requireStaff } from '@/lib/auth/session';
import { readableInstant } from '@/lib/customer-format';
import { freedSlotHref } from '@/lib/waitlist/freed-link';

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

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/staff/day" className="text-sm text-zinc-500 hover:underline">
          ← Today
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">What&apos;s opened up</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Recently cancelled, still in the future, and nobody has taken it yet. Soonest to expire first.
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
              key={slot.appointmentId}
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
                  {/* Who gave it back. On the row for the same reason AVAIL-05's
                      conflicts and A-021's call-down put it there — "shall we
                      find you another time?" is the other half of this errand. */}
                  {slot.status === 'cancelled_late' ? 'Cancelled late by' : 'Cancelled by'}{' '}
                  {slot.clientName ?? 'a walk-in with no name'}
                  {slot.clientPhone ? (
                    <>
                      {' · '}
                      <a href={`tel:${slot.clientPhone}`} className="underline underline-offset-4">
                        {slot.clientPhone}
                      </a>
                    </>
                  ) : null}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {slot.primaryServiceId ? (
                  <Link
                    href={freedSlotHref({
                      providerId: slot.providerId,
                      serviceId: slot.primaryServiceId,
                      startAt: slot.startAt,
                      freedMinutes: slot.freedMinutes,
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
