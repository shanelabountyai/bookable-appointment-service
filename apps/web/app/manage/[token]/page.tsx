/**
 * THE MANAGE LINK (TOKEN-01..03, D-5, D-10).
 *
 * The only page in this app whose authority is a URL. Everything that follows
 * from that:
 *
 *  - It renders NO internal identifier (TOKEN-03). Not the appointment id, not
 *    the client id, not a status enum. The cancel form carries the token back,
 *    not a row id, so there is nothing in the markup to lift. An e2e spec
 *    asserts it against the rendered page rather than against this file.
 *  - It is `noindex`. A link in an SMS ends up pasted into places that get
 *    crawled, and a search engine holding a live manage link is a disclosure
 *    with no expiry of its own.
 *  - Every failure looks the same (see the gate). A customer who mistypes and
 *    a script enumerating tokens get the identical sentence.
 */
import type { Metadata } from 'next';
import { prisma } from '@bookable/db';
import { type AppointmentStatus, canReschedule, possibleTransitionsFrom } from '@bookable/core/scheduling';
import { worstCutoff } from '@bookable/core/settings';
import { fromDate } from '@bookable/core/time';
import { readableInstant } from '@/lib/customer-format';
import { openManageLink } from '@/lib/manage/token-gate';
import { listRescheduleDays } from '@/lib/manage/actions';
import { CancelForm } from './cancel-form';
import { RescheduleForm } from './reschedule-form';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function ManagePage({ params }: PageProps<'/manage/[token]'>) {
  const { token } = await params;
  const gate = await openManageLink(token, new Date());

  if (!gate.ok) {
    return (
      <Shell>
        <p className="text-zinc-600 dark:text-zinc-400">
          {gate.reason === 'too-many'
            ? 'Too many requests just now. Please wait a minute and try again.'
            : 'This link is no longer valid. Please call the salon and we will sort it out.'}
        </p>
      </Shell>
    );
  }

  const now = new Date();
  const appointment = await prisma.appointment.findUniqueOrThrow({
    where: { id: gate.grant.appointmentId },
    select: {
      status: true,
      startAt: true,
      endAt: true,
      provider: { select: { displayName: true } },
      lines: {
        orderBy: { ordinal: 'asc' },
        select: { service: { select: { id: true, name: true, cancellationCutoffMinutes: true } } },
      },
      business: { select: { name: true, timezone: true, cancellationCutoffMinutes: true } },
    },
  });

  const status = appointment.status as AppointmentStatus;

  /**
   * The reschedule affordance is asked of the SAME function the write path
   * asks (D-6), with this customer's actor and this appointment's cutoff — not
   * approximated from the status alone. Showing a form half an hour before an
   * appointment that would then answer "call us" is a worse experience than
   * saying so up front, and an affordance that disagrees with the server is
   * how a screen stops being believed.
   */
  const movable = canReschedule(status, {
    actor: 'customer_token',
    now: fromDate(now),
    startAt: fromDate(appointment.startAt),
    endAt: fromDate(appointment.endAt),
    // D-19: the most restrictive cutoff in the visit governs, resolved by the
    // same helper the settings form validates against.
    cancellationCutoffMinutes: worstCutoff(
      appointment.business.cancellationCutoffMinutes,
      appointment.lines.map((l) => l.service),
    ).minutes,
  });

  return (
    <Shell>
      <h1 className="text-2xl font-semibold tracking-tight">Your appointment</h1>

      <dl className="flex flex-col gap-3 text-sm">
        <Row label="What">{appointment.lines.map((line) => line.service.name).join(' + ')}</Row>
        <Row label="With">{appointment.provider.displayName}</Row>
        <Row label="When">{readableInstant(appointment.startAt, appointment.business.timezone)}</Row>
        <Row label="Where">{appointment.business.name}</Row>
      </dl>

      <p className="text-zinc-600 dark:text-zinc-400">{PLAIN_LANGUAGE[status]}</p>

      {movable.allowed ? <RescheduleForm token={token} days={await listRescheduleDays(token)} /> : null}

      {/* An AFFORDANCE, not an authorisation: the table says which states a
          cancellation can leave at all, and the server action asks it again
          — with the actor and the cutoff — when the button is pressed. */}
      {possibleTransitionsFrom(status).includes('cancelled_late') ? <CancelForm token={token} /> : null}

      {!movable.allowed && movable.refusal === 'inside-cancellation-cutoff' ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          It is too close to your appointment to change the time online. Give us a ring and we will sort it out.
        </p>
      ) : null}

      <p className="text-xs text-zinc-500">This link stays open until a day after your appointment.</p>
    </Shell>
  );
}

/**
 * D-10's lexicon, in the one place a status becomes a sentence.
 *
 * Typed as a TOTAL map over the statuses, so a ninth state is a compile error
 * here rather than a blank line on a customer's screen — the "a status enum is
 * never one edit" rule, enforced by the type system instead of by memory.
 *
 * `cancelled` and `cancelled_late` deliberately read the same. The split is
 * the salon's revenue record (CLIENT-04), not a label to put in front of the
 * person who cancelled, and D-10 keeps it on staff screens.
 */
const PLAIN_LANGUAGE = {
  booked: 'We have you in the book.',
  confirmed: 'You are confirmed — see you then.',
  checked_in: 'You are checked in.',
  in_progress: 'You are with us now.',
  completed: 'This visit is finished. Thank you.',
  no_show: 'This appointment has passed.',
  cancelled: 'This appointment is cancelled.',
  cancelled_late: 'This appointment is cancelled.',
} satisfies Record<AppointmentStatus, string>;

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 p-8">{children}</main>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-zinc-500">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
