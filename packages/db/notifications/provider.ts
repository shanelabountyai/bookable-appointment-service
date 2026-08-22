/**
 * Which adapter this build actually sends through.
 *
 * The one place a real driver gets wired in later (D-14: "a later
 * one-assignment swap"). Everything else in this module — enqueue, dispatch,
 * the kill switch, the sandbox redirect — is already exercised against
 * whatever is assigned here.
 */
import { LoggingChannelAdapter } from '../../core/notifications';
import type { ChannelAdapter } from '../../core/notifications';

export const notificationAdapter: ChannelAdapter = new LoggingChannelAdapter();

/**
 * Does a `sent` outbox row mean anybody was actually reached? (A-044)
 *
 * DERIVED FROM THE ASSIGNMENT ABOVE, never from an environment variable or a
 * hand-maintained boolean. D-14 promised the real driver is a one-assignment
 * swap, and a second thing to remember to flip would quietly break that
 * promise — the failure mode being a screen that says "sent" for a year.
 *
 * The outbox column is not wrong: the adapter genuinely succeeded. This is a
 * narrower question that only a staff SCREEN needs to ask, because "Told:
 * Cancellation — sent" is read at the front desk as "no need to call her",
 * and today it means a line on the server console.
 *
 * ponytail: build-wide, not per row. The honest version is a provider id on
 * the outbox — `dispatch.ts` already discards the adapter's `externalId`
 * because there is no column for it — and then old rows keep saying `queued`
 * after a real driver lands, which is what actually happened to them. Add the
 * column when a real driver arrives; it needs it anyway, to reconcile.
 */
export const notificationsReallySend = !(notificationAdapter instanceof LoggingChannelAdapter);
