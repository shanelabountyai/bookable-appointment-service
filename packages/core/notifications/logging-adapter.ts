import { randomUUID } from 'node:crypto';
import { LOGGING_ADAPTER_ID } from './adapter';
import type { ChannelAdapter, NotificationChannel, OutboundMessage, SendResult } from './adapter';

/**
 * The adapter this build actually runs on. Every send is recorded exactly as
 * a real one would be — the outbox row already exists before this is ever
 * called — and then written to the server console instead of being handed to
 * a provider.
 *
 * This is NOT a stub standing in for skipped work. There is no Resend API
 * key, no verified sending domain, no approved SMS campaign — all three are
 * external, human-lead-time workstreams, and until they exist a "real" driver
 * could not be run even once, let alone tested. What it would be is an
 * untested HTTP call that looks finished, which is worse than an honest seam.
 *
 * Everything a real driver has to get right is already exercised against this
 * one: idempotency (dedupeKey), the kill switch, the sandbox redirect, and
 * failure recording. Swapping in Resend and Twilio is a change to
 * `notificationAdapter` in packages/db/notifications/provider.ts and nothing
 * else.
 */
export class LoggingChannelAdapter implements ChannelAdapter {
  readonly id = LOGGING_ADAPTER_ID;

  supports(_channel?: NotificationChannel): boolean {
    return true;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const externalId = `log_${randomUUID()}`;
    console.info(
      `[notifications] ${message.channel} -> ${message.to} | template=${message.template} | payload=${JSON.stringify(message.payload)}`,
    );
    return { externalId };
  }
}
