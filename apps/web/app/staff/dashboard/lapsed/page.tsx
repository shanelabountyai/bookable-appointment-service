import Link from 'next/link';
import { prisma } from '@bookable/db';
import { LAPSED_WEEKS, listLapsedClients } from '@bookable/db/reports';
import { listCallMarks } from '@bookable/db/clients';
import { requireOwner } from '@/lib/auth/session';
import { readableInstant } from '@/lib/customer-format';
import { OFFER_WORDS } from '@/lib/waitlist/offer-words';
import { LapsedCallButtons } from './call-buttons';

export const dynamic = 'force-dynamic';

/**
 * A-073 — THE CLIENTS WHO HAVE STOPPED COMING (RPT-01, CLIENT-02).
 *
 * Tuesday is at 45% and the owner has no list to ring: three hundred clients,
 * eighty of them on a six-week cycle who have not been in for fourteen weeks,
 * and the only way to find them before this page was to read the client list
 * one record at a time. A-040 fixed the other half — rebooking at the checkout
 * — and this is the largest untapped lever left.
 *
 * OWNER-ONLY, like every other dashboard surface (D-36/A-050). This is a list
 * of the salon's own commercial weak spots, and the three people at the
 * terminal reading it is a different product from the one D-36 chose.
 *
 * N IS A NUMBER ON THE REPORT, not a setting: a salon on a six-week cycle and
 * one on a twelve-week cycle both want to slide it while looking at the
 * answer, and a settings page nobody tunes is a setting that is always wrong.
 *
 * IT REMEMBERS WHO HAS BEEN RUNG, using A-072's marks — the same mechanism,
 * the same four answers, and the reason the table is called `ClientCallMark`
 * rather than `FreedSlotOffer`. A lapsed list without that is a Post-it within
 * a week, because thirty calls do not happen in one sitting.
 */
export default async function LapsedPage({ searchParams }: PageProps<'/staff/dashboard/lapsed'>) {
  const staff = await requireOwner();
  const params = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });

  const asked = typeof params.weeks === 'string' ? Number(params.weeks) : NaN;
  const weeks = Number.isFinite(asked) && asked >= 1 && asked <= 260 ? Math.floor(asked) : LAPSED_WEEKS;

  const rows = await listLapsedClients(prisma, { businessId: staff.businessId, now: new Date(), weeks });
  // One read for the whole list. `lapsed` is one subject for every client, so
  // her mark is cleared the same way a freed slot's is: she books, and she
  // leaves the report.
  const marks = (await listCallMarks(prisma, { businessId: staff.businessId, subjects: ['lapsed'] })).get('lapsed') ?? [];
  const markFor = (clientId: string) => marks.find((mark) => mark.clientId === clientId);

  const total = rows.reduce((sum, row) => sum + row.lastSpendCents, 0);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/staff/dashboard" className="text-sm text-zinc-500 hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Not been in for a while</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Last visit more than {weeks} weeks ago, nothing in the book, and nothing on their record. Longest away
          first.
        </p>
      </div>

      {/* The number, ON the report. A GET form so the answer is a URL the
          owner can keep, and so it needs no client JavaScript at all. */}
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          Away for more than (weeks)
          <input
            type="number"
            name="weeks"
            min={1}
            max={260}
            defaultValue={weeks}
            className="w-28 rounded-md border border-zinc-400 bg-transparent px-3 py-2 dark:border-zinc-600"
          />
        </label>
        <button
          type="submit"
          className="rounded-md border border-zinc-400 px-3 py-2 font-medium dark:border-zinc-600"
        >
          Show
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          Nobody has been away that long — try a shorter gap.
        </p>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {rows.length} {rows.length === 1 ? 'client' : 'clients'}, worth {money(total)} the last time they came
            in.
          </p>
          <ul className="flex flex-col gap-3">
            {rows.map((row) => {
              const mark = markFor(row.clientId);
              return (
                <li
                  key={row.clientId}
                  className="flex flex-col gap-2 rounded-md border border-zinc-300 p-4 text-sm dark:border-zinc-700"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span>
                      <Link
                        href={`/staff/clients/${row.clientId}`}
                        className="font-medium underline underline-offset-4"
                      >
                        {row.name ?? 'No name'}
                      </Link>{' '}
                      {/* The resolution to this list is a phone call, so the
                          number dials — same as every other staff list. */}
                      {row.phone ? (
                        <a href={`tel:${row.phone}`} className="text-zinc-600 underline underline-offset-4 dark:text-zinc-400">
                          {row.phone}
                        </a>
                      ) : null}
                    </span>
                    <span className="font-medium">{row.weeksSince} weeks</span>
                  </div>
                  <span className="text-zinc-600 dark:text-zinc-400">
                    Last in {readableInstant(row.lastVisitAt, business.timezone)} ·{' '}
                    {row.lastServiceNames.join(' + ')} · {row.lastProviderName} · {money(row.lastSpendCents)}
                  </span>

                  {/* A-072's marks, reused. Thirty calls do not happen in one
                      sitting, and a list that forgets is a list that gets
                      copied onto paper. */}
                  <LapsedCallButtons
                    clientId={row.clientId}
                    appointmentId={row.lastAppointmentId}
                    mark={mark}
                  />
                  {mark ? (
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">
                      {OFFER_WORDS[mark.outcome]}
                      {mark.calledByName ? ` — ${mark.calledByName}` : ''}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}

/** Integer cents, formatted once. Never arithmetic on a formatted string. */
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
