'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import {
  PUBLISHED_TYPES,
  WebhookEndpointRejected,
  createWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  replayDelivery,
  replayFromSeq,
  rotateWebhookSecret,
  setWebhookEndpointStatus,
  updateWebhookEndpoint,
} from '../api/webhook-endpoints';
import { readableInstant } from '../customer-format';
import { requireOwner } from '../auth/session';

/**
 * W-011 — webhooks on /staff/integrations (API PRD §7 "Owner UI").
 *
 * Owner only at EVERY entry point (`requireOwner`), as the API keys are (D-36).
 * A secret appears once, in the response to the action that made it.
 */

export interface WebhookState {
  ok?: boolean;
  message?: string;
  /** Present exactly once: on registration and on rotation. */
  secret?: string;
}

export interface EndpointRow {
  id: string;
  url: string;
  eventTypes: string[];
  includeClientContact: boolean;
  status: 'active' | 'paused' | 'disabled';
  consecutiveFailures: number;
  disabledReason: string | null;
  cursorSeq: number;
  /** Worded in the salon's zone; null when no rotation overlap is running. */
  previousSecretUntil: string | null;
}

export interface DeliveryRow {
  id: string;
  endpointUrl: string;
  eventId: string;
  eventType: string;
  seq: number;
  status: string;
  attempts: number;
  replayed: boolean;
  firstAttempt: string | null;
  nextAttempt: string | null;
  succeeded: string | null;
  lastResponseStatus: number | null;
  lastResponseExcerpt: string | null;
  lastError: string | null;
}

const zoneOf = async (businessId: string) => (await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } })).timezone;
const at = (d: Date | null, zone: string) => (d ? readableInstant(d, zone) : null);

export async function listEndpoints(): Promise<EndpointRow[]> {
  const owner = await requireOwner();
  const [rows, zone] = await Promise.all([listWebhookEndpoints(prisma, owner.businessId), zoneOf(owner.businessId)]);
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    eventTypes: r.eventTypes,
    includeClientContact: r.includeClientContact,
    status: r.status,
    consecutiveFailures: r.consecutiveFailures,
    disabledReason: r.disabledReason,
    cursorSeq: r.cursorSeq,
    previousSecretUntil: r.previousSecretExpiresAt && r.previousSecretExpiresAt > now ? at(r.previousSecretExpiresAt, zone) : null,
  }));
}

export async function listDeliveries(filter: { endpointId?: string; status?: string; eventType?: string }): Promise<DeliveryRow[]> {
  const owner = await requireOwner();
  const [rows, zone] = await Promise.all([listWebhookDeliveries(prisma, owner.businessId, filter), zoneOf(owner.businessId)]);
  return rows.map((r) => ({
    id: r.id,
    endpointUrl: r.endpoint.url,
    eventId: r.eventId,
    eventType: r.eventType,
    seq: r.seq,
    status: r.status,
    attempts: r.attempts,
    replayed: r.replayed,
    firstAttempt: at(r.firstAttemptAt, zone),
    nextAttempt: r.status === 'failed' ? at(r.nextAttemptAt, zone) : null,
    succeeded: at(r.succeededAt, zone),
    lastResponseStatus: r.lastResponseStatus,
    lastResponseExcerpt: r.lastResponseExcerpt,
    lastError: r.lastError,
  }));
}

const formTypes = (formData: FormData) => formData.getAll('eventType').map(String).filter((t) => (PUBLISHED_TYPES as readonly string[]).includes(t));

async function attempt(work: () => Promise<WebhookState>): Promise<WebhookState> {
  try {
    const state = await work();
    revalidatePath('/staff/integrations');
    return state;
  } catch (error) {
    if (error instanceof WebhookEndpointRejected) return { ok: false, message: error.message };
    throw error;
  }
}

export async function registerEndpoint(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const owner = await requireOwner();
  return attempt(async () => {
    const { secret } = await createWebhookEndpoint(prisma, {
      businessId: owner.businessId,
      url: String(formData.get('url') ?? '').trim(),
      eventTypes: formTypes(formData),
      includeClientContact: formData.get('includeClientContact') === 'on',
    });
    return { ok: true, secret, message: 'Registered. Copy the signing secret now — it is shown once.' };
  });
}

export async function editEndpoint(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const owner = await requireOwner();
  return attempt(async () => {
    await updateWebhookEndpoint(prisma, {
      businessId: owner.businessId,
      endpointId: String(formData.get('id') ?? ''),
      url: String(formData.get('url') ?? '').trim(),
      eventTypes: formTypes(formData),
      includeClientContact: formData.get('includeClientContact') === 'on',
    });
    return { ok: true, message: 'Saved.' };
  });
}

export async function changeEndpointStatus(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const owner = await requireOwner();
  const to = formData.get('to') === 'active' ? 'active' : 'disabled';
  return attempt(async () => {
    await setWebhookEndpointStatus(prisma, { businessId: owner.businessId, endpointId: String(formData.get('id') ?? ''), to, now: new Date() });
    return { ok: true, message: to === 'active' ? 'Resumed.' : 'Switched off.' };
  });
}

export async function rotateSecret(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const owner = await requireOwner();
  return attempt(async () => {
    const { secret } = await rotateWebhookSecret(prisma, { businessId: owner.businessId, endpointId: String(formData.get('id') ?? ''), now: new Date() });
    return { ok: true, secret, message: 'New secret — shown once. The old one keeps signing for 24 hours.' };
  });
}

export async function replayFromSeqAction(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const owner = await requireOwner();
  const fromSeq = Number(formData.get('fromSeq'));
  if (!Number.isInteger(fromSeq) || fromSeq < 1) return { ok: false, message: 'Give a sequence number of 1 or more.' };
  return attempt(async () => {
    const n = await replayFromSeq(prisma, { businessId: owner.businessId, endpointId: String(formData.get('id') ?? ''), fromSeq });
    return { ok: true, message: `Queued from #${fromSeq}: ${n} re-sent, plus anything it never had.` };
  });
}

export async function replayDeliveryAction(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const owner = await requireOwner();
  const ok = await replayDelivery(prisma, { businessId: owner.businessId, deliveryId: String(formData.get('id') ?? '') });
  revalidatePath('/staff/integrations');
  return ok ? { ok: true, message: 'Queued to send again.' } : { ok: false, message: 'That delivery is sending right now, or is not one of yours.' };
}
