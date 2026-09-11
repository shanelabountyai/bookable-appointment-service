/**
 * CLIENT-01's form check — and ONLY the form check (D-55).
 *
 * What a phone number is STORED as is not decided here. It is the database's:
 * `bookable_phone` in the `client_identity` trigger rewrites every write, and
 * every lookup asks that same function about what was typed. This used to be
 * `normalizePhone`, a JS copy of the rule that kept a leading `+` — so
 * `+15125550101` and `5125550101` were two clients, and a blocked client
 * booked past CLIENT-04 by writing her number with brackets (A-114). A second
 * copy of the rule is how that happens again, so there is none.
 *
 * DELIBERATELY FORGIVING, and deliberately NOT E.164 validation. A salon takes
 * numbers over the phone with a client half out of the door; refusing one that
 * a human can plainly read costs a booking.
 *
 * Seven digits is a local number without an area code — the shortest thing a
 * salon would ever write down.
 */
export function isPlausiblePhone(raw: string): boolean {
  return raw.replace(/\D/g, '').length >= 7;
}
