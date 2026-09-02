/**
 * The one place the "who wants this slot?" URL is written (WAIT-02).
 *
 * A-043 gave that link a second origin — the opened-up list, which reaches the
 * same matcher without already knowing which appointment was cancelled. Two
 * hand-assembled query strings that have to agree on four parameter names is
 * the kind of drift nothing fails on: the second one would simply match
 * nobody, quietly, forever.
 */
export function freedSlotHref(freed: {
  providerId: string;
  serviceId: string;
  /** The instant, never `{date, time}` (D-4). */
  startAt: Date;
  /** Buffer-inclusive: the range the exclusion constraint let go of. */
  freedMinutes: number;
  /**
   * A-072 — A-067's derived row key, so the attempt marks made on the matcher
   * screen belong to THIS freed span and not merely to its appointment.
   *
   * A visit shortened twice frees two tails and they are two rounds of phone
   * calls; a span freed, sold and freed again is a new round too, because the
   * key it carries is a new event's. That is what makes "cleared by the slot
   * ceasing to be free" true with no clearing code.
   */
  key: string;
  /** The appointment the span came from — the mark's FK, so it goes when the
   *  appointment does. */
  appointmentId: string;
}): string {
  const params = new URLSearchParams({
    providerId: freed.providerId,
    serviceId: freed.serviceId,
    at: freed.startAt.toISOString(),
    minutes: String(freed.freedMinutes),
    key: freed.key,
    appointmentId: freed.appointmentId,
  });
  return `/staff/waitlist?${params}`;
}
