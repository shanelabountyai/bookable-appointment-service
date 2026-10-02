import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listOwedRebooks } from '@bookable/db/appointments';
import { listCallMarks } from '@bookable/db/clients';
import { requireStaff } from '@/lib/auth/session';
import { CallMarkButtons } from '@/components/call-mark-buttons';
import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/button';
import { PhoneLink } from '@/components/ui/phone-link';
import { readableInstant } from '@/lib/customer-format';
import { OFFER_WORDS } from '@/lib/waitlist/offer-words';
import { recordOffer } from '@/lib/waitlist/offer-actions';

export const dynamic = 'force-dynamic';

/**
 * A-151 (C10, D-74) — THE CLIENTS THE SALON OWES A REBOOK.
 *
 * Every appointment the salon took away from the conflicts screen, until the
 * client has something booked again. Derived on every read
 * (`listOwedRebooks`), so there is nothing to clear: she books, and she
 * leaves.
 *
 * THE DESK'S LIST, not the owner's: `requireStaff`, unlike the lapsed report.
 * Whoever cancelled her is whoever should ring her back.
 *
 * The call marks are A-072's, subject `owed:<appointmentId>` — the same four
 * answers and the same control, so the second person at the desk sees who has
 * already been rung.
 */
export default async function OwedPage() {
  const staff = await requireStaff();
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });

  const rows = await listOwedRebooks(prisma, { businessId: staff.businessId, now: new Date() });
  const subjects = rows.map((row) => `owed:${row.appointmentId}`);
  const marks = await listCallMarks(prisma, { businessId: staff.businessId, subjects });
  const markFor = (row: (typeof rows)[number]) =>
    marks.get(`owed:${row.appointmentId}`)?.find((mark) => mark.clientId === row.clientId);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-page-title font-semibold tracking-tight">Owed a rebook</h1>
        <p className="mt-1 text-body text-ink-muted">
          Appointments the salon cancelled, where the client has nothing booked since. Longest waiting first.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState>Nobody is waiting on us for a new appointment.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const name = row.name ?? 'No name';
            const mark = markFor(row);
            return (
              <li
                key={row.appointmentId}
                className="flex flex-col gap-2 rounded-control border border-line-hairline bg-ground-raised p-4 text-body"
              >
                <Link href={`/staff/clients/${row.clientId}`} className="self-start font-medium underline underline-offset-4">
                  {name}
                </Link>
                <span className="numeric text-ink-muted">
                  Was {readableInstant(row.startAt, business.timezone)} · {row.serviceNames.join(' + ')} ·{' '}
                  {row.providerName}
                </span>
                <span className="text-ink-muted">
                  Cancelled {readableInstant(row.cancelledAt, business.timezone)}
                  {row.reason ? ` — ${row.reason}` : ''}
                </span>

                {row.phone ? (
                  <PhoneLink phone={row.phone} />
                ) : (
                  <span className="text-caption text-ink-muted">No number on the record</span>
                )}

                {/* The same visit, every service in order (VISIT-01), with the
                    client attached — the client page's Rebook link, pointed at
                    the cancelled visit instead of the last kept one. A-157:
                    with ANYONE while it opens on her original day, the one
                    day her stylist is known not to be working. */}
                <LinkButton
                  href={{
                    pathname: '/staff/book',
                    query: {
                      services: row.serviceIds,
                      provider: row.rebookWithAnyone ? 'any' : row.providerId,
                      day: row.rebookFromDay,
                      client: row.clientId,
                    },
                  }}
                  className="self-start"
                  aria-label={`Rebook ${name}`}
                >
                  Rebook
                </LinkButton>

                <CallMarkButtons
                  words={OFFER_WORDS}
                  current={mark?.outcome}
                  hidden={{ subject: `owed:${row.appointmentId}`, appointmentId: row.appointmentId, clientId: row.clientId }}
                  action={recordOffer}
                  undoLabel="Not asked"
                  about={name}
                />
                {mark ? (
                  <span className="text-caption text-ink-muted">
                    {OFFER_WORDS[mark.outcome]}
                    {mark.calledByName ? ` — ${mark.calledByName}` : ''} · {readableInstant(mark.calledAt, business.timezone)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
