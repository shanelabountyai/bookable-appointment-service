/**
 * W-008 — the published event stream: `GET /v1/events` (the catch-up door)
 * and the ONE body builder W-009's webhooks send (API PRD §8).
 *
 * Source of truth is `AppointmentEvent`, numbered per business in commit
 * order by the database (`seq`, W-D18). Nothing here emits; everything reads
 * the log, so a writer added later is published without being told to.
 *
 * Published types are a closed map from the log's own `type` (§8). Anything
 * not in it — `override_booked`, pushes, releases, `services_changed`,
 * `client_changed`, the hours notes — is NOT published in v1, by decision
 * (OQ-W6); the OpenAPI doc lists it as such (W-012).
 *
 * The snapshot (W-D19) is the appointment view at the moment the pipeline
 * FIRST reads the event, stored once in `EventSnapshot`, so every endpoint,
 * every replay and this endpoint send one body per event id forever. It is
 * not reconstructed from history: the gap between the event and its capture
 * is the dispatch latency (seconds inline, up to the sweep interval
 * otherwise), and the event's own `change` carries the from/to as recorded.
 */
import type { ZoneId } from '@bookable/core/time';
import type { PrismaClient } from '@bookable/db';
import { z } from 'zod';
import { type AppointmentView, appointmentView } from './appointments';
import { decodeCursor, limitField, page } from './cursor';
import { type RequestContext, json, parseWith, queryOf } from './http';
import { when } from './time';

export const PUBLISHED_LOG_TYPES = ['booked', 'rescheduled', 'provider_changed', 'status_changed', 'status_corrected'] as const;

export type PublishedType =
  | 'appointment.booked'
  | 'appointment.rescheduled'
  | 'appointment.reassigned'
  | 'appointment.cancelled'
  | 'appointment.status_changed'
  | 'appointment.status_corrected';

export interface EventRow {
  id: string;
  businessId: string;
  appointmentId: string;
  type: string;
  seq: number | null;
  payload: unknown;
  createdAt: Date;
}

export interface EventBody {
  id: string;
  type: PublishedType;
  seq: number;
  occurredAt: string;
  apiVersion: 'v1';
  data: { appointment: AppointmentView; change?: Record<string, unknown> };
  replayed: boolean;
}

const CANCELLED = new Set(['cancelled', 'cancelled_late']);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The published name and the public part of the recorded payload — curated, never the raw payload (it carries internal flags). */
export function published(type: string, payload: unknown): { type: PublishedType; change?: Record<string, unknown> } | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'booked':
      return { type: 'appointment.booked' };
    case 'rescheduled':
      return { type: 'appointment.rescheduled', change: { fromStartAt: str(p.from), toStartAt: str(p.to), fromEndAt: str(p.fromEndAt), toEndAt: str(p.toEndAt) } };
    case 'provider_changed':
      return { type: 'appointment.reassigned', change: { fromProviderId: str(p.fromProviderId), toProviderId: str(p.toProviderId) } };
    case 'status_changed':
      return { type: CANCELLED.has(str(p.to) ?? '') ? 'appointment.cancelled' : 'appointment.status_changed', change: { from: str(p.from), to: str(p.to) } };
    case 'status_corrected':
      return { type: 'appointment.status_corrected', change: { from: str(p.from), to: str(p.to) } };
    default:
      return null;
  }
}

/** One stored snapshot per event: the first reader captures, every later reader gets the same bytes. */
export async function snapshotsFor(db: PrismaClient, events: readonly EventRow[], zone: ZoneId, now: Date): Promise<Map<string, AppointmentView>> {
  const ids = events.map((e) => e.id);
  const have = new Set((await db.eventSnapshot.findMany({ where: { eventId: { in: ids } }, select: { eventId: true } })).map((s) => s.eventId));
  const missing = events.filter((e) => !have.has(e.id));
  if (missing.length > 0) {
    const views = new Map<string, AppointmentView>();
    for (const e of missing) {
      if (!views.has(e.appointmentId)) views.set(e.appointmentId, (await appointmentView(db, { businessId: e.businessId, id: e.appointmentId, zone, now }))!);
    }
    // A concurrent reader may have captured first; its body stands (DO NOTHING), and we read back whichever won.
    await db.eventSnapshot.createMany({
      data: missing.map((e) => ({ eventId: e.id, businessId: e.businessId, body: views.get(e.appointmentId) as object, capturedAt: now })),
      skipDuplicates: true,
    });
  }
  const rows = await db.eventSnapshot.findMany({ where: { eventId: { in: ids } }, select: { eventId: true, body: true } });
  return new Map(rows.map((r) => [r.eventId, r.body as unknown as AppointmentView]));
}

/** Webhook bodies for already-published events, in the order given. */
export async function eventBodies(db: PrismaClient, events: readonly EventRow[], zone: ZoneId, now: Date, replayed = false): Promise<EventBody[]> {
  const snaps = await snapshotsFor(db, events, zone, now);
  return events.map((e) => {
    const pub = published(e.type, e.payload)!;
    return {
      id: e.id,
      type: pub.type,
      seq: e.seq!,
      occurredAt: when(e.createdAt, zone).at,
      apiVersion: 'v1',
      data: { appointment: snaps.get(e.id)!, ...(pub.change ? { change: pub.change } : {}) },
      replayed,
    };
  });
}

/** Committed, published events after `afterSeq`, in seq order. */
export function publishedEventsAfter(db: PrismaClient, businessId: string, afterSeq: number, take: number): Promise<EventRow[]> {
  return db.appointmentEvent.findMany({
    where: { businessId, seq: { gt: afterSeq }, type: { in: [...PUBLISHED_LOG_TYPES] } },
    orderBy: { seq: 'asc' },
    take,
    select: { id: true, businessId: true, appointmentId: true, type: true, seq: true, payload: true, createdAt: true },
  });
}

export const eventsQuery = z
  .object({
    since: z.coerce.number().int().min(0).default(0),
    cursor: z.string().optional(),
    limit: limitField,
  })
  .strict();
const eventsCursor = z.object({ seq: z.number().int().min(0) });

/**
 * `GET /v1/events?since=<seq>` — a receiver that was dark replays from the
 * last seq it saw. `nextCursor` continues the same walk; `since` and a cursor
 * together take the later of the two.
 */
export async function listEvents({ caller, deps, url, now }: RequestContext): Promise<Response> {
  const q = parseWith(eventsQuery, queryOf(url), 'query');
  const after = Math.max(q.since, decodeCursor(eventsCursor, q.cursor)?.seq ?? 0);
  const rows = await publishedEventsAfter(deps.prisma, caller.businessId, after, q.limit + 1);
  const { data, nextCursor } = page(rows, q.limit, (r) => ({ seq: r.seq! }));
  return json({ data: await eventBodies(deps.prisma, data, caller.timezone, now), nextCursor });
}
