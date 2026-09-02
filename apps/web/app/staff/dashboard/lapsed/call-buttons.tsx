'use client';

import type { CallMark } from '@bookable/db/clients';
import { OfferButtons } from '@/app/staff/waitlist/offer-buttons';

/**
 * A-073 — the same four buttons as A-072's, on the lapsed list.
 *
 * A thin wrapper rather than a second component: the buttons, the outcomes,
 * the undo and the server action are all one mechanism, and the only thing
 * that differs is the SUBJECT — `lapsed` rather than a freed slot's key. A
 * copy here would be the third shape for one idea, which is exactly what
 * A-073's own row said not to do.
 */
export function LapsedCallButtons({
  clientId,
  appointmentId,
  mark,
}: {
  clientId: string;
  /** Her last completed visit — the mark's FK, and the visit the call is
   *  about. */
  appointmentId: string;
  mark: CallMark | undefined;
}) {
  return <OfferButtons subject="lapsed" appointmentId={appointmentId} clientId={clientId} offer={mark} />;
}
