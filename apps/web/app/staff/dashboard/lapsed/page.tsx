import { prisma } from '@bookable/db';
import { LAPSED_WEEKS, listLapsedClients } from '@bookable/db/reports';
import { listCallMarks } from '@bookable/db/clients';
import { requireOwner } from '@/lib/auth/session';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { LapsedRow, money } from './lapsed-row';

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
 *
 * A-092 (§8.6a) — the row is `LapsedRow` and the findings are written up
 * there. What belongs at THIS level: the cutoff control is the page's only
 * form and it is now `Field`/`Input`/`Button`, which is what puts a 44px
 * target and a 3:1 boundary on it — `border-zinc-400` measured 2.56:1 against
 * §4's graphical bar on the one control the report is steered with.
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

  const now = new Date();
  const rows = await listLapsedClients(prisma, { businessId: staff.businessId, now, weeks });
  // One read for the whole list. `lapsed` is one subject for every client, so
  // the mark is cleared the same way a freed slot's is: she books, and she
  // leaves the report.
  const marks = (await listCallMarks(prisma, { businessId: staff.businessId, subjects: ['lapsed'] })).get('lapsed') ?? [];
  const markFor = (clientId: string) => marks.find((mark) => mark.clientId === clientId);

  const total = rows.reduce((sum, row) => sum + row.lastSpendCents, 0);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
      <div>
        <LinkButton href="/staff/dashboard" variant="quiet" size="compact" className="-ml-2">
          &larr; Dashboard
        </LinkButton>
        <h1 className="mt-1 text-page-title font-semibold tracking-tight">Not been in for a while</h1>
        <p className="mt-1 text-body text-ink-muted">
          Last visit more than {weeks} weeks ago, nothing in the book, and nothing on their record. Longest away
          first.
        </p>
      </div>

      {/* The number, ON the report. A GET form so the answer is a URL the
          owner can keep, and so it needs no client JavaScript at all. */}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <Field id="weeks" label="Away for more than (weeks)">
          {(control) => (
            <Input {...control} type="number" name="weeks" min={1} max={260} defaultValue={weeks} className="w-28" />
          )}
        </Field>
        <Button type="submit">Show</Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState>Nobody has been away that long &mdash; try a shorter gap.</EmptyState>
      ) : (
        <>
          <p className="text-body text-ink-muted">
            {rows.length} {rows.length === 1 ? 'client' : 'clients'}, worth {money(total)} the last time they came
            in.
          </p>
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <LapsedRow
                key={row.clientId}
                row={row}
                mark={markFor(row.clientId)}
                now={now}
                weeks={weeks}
                timezone={business.timezone}
              />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
