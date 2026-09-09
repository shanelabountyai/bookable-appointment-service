import Link from 'next/link';
import { PhoneLink } from '@/components/ui/phone-link';

/**
 * A-108 / D-51 — one person who was never reminded.
 *
 * Deliberately NOT a `MessageRow`. There is no message: no provider error to
 * read, no attempt count, and nothing to put back in a queue that never held
 * it. What the desk has is a name, a time and a way to reach her, so that is
 * the whole row — and the number goes through `PhoneLink` because ringing her
 * IS the action D-51 chose over a catch-up send, which makes this a desk dial
 * target rather than a string (A-092: 44px, and the stored formatting stripped
 * out of the href).
 */
export function MissedReminderRow({
  appointmentId,
  who,
  phone,
  email,
  when,
}: {
  appointmentId: string;
  who: string;
  phone: string | null;
  email: string | null;
  when: string;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">
      <span className="font-medium">{who}</span>
      <span>{when}</span>
      {phone ? <PhoneLink phone={phone} /> : null}
      {email ? <span className="text-zinc-600 dark:text-zinc-400">{email}</span> : null}
      {/* A client with neither is worth SEEING rather than rendering as a blank
          gap — she cannot be reached at all, which is a bigger problem than a
          missed reminder and is the desk's cue to ask her at the door. */}
      {!phone && !email ? <span className="text-zinc-600 dark:text-zinc-400">no contact details</span> : null}
      <Link href={`/staff/appointments/${appointmentId}`} className="underline underline-offset-4">
        The appointment
      </Link>
    </li>
  );
}
