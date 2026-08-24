/**
 * Which adapter this build actually sends through.
 *
 * The one place a real driver gets wired in later (D-14: "a later
 * one-assignment swap"). Everything else in this module — enqueue, dispatch,
 * the kill switch, the sandbox redirect — is already exercised against
 * whatever is assigned here.
 */
import { LOGGING_ADAPTER_ID, LoggingChannelAdapter } from '../../core/notifications';
import type { ChannelAdapter } from '../../core/notifications';

export const notificationAdapter: ChannelAdapter = new LoggingChannelAdapter();

/**
 * Did anybody actually get this? (A-044, made per-ROW by A-048)
 *
 * The outbox column is not wrong — the adapter genuinely succeeded. This is a
 * narrower question that only a staff SCREEN needs to ask, because "Told:
 * Cancellation — sent" is read at the front desk as "no need to call her",
 * and with the console adapter it means a line on the server log.
 *
 * A-044 answered it from the BUILD: `!(notificationAdapter instanceof
 * LoggingChannelAdapter)`, evaluated at render time. That is wrong in exactly
 * one direction and it is the direction that matters — the day a real driver
 * is wired in, every message ever queued retroactively reads "sent", because
 * the predicate knows nothing about which adapter actually handled each row.
 * `dispatch.ts` now stamps `deliveredBy` per row, so the question is asked of
 * the row that was sent rather than of the code that is running.
 *
 * NULL — every row written before the column existed — is `log`'s answer, and
 * correctly reads as "queued".
 */
export function reallyDelivered(deliveredBy: string | null | undefined): boolean {
  return !!deliveredBy && deliveredBy !== LOGGING_ADAPTER_ID;
}
