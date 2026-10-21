/**
 * W-009 — registering a webhook endpoint (owner-only; the UI is W-011).
 *
 * A new endpoint starts at the business's CURRENT sequence: it receives what
 * happens from now on, not the salon's history. A receiver that wants the
 * past pulls it from `GET /v1/events?since=0` (§8 "Catch-up").
 */
import type { PrismaClient } from '@bookable/db';
import type { PublishedType } from './events';
import { newWebhookSecret } from './webhook-signature';
import { assertDeliverable, checkWebhookUrl } from './webhook-url';

export const PUBLISHED_TYPES: readonly PublishedType[] = [
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.reassigned',
  'appointment.cancelled',
  'appointment.status_changed',
  'appointment.status_corrected',
];

export class WebhookEndpointRejected extends Error {
  constructor(public readonly field: 'url' | 'eventTypes', why: string) {
    super(why);
    this.name = 'WebhookEndpointRejected';
  }
}

/** The secret is returned ONCE, here; the owner pastes it into the receiver. */
export async function createWebhookEndpoint(
  db: PrismaClient,
  args: { businessId: string; url: string; eventTypes?: readonly string[]; includeClientContact?: boolean; allowPrivate?: boolean },
): Promise<{ id: string; secret: string }> {
  let url: string;
  try {
    url = checkWebhookUrl(args.url, args.allowPrivate);
    await assertDeliverable(url, args.allowPrivate);
  } catch (error) {
    throw new WebhookEndpointRejected('url', error instanceof Error ? error.message : 'invalid url');
  }
  const eventTypes = [...new Set(args.eventTypes ?? [])];
  const unknown = eventTypes.filter((t) => !(PUBLISHED_TYPES as readonly string[]).includes(t));
  if (unknown.length > 0) throw new WebhookEndpointRejected('eventTypes', `not a published event type: ${unknown.join(', ')}`);
  const seq = await db.businessEventSeq.findUnique({ where: { businessId: args.businessId }, select: { last: true } });
  const secret = newWebhookSecret();
  const { id } = await db.webhookEndpoint.create({
    data: { businessId: args.businessId, url, secret, eventTypes, includeClientContact: args.includeClientContact ?? false, cursorSeq: seq?.last ?? 0 },
    select: { id: true },
  });
  return { id, secret };
}
