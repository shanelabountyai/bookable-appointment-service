import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bookable/db';
import { loadAppointmentDetail } from '@bookable/db/appointments';
import { reliabilityFor } from '@bookable/db/clients';
import {
  type AppointmentStatus,
  SLOT_FREEING_STATUSES,
  canReschedule,
  canTransition,
  possibleTransitionsFrom,
} from '@bookable/core/scheduling';
import { worstCutoff } from '@bookable/core/settings';
import { fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableInstant } from '@/lib/customer-format';
import { DELIVERY_WORDS, TEMPLATE_WORDS, toReadableEvent } from '@/lib/appointments/event-language';
import { flagSentence } from '@/components/client-flag';
import { MovePanel } from './move-panel';
import { StatusControls } from './status-controls';
import { VisitNote } from './visit-note';

export const dynamic = 'force-dynamic';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * A-027 — ONE APPOINTMENT, EVERYTHING ABOUT IT.
 *
 * Four stories converge here and no earlier row built it: the plain-language
 * event log (APPT-07), the pinned client note on every render (CLIENT-03), the
 * override marker and its reason (BOOK-05/D-8), and "was she actually told?"
 * (operator R-4).
 *
 * A STAFF surface, so D-10's customer lexicon does not apply: this screen says
 * "no-show" because that is the word the front desk and the reports use.
 */
export default async function AppointmentPage({ params }: PageProps<'/staff/appointments/[id]'>) {
  const staff = await requireStaff();
  const { id } = await params;

  const detail = await loadAppointmentDetail(prisma, { businessId: staff.businessId, appointmentId: id });
  if (!detail) notFound();

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true, cancellationCutoffMinutes: true },
  });
  const zone = zoneId(business.timezone);
  const day = toLabel(fromDate(detail.startAt), zone).day;
  const status = detail.status as AppointmentStatus;
  const gapMinutes = detail.gapMinutes;

  // The buttons come from the §7 table, filtered to what the FRONT DESK may do
  // right now — asked of the same function the write path asks, so a button
  // can never offer a move the server then refuses.
  const now = new Date();
  const context = {
    actor: 'staff' as const,
    now: fromDate(now),
    startAt: fromDate(detail.startAt),
    endAt: fromDate(detail.endAt),
    cancellationCutoffMinutes: worstCutoff(business.cancellationCutoffMinutes, []).minutes,
  };
  // A-033. Asked of the SAME function the write path asks (APPT-05, D-6), so
  // the panel is absent exactly when `rescheduleAppointment` would refuse —
  // an appointment already in the chair, or finished, or cancelled. A second
  // `if (status === ...)` on this screen is the rental VERIFIED defect
  // starting over.
  const movable = canReschedule(status, context).allowed;

  const available = possibleTransitionsFrom(status)
    .map((to) => ({ to, decision: canTransition(status, to, { ...context, reason: 'placeholder' }) }))
    .filter((option) => option.decision.allowed)
    .map((option) => option.to);

  const events = detail.events.map((event) => toReadableEvent(event, zone));

  // CLIENT-04 on the surface where the desk decides what to do about her —
  // marking this one a no-show is one button away, and knowing it is her third
  // is what turns that tap into a phone call instead.
  const reliability = detail.clientId
    ? await reliabilityFor(prisma, {
        businessId: staff.businessId,
        clientId: detail.clientId,
        today: toLabel(fromDate(now), zone).day,
      })
    : null;
  const flag = reliability ? flagSentence(reliability) : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-6">
      <div>
        <Link href={`/staff/day?day=${day}`} className="text-sm text-zinc-500 hover:underline">
          ← The day
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {detail.clientName ?? 'Walk-in, no name'}
        </h1>
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">
          {readableInstant(detail.startAt, business.timezone)} · {detail.providerName}
        </p>
        {detail.clientPhone ? (
          <a href={`tel:${detail.clientPhone}`} className="text-sm underline underline-offset-4">
            {detail.clientPhone}
          </a>
        ) : null}
        {/* Guarded on the SENTENCE, not on the client: an empty link is
            invisible to the eye and announced as a link with no name. */}
        {flag ? (
          <Link href={`/staff/clients/${detail.clientId}`} className="mt-1 block text-sm font-medium text-amber-700 dark:text-amber-500">
            ⚑ {flag}
          </Link>
        ) : null}
      </div>

      {/* CLIENT-03's safety surface, FIRST and unmissable. An allergy note
          nobody scrolls to is a note nobody reads. */}
      {detail.clientNotes ? (
        <p className="rounded-md border border-amber-500 bg-amber-50 p-4 text-sm font-medium text-amber-950 dark:bg-amber-950 dark:text-amber-100">
          ⚑ {detail.clientNotes}
        </p>
      ) : null}

      {detail.conflicted ? (
        <p className="rounded-md border border-amber-500 p-4 text-sm">
          <span className="font-semibold">Clashes with time off or a block.</span>{' '}
          {detail.conflictAcknowledgedAt
            ? `Kept — ${detail.conflictAcknowledgedReason ?? 'dealt with'}.`
            : 'Nobody has dealt with this yet.'}{' '}
          <Link href={`/staff/conflicts?day=${day}`} className="underline underline-offset-4">
            Conflicts
          </Link>
        </p>
      ) : null}

      {detail.isOverride ? (
        <p className="rounded-md border border-zinc-400 p-4 text-sm dark:border-zinc-600">
          {/* BOOK-05: the marker AND the reason. A marker without one is a
              marker staff learn to ignore. */}
          <span className="font-semibold">Booked as an override.</span>{' '}
          {detail.overrideReason ?? 'No reason recorded.'}
        </p>
      ) : null}

      <dl className="flex flex-col gap-2 text-sm">
        <Row label="What">
          {detail.services.map((s) => s.name).join(' + ')} ·{' '}
          {money(detail.services.reduce((total, s) => total + s.priceCents, 0))}
        </Row>
        {/* SEG-03. Stated as minutes rather than drawn, because the panel has
            no time axis to draw on — and "45 of these minutes she is free" is
            the fact the desk acts on. Not offered as a booking link: the
            exclusion constraint still defends this time in A-029, so booking
            it goes through the existing override. */}
        {gapMinutes > 0 ? (
          <Row label="Free inside it">
            {gapMinutes} min of processing time — she is not needed for it
          </Row>
        ) : null}
        <Row label="Status">{status.replace('_', ' ')}</Row>
        {detail.confirmedAt ? <Row label="Confirmed">{readableInstant(detail.confirmedAt, business.timezone)}</Row> : null}
        {/* APPT-03's actual-vs-scheduled: what really happened, beside what
            was planned. */}
        {detail.checkedInAt ? <Row label="Arrived">{readableInstant(detail.checkedInAt, business.timezone)}</Row> : null}
        {detail.startedAt ? <Row label="Started">{readableInstant(detail.startedAt, business.timezone)}</Row> : null}
        {detail.endedAt ? <Row label="Finished">{readableInstant(detail.endedAt, business.timezone)}</Row> : null}
      </dl>

      {/* WAIT-02's "who wants this slot?" — only once cancelling actually
          freed the time (D-7: no_show/completed still occupy it). */}
      {(SLOT_FREEING_STATUSES as readonly string[]).includes(status) && detail.primaryServiceId ? (
        <Link
          href={`/staff/waitlist?providerId=${detail.providerId}&serviceId=${detail.primaryServiceId}&at=${encodeURIComponent(detail.startAt.toISOString())}&minutes=${freedMinutes(detail)}`}
          className="text-sm font-medium underline underline-offset-4"
        >
          Who wants this slot?
        </Link>
      ) : null}

      {movable ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            Move this appointment
          </h2>
          <MovePanel appointmentId={detail.id} currentDay={day} />
        </section>
      ) : null}

      <StatusControls appointmentId={detail.id} status={status} available={available} />

      <VisitNote appointmentId={detail.id} notes={detail.notes ?? ''} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          What happened
        </h2>
        <ol className="flex flex-col gap-2">
          {events.map((event) => (
            <li key={event.id} className="flex flex-col rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">
              <span className={event.isCorrection ? 'font-medium' : ''}>{event.sentence}</span>
              {event.reason ? <span className="text-zinc-600 dark:text-zinc-400">“{event.reason}”</span> : null}
              <span className="text-xs text-zinc-600 dark:text-zinc-400">{event.when}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Was she told?
        </h2>
        {detail.notifications.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Nothing has been sent about this appointment.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.notifications.map((notification) => (
              <li
                key={notification.id}
                className="flex flex-wrap items-baseline gap-x-3 rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700"
              >
                <span className="font-medium">{TEMPLATE_WORDS[notification.template] ?? notification.template}</span>
                <span className="text-zinc-600 dark:text-zinc-400">
                  {notification.recipient ?? 'no contact details'} · {notification.channel}
                </span>
                <span className="ml-auto">{DELIVERY_WORDS[notification.status] ?? notification.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/** Body ± buffers (D-16) — what the exclusion constraint actually let go of,
 *  in whole minutes. Epoch-ms arithmetic (`fromDate`), never wall-clock. */
function freedMinutes(detail: { blockedStart: Date; blockedEnd: Date }): number {
  return Math.round((fromDate(detail.blockedEnd) - fromDate(detail.blockedStart)) / 60_000);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
