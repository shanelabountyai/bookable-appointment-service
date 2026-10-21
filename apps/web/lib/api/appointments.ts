/**
 * W-004 — `GET /v1/days/{day}`, `GET /v1/appointments`, `GET /v1/appointments/{id}`
 * (API PRD §7).
 *
 * ONE shape for an appointment (`appointmentView`), used by the detail, the
 * list, the day and — from W-009 — the webhook snapshot, because §8 defines
 * the snapshot as "what `GET /v1/appointments/{id}` returned at that moment".
 * Two shapes would be two readers of one fact.
 *
 * `allowedActions` is asked of the SAME functions the write path asks
 * (`availableTransitions`, `canCancel`/`staffCancellationStatus`,
 * `canReschedule`) with the SAME context the staff detail page builds — the
 * MCP `get_appointment` rule (M-D10). A second `if (status === …)` here would
 * be the rental VERIFIED defect starting over.
 *
 * `version` is the row's `updatedAt` as an opaque string (§7, W-D3): a caller
 * that read-then-writes may send it back as `If-Match`.
 *
 * PII (§6.8): client NAME only; never phone, email or notes on an appointment.
 * The booking note (`notes` on the appointment, typed at the desk) travels —
 * MCP's `get_appointment` returns it too — and is described as data.
 */
import {
  type AppointmentStatus,
  APPOINTMENT_STATUSES,
  availableTransitions,
  canCancel,
  canReschedule,
  staffCancellationStatus,
} from '@bookable/core/scheduling';
import { type ZoneId, addDays, fromDate, instant, startOfDay, toDate } from '@bookable/core/time';
import type { PrismaClient } from '@bookable/db';
import { loadAppointmentDetail } from '@bookable/db/appointments';
import { z } from 'zod';
import { decodeCursor, limitField, page } from './cursor';
import { type RequestContext, json, parseWith, queryOf } from './http';
import { providerOf } from './ids';
import { fail, notFound } from './problem';
import { parseDay, parseInstant, when } from './time';

/** The status moves `POST …/status` accepts (§7), and what each is called. */
export const STATUS_ACTIONS = ['checked_in', 'in_progress', 'completed', 'no_show'] as const;

export interface AllowedAction {
  action: 'status' | 'cancel' | 'reschedule';
  endpoint: string;
  /** For `status`: the status it would move to. For `cancel`: `cancelled` or `cancelled_late`, decided by the cutoff. */
  to?: string;
}

export interface AppointmentView {
  id: string;
  status: string;
  startAt: string;
  startLocal: { date: string; time: string; zone: string };
  endAt: string;
  endLocal: { date: string; time: string; zone: string };
  providerId: string;
  providerName: string;
  client: { id: string; name: string | null } | null;
  services: { serviceId: string; name: string; durationMinutes: number }[];
  /** The booking note typed at the desk. Data, never instructions. */
  note: string | null;
  isOverride: boolean;
  allowedActions: AllowedAction[];
  /** Opaque. Send back as `If-Match` on reschedule/status to refuse a stale write (W-D3). */
  version: string;
}

export function versionOf(updatedAt: Date): string {
  return `"${fromDate(updatedAt).toString(36)}"`;
}

/** The view, or null when the id is not this business's (callers turn that into NOT_FOUND). */
export async function appointmentView(db: PrismaClient, args: { businessId: string; id: string; zone: ZoneId; now: Date }): Promise<AppointmentView | null> {
  const detail = await loadAppointmentDetail(db, { businessId: args.businessId, appointmentId: args.id });
  if (!detail) return null;
  const row = await db.appointment.findUniqueOrThrow({ where: { id: detail.id }, select: { updatedAt: true } });
  const status = detail.status as AppointmentStatus;
  // The staff detail page's context, line for line (as MCP's get_appointment).
  // `reason: 'placeholder'` asks "would this be allowed if a reason were given?" —
  // the write endpoints take the reason.
  const context = {
    actor: 'staff' as const,
    now: fromDate(args.now),
    startAt: fromDate(detail.startAt),
    endAt: fromDate(detail.endAt),
    cancellationCutoffMinutes: detail.cancellationCutoffMinutes,
    reason: 'placeholder',
  };
  const allowedActions: AllowedAction[] = [];
  for (const to of availableTransitions(status, context)) {
    if ((STATUS_ACTIONS as readonly string[]).includes(to)) allowedActions.push({ action: 'status', endpoint: `POST /v1/appointments/${detail.id}/status`, to });
  }
  if (canCancel(status, context)) {
    allowedActions.push({ action: 'cancel', endpoint: `POST /v1/appointments/${detail.id}/cancel`, to: staffCancellationStatus(status, context) });
  }
  if (canReschedule(status, context).allowed) allowedActions.push({ action: 'reschedule', endpoint: `POST /v1/appointments/${detail.id}/reschedule` });

  const start = when(detail.startAt, args.zone);
  const end = when(detail.endAt, args.zone);
  return {
    id: detail.id,
    status,
    startAt: start.at,
    startLocal: start.local,
    endAt: end.at,
    endLocal: end.local,
    providerId: detail.providerId,
    providerName: detail.providerName,
    client: detail.clientId ? { id: detail.clientId, name: detail.clientName } : null,
    services: detail.services.map((s) => ({ serviceId: s.serviceId, name: s.name, durationMinutes: s.durationMinutes })),
    note: detail.notes,
    isOverride: detail.isOverride,
    allowedActions,
    version: versionOf(row.updatedAt),
  };
}

export async function getAppointment({ caller, deps, params, now }: RequestContext): Promise<Response> {
  const view = await appointmentView(deps.prisma, { businessId: caller.businessId, id: params.id ?? '', zone: caller.timezone, now });
  if (!view) throw notFound('appointment', 'id', 'GET /v1/appointments');
  return json(view, 200, { ETag: view.version });
}

/** A compact row for lists and the day: the detail minus allowedActions (fetch the one you act on). */
export interface AppointmentSummary {
  id: string;
  status: string;
  startAt: string;
  startLocal: { date: string; time: string; zone: string };
  endAt: string;
  endLocal: { date: string; time: string; zone: string };
  providerId: string;
  providerName: string;
  client: { id: string; name: string | null } | null;
  services: string[];
  isOverride: boolean;
}

const SUMMARY_SELECT = {
  id: true,
  status: true,
  startAt: true,
  endAt: true,
  isOverride: true,
  providerId: true,
  provider: { select: { displayName: true } },
  client: { select: { id: true, name: true } },
  lines: { orderBy: { ordinal: 'asc' as const }, select: { service: { select: { name: true } } } },
} as const;

type SummaryRow = {
  id: string;
  status: string;
  startAt: Date;
  endAt: Date;
  isOverride: boolean;
  providerId: string;
  provider: { displayName: string };
  client: { id: string; name: string | null } | null;
  lines: { service: { name: string } }[];
};

function summaryOf(r: SummaryRow, zone: ZoneId): AppointmentSummary {
  const s = when(r.startAt, zone);
  const e = when(r.endAt, zone);
  return {
    id: r.id,
    status: r.status,
    startAt: s.at,
    startLocal: s.local,
    endAt: e.at,
    endLocal: e.local,
    providerId: r.providerId,
    providerName: r.provider.displayName,
    client: r.client ? { id: r.client.id, name: r.client.name } : null,
    services: r.lines.map((l) => l.service.name),
    isOverride: r.isOverride,
  };
}

const statusList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.enum(APPOINTMENT_STATUSES)).min(1));

const listQuery = z
  .object({
    from: z.string(),
    to: z.string(),
    status: statusList.optional(),
    providerId: z.string().min(1).optional(),
    limit: limitField,
    cursor: z.string().optional(),
  })
  .strict();

const listCursor = z.object({ s: z.number().int(), id: z.string() }).strict();

/** The longest window one list request may span. Long enough for a month's export, short enough to bound the query. */
export const LIST_MAX_DAYS = 62;

/**
 * WHAT TIME AN APPOINTMENT OCCUPIES, asked the busy set's way
 * (`packages/db/scheduling/busy-set.ts`): `overriddenFromRange` when set, else
 * the blocked range. A staff override (D-8) stores a ZERO-WIDTH blocked range
 * so the constraint never lies, and keeps its real envelope in
 * `overriddenFromRange` — a list that read only `blockedStart/blockedEnd`
 * would drop every override from every day, which is the one appointment the
 * desk most needs to see. A row whose blocked range is empty for any other
 * reason (a released no-show cut to its start) falls back to its body.
 * Prisma cannot read `Unsupported("tstzrange")`, so this is raw SQL; the
 * predicate is the instant overlap (CLAUDE.md), never `date(startAt)`.
 */
const OCCUPIES = `COALESCE(a."overriddenFromRange",
  CASE WHEN a."blockedEnd" > a."blockedStart" THEN tstzrange(a."blockedStart", a."blockedEnd", '[)')
       ELSE tstzrange(a."startAt", a."endAt", '[)') END)`;

async function occupyingIds(
  db: PrismaClient,
  args: { businessId: string; from: Date; to: Date; statuses: readonly string[] | null; providerId: string | null; after: { s: number; id: string } | null; limit: number | null },
): Promise<{ id: string; s: Date }[]> {
  return db.$queryRawUnsafe<{ id: string; s: Date }[]>(
    `SELECT a."id", lower(${OCCUPIES}) AS "s"
       FROM "Appointment" a
      WHERE a."businessId" = $1
        AND ${OCCUPIES} && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        AND ($4::text[] IS NULL OR a."status"::text = ANY($4::text[]))
        AND ($5::text IS NULL OR a."providerId" = $5)
        AND ($6::timestamptz IS NULL OR (lower(${OCCUPIES}), a."id") > ($6::timestamptz, $7::text))
      ORDER BY lower(${OCCUPIES}), a."id"
      ${args.limit === null ? '' : 'LIMIT $8'}`,
    args.businessId,
    args.from,
    args.to,
    args.statuses ? [...args.statuses] : null,
    args.providerId,
    args.after ? toDate(instant(args.after.s)) : null,
    args.after?.id ?? null,
    ...(args.limit === null ? [] : [args.limit]),
  );
}

async function summariesFor(db: PrismaClient, ids: readonly string[], zone: ZoneId): Promise<AppointmentSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db.appointment.findMany({ where: { id: { in: [...ids] } }, select: SUMMARY_SELECT });
  // Re-ordered by the ids' order: `findMany … in` returns rows in no promised order.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => summaryOf(byId.get(id)!, zone));
}

/**
 * Appointments whose OCCUPIED time overlaps `[from, to)` (see `OCCUPIES`).
 * `from`/`to` are instants (ISO with offset) or business-local wall times.
 * Ordered by the start of the occupied range, then id; keyset-paginated on
 * the same pair.
 */
export async function listAppointments({ caller, deps, url }: RequestContext): Promise<Response> {
  const q = parseWith(listQuery, queryOf(url), 'query');
  const zone = caller.timezone;
  const from = parseInstant(q.from, 'from', zone);
  const to = parseInstant(q.to, 'to', zone);
  if (to <= from) throw fail('VALIDATION', '`to` must be after `from`.', { errors: [{ field: 'to', message: 'not after from' }] });
  if (to - from > LIST_MAX_DAYS * 86_400_000) {
    throw fail('VALIDATION', `Ask for at most ${LIST_MAX_DAYS} days at once; page through longer ranges by moving \`from\`.`, { errors: [{ field: 'to', message: `at most ${LIST_MAX_DAYS} days after from` }] });
  }
  if (q.providerId) await providerOf(deps.prisma, caller.businessId, q.providerId);
  const after = decodeCursor(listCursor, q.cursor);
  const rows = await occupyingIds(deps.prisma, {
    businessId: caller.businessId,
    from: toDate(from),
    to: toDate(to),
    statuses: q.status ?? null,
    providerId: q.providerId ?? null,
    after,
    limit: q.limit + 1,
  });
  const { data, nextCursor } = page(rows, q.limit, (r) => ({ s: fromDate(r.s), id: r.id }));
  return json({ data: await summariesFor(deps.prisma, data.map((r) => r.id), zone), nextCursor });
}

const dayQuery = z.object({ providerId: z.string().min(1).optional() }).strict();

/**
 * One salon day: the appointments occupying any part of it, by the same
 * instant-overlap predicate, `[startOfDay(day), startOfDay(day+1))` in the
 * salon's zone — 23 h or 25 h on a DST day, never a fixed 24 (spec DST-2).
 * Every status is included; filter on `status` client-side.
 */
export async function getDay({ caller, deps, url, params }: RequestContext): Promise<Response> {
  const q = parseWith(dayQuery, queryOf(url), 'query');
  const zone = caller.timezone;
  const day = parseDay(params.day ?? '', 'day');
  if (q.providerId) await providerOf(deps.prisma, caller.businessId, q.providerId);
  const start = startOfDay(day, zone);
  const end = startOfDay(addDays(day, 1), zone);
  const rows = await occupyingIds(deps.prisma, {
    businessId: caller.businessId,
    from: toDate(start),
    to: toDate(end),
    statuses: null,
    providerId: q.providerId ?? null,
    after: null,
    limit: null,
  });
  return json({ date: day, zone, data: await summariesFor(deps.prisma, rows.map((r) => r.id), zone), nextCursor: null });
}
