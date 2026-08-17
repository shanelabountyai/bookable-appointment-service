/**
 * THE ONE PHONE NORMALIZER (CLIENT-01, D-17).
 *
 * "Client is LOOKED UP by normalized phone" only means anything if writing and
 * looking up normalize identically. This lived in the customer booking flow's
 * server actions, where the staff lookup could not reach it — so the second
 * caller would have written a second copy, and a mother typing
 * `(512) 555-0101` at home would not have matched the `5125550101` the front
 * desk typed for her.
 *
 * DELIBERATELY FORGIVING, and deliberately NOT E.164 validation. A salon takes
 * numbers over the phone with a client half out of the door; refusing one that
 * a human can plainly read costs a booking, and a number that reaches nobody
 * is a problem the SMS adapter reports, not one the front desk should be
 * arguing with a form about.
 *
 * The leading `+` is kept because it is the only part of an international
 * number that carries meaning here: `+15125550101` and `15125550101` are the
 * same number written two ways, but dropping the `+` from the first would make
 * it indistinguishable from a local number that happens to start with a 1.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** Enough digits to be a phone number at all. Seven is a local number without
 *  an area code — the shortest thing a salon would ever write down. */
export function isPlausiblePhone(normalized: string): boolean {
  return normalized.replace('+', '').length >= 7;
}
