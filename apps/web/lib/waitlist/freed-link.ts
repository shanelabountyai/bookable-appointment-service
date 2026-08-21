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
}): string {
  const params = new URLSearchParams({
    providerId: freed.providerId,
    serviceId: freed.serviceId,
    at: freed.startAt.toISOString(),
    minutes: String(freed.freedMinutes),
  });
  return `/staff/waitlist?${params}`;
}
