import Link from 'next/link';
import { prisma } from '@bookable/db';
import { SERIES_ENDING_WEEKS, listSeriesEnding } from '@bookable/db/booking';
import { requireStaff } from '@/lib/auth/session';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { PhoneLink } from '@/components/ui/phone-link';
import { readableInstant } from '@/lib/customer-format';
import { ExtendForm } from './extend-form';

export const dynamic = 'force-dynamic';

/**
 * A-152 (C11) — STANDING APPOINTMENTS ABOUT TO RUN OUT.
 *
 * "The next six" is a number typed once, and on the seventh week she is simply
 * not in the book — nobody decided that. This is every series with nothing
 * booked past the window, soonest to run out first, each one tap from being
 * extended by the same rule (`extendSeries`).
 *
 * THE DESK'S LIST (`requireStaff`), like /staff/owed: whoever is at the till
 * when she comes in is who asks "same again?".
 *
 * The weeks are a number ON the list (A-073's shape), a GET form so the answer
 * is a URL and needs no JavaScript.
 */
export default async function SeriesEndingPage({ searchParams }: PageProps<'/staff/series'>) {
  const staff = await requireStaff();
  const params = await searchParams;

  const asked = typeof params.weeks === 'string' ? Number(params.weeks) : NaN;
  const weeks = Number.isFinite(asked) && asked >= 1 && asked <= 52 ? Math.floor(asked) : SERIES_ENDING_WEEKS;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const rows = await listSeriesEnding(prisma, { businessId: staff.businessId, now: new Date(), weeks });

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-page-title font-semibold tracking-tight">Series ending</h1>
        <p className="mt-1 text-body text-ink-muted">
          Standing appointments with nothing booked more than {weeks} weeks ahead. Soonest to run out first.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <Field id="weeks" label="Nothing booked past (weeks)">
          {(control) => (
            <Input {...control} type="number" name="weeks" min={1} max={52} defaultValue={weeks} className="w-28" />
          )}
        </Field>
        <Button type="submit">Show</Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState>No standing appointment runs out in the next {weeks} weeks.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const name = row.name ?? 'No name';
            return (
              <li
                key={row.seriesId}
                className="flex flex-col gap-2 rounded-control border border-line-hairline bg-ground-raised p-4 text-body"
              >
                <Link href={`/staff/clients/${row.clientId}`} className="self-start font-medium underline underline-offset-4">
                  {name}
                </Link>
                <span className="numeric text-ink-muted">
                  {row.serviceNames.join(' + ')} · {row.providerName} ·{' '}
                  {row.intervalWeeks === 1 ? 'every week' : `every ${row.intervalWeeks} weeks`} at {row.wallTime}
                </span>
                <span>Last one booked: {readableInstant(row.lastAt, business.timezone)}</span>
                {row.phone ? (
                  <PhoneLink phone={row.phone} />
                ) : (
                  <span className="text-caption text-ink-muted">No number on the record</span>
                )}
                <ExtendForm
                  seriesId={row.seriesId}
                  requested={row.requested}
                  defaultCount={Math.min(row.requested, 104)}
                  about={name}
                />
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
