/**
 * THE PROVIDER CONTRACT (NOTIF-01, D-14): every outbound notification goes
 * through this. One seam, one place to swap in Resend and Twilio when they
 * arrive — a later one-assignment change (`provider.ts` in packages/db), out
 * of v1 scope entirely.
 *
 * Deliberately dependency-free — no Prisma import, no I/O of its own. The
 * DB-touching half (enqueue/dispatch, in packages/db/notifications) is what
 * decides WHETHER to call `send()` and WHERE; this module only describes the
 * shape of that call.
 *
 * `NotificationChannel` here is a plain string union, not the Prisma-generated
 * enum — packages/core stays independent of packages/db. The two are
 * structurally compatible; nothing converts between them, because a string
 * literal already satisfies both.
 */

export type NotificationChannel = 'email' | 'sms';

export interface OutboundMessage {
  channel: NotificationChannel;
  /** Email address or E.164 phone. Already resolved, and already redirected
   *  to the sandbox address if one is configured — an adapter never decides
   *  who to send to. */
  to: string;
  /** The outbox row's template key — the same string stored on
   *  NotificationOutbox.template. No rendering happens here: no template
   *  vocabulary or content system exists yet (that arrives with whichever
   *  item first needs one, e.g. the confirmation at BOOK-06). This adapter
   *  only carries the key and the raw payload through to the provider. */
  template: string;
  /** The outbox row's payload, verbatim. */
  payload: unknown;
}

export interface SendResult {
  /** Provider message id (Resend id, Twilio SID), when the provider returns
   *  one. A-048 gave this somewhere to land (`NotificationOutbox.externalId`):
   *  the dispatcher was already receiving it and throwing it away, and a real
   *  driver needs it to reconcile against the provider's own record. */
  externalId?: string;
}

export class ChannelSendError extends Error {
  /** Provider error code. A stable code is what a later retry policy can
   *  branch on; the message is for a human reading the log. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChannelSendError';
    this.code = code;
  }
}

export interface ChannelAdapter {
  /**
   * A-048. Stable identifier for THIS adapter, recorded on every row it
   * handles (`NotificationOutbox.deliveredBy`).
   *
   * It is what makes "was she actually told?" a question about the row rather
   * than about the build. The predicate it replaced was
   * `!(adapter instanceof LoggingChannelAdapter)`, evaluated at render time —
   * so the day a real driver shipped, every message ever queued would
   * retroactively have read "sent" on the appointment panel.
   */
  readonly id: string;
  /** Which channels this adapter can deliver. The dispatcher records
   *  `unsupported_channel` rather than throwing when a channel isn't
   *  covered — a missing SMS provider must not stop the email going out. */
  supports(channel: NotificationChannel): boolean;
  send(message: OutboundMessage): Promise<SendResult>;
}

/** The console adapter's id. Exported because "really delivered?" is exactly
 *  "handled by something that is not this". */
export const LOGGING_ADAPTER_ID = 'log';
