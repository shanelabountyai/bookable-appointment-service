/**
 * W-007 — `POST /v1/appointments/{id}/reschedule`, `/cancel`, `/status`, and
 * `POST /v1/waitlist` (API PRD §7). All idempotent (W-006), all through the
 * desk's own `packages/db` functions with `apiActor(keyId)`:
 *
 *   reschedule — `rescheduleAppointment` (D-6: a same-row UPDATE in one
 *                transaction; D-31: the provider may change), or
 *                `reassignAppointment` when the INSTANT is unchanged and only
 *                the provider differs (M-D16: `rescheduleAppointment` refuses an
 *                unchanged instant as `already-at-that-time`, so one operational
 *                question has two domain functions behind it — routed HERE, once);
 *   cancel     — `transitionAppointment` with `cancellation: 'derive'`, so the
 *                machine decides `cancelled` vs `cancelled_late` from the cutoff
 *                (A-060); `tellClient` defaults to TRUE (D-32);
 *   status     — `transitionAppointment` to checked_in | in_progress | completed | no_show;
 *   waitlist   — `createWaitlistEntry`.
 *
 * `If-Match` (W-D3: optional in v1, honoured when sent) is checked against the
 * row's `version` AFTER taking the row lock (`SELECT … FOR UPDATE`) inside the
 * work transaction, so no desk write can land between the check and the domain
 * function's own write — a check-then-write with no lock would be the shape this
 * repo refuses everywhere else. A stale version is 412 and nothing is written.
 * The status and cancel paths ALSO pass `expectedFrom` (the status the request
 * saw), so a concurrent desk tap becomes 409 CONFLICT rather than an overwrite —
 * M-D14's guard, with or without If-Match.
 */
import { apiActor } from '@bookable/core/auth';
import { type AppointmentStatus } from '@bookable/core/scheduling';
import { fromDate, toDate } from '@bookable/core/time';
import type { PrismaClient } from '@bookable/db';
import { rescheduleAppointment, transitionAppointment } from '@bookable/db/appointments';
import { reassignAppointment } from '@bookable/db/availability';
import { BookingRejected, SlotTaken } from '@bookable/db/booking';
import { createWaitlistEntry } from '@bookable/db/waitlist';
import { TIME_BAND_TAGS, WEEKDAY_TAGS } from '@bookable/core/waitlist';
import { offeredSlot } from '@bookable/mcp';
import { z } from 'zod';
import { STATUS_ACTIONS, appointmentView, versionOf } from './appointments';
import { type RequestContext, parseWith } from './http';
import { type IdempotencyHooks, idempotent } from './idempotent';
import { clientOf, providerOf, servicesOf } from './ids';
import { fail, notFound } from './problem';
import { parseDay, parseInstant } from './time';

interface Locked {
  id: string;
  status: AppointmentStatus;
  startAt: Date;
  providerId: string;
  clientId: string | null;
  updatedAt: Date;
}

/** Lock the row for the rest of the work transaction, then honour If-Match against it. */
async function lockForWrite(db: PrismaClient, ctx: RequestContext): Promise<Locked> {
  const id = ctx.params.id ?? '';
  const rows = await db.$queryRaw<Locked[]>`
    SELECT "id", "status"::text AS "status", "startAt", "providerId", "clientId", "updatedAt"
      FROM "Appointment" WHERE "id" = ${id} AND "businessId" = ${ctx.caller.businessId}
       FOR UPDATE`;
  const row = rows[0];
  if (!row) throw notFound('appointment', 'id', 'GET /v1/appointments');
  const ifMatch = ctx.request.headers.get('if-match');
  if (ifMatch !== null && ifMatch !== '*' && ifMatch.trim() !== versionOf(row.updatedAt)) {
    throw fail('PRECONDITION_FAILED', 'The appointment changed since you read it. Nothing was written; read it again.', {
      errors: [{ field: 'If-Match', message: 'stale version' }],
      next: { endpoint: `GET /v1/appointments/${row.id}`, why: 'read the current version and allowedActions' },
    });
  }
  return row;
}

async function viewAfter(db: PrismaClient, ctx: RequestContext, id: string) {
  const view = await appointmentView(db, { businessId: ctx.caller.businessId, id, zone: ctx.caller.timezone, now: ctx.now });
  return { status: 200, body: view, headers: { ETag: view!.version } };
}

export const rescheduleBody = z
  .object({
    start: z.string().min(1),
    /** Omit to keep the same provider. */
    providerId: z.string().min(1).optional(),
    reason: z.string().max(300).optional(),
  })
  .strict();

export function postReschedule(hooks: IdempotencyHooks = {}) {
  return (ctx: RequestContext) =>
    idempotent(
      ctx,
      async ({ body, db, caller, now }) => {
        const b = parseWith(rescheduleBody, body, 'body');
        const row = await lockForWrite(db, ctx);
        const start = parseInstant(b.start, 'start', caller.timezone);
        const target = b.providerId ? await providerOf(db, caller.businessId, b.providerId) : null;
        const toProviderId = target && target.id !== row.providerId ? target.id : null;

        if (toProviderId && fromDate(row.startAt) === start) {
          // Same instant, different provider: the desk's sick-stylist path (M-D16).
          const outcome = await reassignAppointment(db, { businessId: caller.businessId, appointmentId: row.id, toProviderId, actor: apiActor(caller.keyId), reason: b.reason ?? null, notify: true });
          if (!outcome.ok) {
            switch (outcome.failure) {
              case 'provider-busy':
                throw new SlotTaken([], ['overlaps-booking']);
              case 'not-qualified':
                throw new BookingRejected('toProviderId', 'They are not set up to do everything in this visit.');
              case 'not-active':
                throw notFound('provider', 'providerId', 'GET /v1/providers');
              default:
                throw fail('INVALID_TRANSITION', `An appointment that is ${row.status} cannot be moved.`, {
                  next: { endpoint: `GET /v1/appointments/${row.id}`, why: 'read allowedActions for what it can do now' },
                });
            }
          }
          return viewAfter(db, ctx, row.id);
        }

        // Ask the engine first so a refusal names its reason (OUTSIDE_HOURS vs SLOT_TAKEN);
        // the domain function re-checks under its own lock and the constraint is the last word.
        const serviceIds = (await db.appointmentServiceLine.findMany({ where: { appointmentId: row.id }, orderBy: { ordinal: 'asc' }, select: { serviceId: true } })).map((l) => l.serviceId);
        await offeredSlot({ prisma: db, now, businessId: caller.businessId, providerId: toProviderId ?? row.providerId, serviceIds, holderKey: row.clientId, start, zone: caller.timezone, excludeAppointmentId: row.id });
        await rescheduleAppointment(db, {
          businessId: caller.businessId,
          appointmentId: row.id,
          startAt: toDate(start),
          now,
          actor: apiActor(caller.keyId),
          toProviderId,
          audience: 'staff',
          reason: b.reason?.trim() || null,
        });
        return viewAfter(db, ctx, row.id);
      },
      hooks,
    );
}

export const cancelBody = z
  .object({
    reason: z.string().trim().min(1).max(300),
    /** D-32: the client is told unless you say otherwise. */
    tellClient: z.boolean().default(true),
  })
  .strict();

export function postCancel(hooks: IdempotencyHooks = {}) {
  return (ctx: RequestContext) =>
    idempotent(
      ctx,
      async ({ body, db, caller, now }) => {
        const b = parseWith(cancelBody, body, 'body');
        const row = await lockForWrite(db, ctx);
        await transitionAppointment(db, {
          businessId: caller.businessId,
          appointmentId: row.id,
          to: 'cancelled',
          cancellation: 'derive',
          actor: apiActor(caller.keyId),
          now,
          reason: b.reason,
          notify: b.tellClient,
          expectedFrom: row.status,
        });
        return viewAfter(db, ctx, row.id);
      },
      hooks,
    );
}

export const statusBody = z.object({ to: z.enum(STATUS_ACTIONS), reason: z.string().trim().min(1).max(300).optional() }).strict();

export function postStatus(hooks: IdempotencyHooks = {}) {
  return (ctx: RequestContext) =>
    idempotent(
      ctx,
      async ({ body, db, caller, now }) => {
        const b = parseWith(statusBody, body, 'body');
        const row = await lockForWrite(db, ctx);
        await transitionAppointment(db, {
          businessId: caller.businessId,
          appointmentId: row.id,
          to: b.to,
          actor: apiActor(caller.keyId),
          now,
          reason: b.reason ?? null,
          expectedFrom: row.status,
        });
        return viewAfter(db, ctx, row.id);
      },
      hooks,
    );
}

const DAY_PARTS = [...WEEKDAY_TAGS, ...TIME_BAND_TAGS] as [string, ...string[]];

export const waitlistBody = z
  .object({
    clientId: z.string().min(1),
    serviceIds: z.array(z.string().min(1)).min(1).max(10),
    /** `{ from, to }` salon calendar days, inclusive. */
    dayRange: z.object({ from: z.string(), to: z.string() }).strict(),
    providerId: z.string().min(1).optional(),
    /** Weekday names and morning/afternoon/evening — ALL must hold. */
    dayParts: z.array(z.enum(DAY_PARTS)).max(10).optional(),
  })
  .strict();

export function postWaitlist(hooks: IdempotencyHooks = {}) {
  return (ctx: RequestContext) =>
    idempotent(
      ctx,
      async ({ body, db, caller }) => {
        const b = parseWith(waitlistBody, body, 'body');
        const client = await clientOf(db, caller.businessId, b.clientId);
        await servicesOf(db, caller.businessId, b.serviceIds);
        const provider = b.providerId ? await providerOf(db, caller.businessId, b.providerId) : null;
        const fromDay = parseDay(b.dayRange.from, 'dayRange.from');
        const toDay = parseDay(b.dayRange.to, 'dayRange.to');
        if (toDay < fromDay) throw fail('VALIDATION', 'dayRange.to is before dayRange.from.', { errors: [{ field: 'dayRange.to', message: 'before from' }] });
        const row = await createWaitlistEntry(db, {
          businessId: caller.businessId,
          clientId: client.id,
          serviceIds: b.serviceIds,
          providerIds: provider ? [provider.id] : [],
          fromDay,
          toDay,
          dayParts: [...new Set(b.dayParts ?? [])],
        });
        return {
          status: 201,
          body: { id: row.id, client: { id: client.id, name: client.name }, serviceIds: row.serviceIds, providerIds: row.providerIds, fromDay: row.fromDay, toDay: row.toDay, dayParts: row.dayParts },
        };
      },
      hooks,
    );
}
