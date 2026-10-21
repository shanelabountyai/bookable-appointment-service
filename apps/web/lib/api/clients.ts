/**
 * W-005 — `GET /v1/clients?q=`, `GET /v1/clients/{id}`, `GET /v1/waitlist`
 * (API PRD §7, PII §6.8).
 *
 * Search returns at most FIVE matches with the display name, the LAST FOUR of
 * the phone and the reliability flag — never the full number, never email,
 * never notes (the MCP `find_client` rule, M-D10). The detail adds the full
 * phone and email ONLY with the `contacts` scope, plus history and the no-show
 * count; notes never travel at all (OQ-M3: the likeliest carrier of injected
 * text). The waitlist carries names and ids, never a phone.
 */
import { fromDate, toLabel } from '@bookable/core/time';
import { clientHistory, clientReliability, searchClients } from '@bookable/db/clients';
import { listWaitlistEntries } from '@bookable/db/waitlist';
import { z } from 'zod';
import { type RequestContext, hasScope, json, parseWith, queryOf } from './http';
import { clientOf } from './ids';
import { parseDay, when } from './time';

export const CLIENT_SEARCH_LIMIT = 5;

const last4 = (phone: string | null) => (phone ? phone.replace(/\D/g, '').slice(-4) || null : null);

export const searchQuery = z.object({ q: z.string().trim().min(1).max(100) }).strict();

export async function searchClientsHandler({ caller, deps, url, now }: RequestContext): Promise<Response> {
  const q = parseWith(searchQuery, queryOf(url), 'query');
  const all = await searchClients(deps.prisma, caller.businessId, q.q);
  const shown = all.slice(0, CLIENT_SEARCH_LIMIT);
  const today = toLabel(fromDate(now), caller.timezone).day;
  const reliability = await clientReliability(deps.prisma, { businessId: caller.businessId, clientIds: shown.map((c) => c.id), today });
  return json({
    data: shown.map((c) => {
      const r = reliability.get(c.id)!;
      return {
        id: c.id,
        name: c.name,
        phoneLast4: last4(c.phone),
        reliability: { noShows: r.noShows, lateCancels: r.lateCancels, deskOnly: r.selfServeBlocked },
      };
    }),
    /** True when more than five matched — refine `q`. Not a page: a sixth match is a different question. */
    truncated: all.length > shown.length,
    nextCursor: null,
  });
}

export async function getClient({ caller, deps, params, now }: RequestContext): Promise<Response> {
  const db = deps.prisma;
  const c = await clientOf(db, caller.businessId, params.id ?? '');
  const today = toLabel(fromDate(now), caller.timezone).day;
  const r = (await clientReliability(db, { businessId: caller.businessId, clientIds: [c.id], today })).get(c.id)!;
  const visits = (await clientHistory(db, caller.businessId, c.id)).map((v) => {
    const s = when(v.startAt, caller.timezone);
    return { appointmentId: v.appointmentId, startAt: s.at, startLocal: s.local, status: v.status, providerName: v.providerName, services: v.services, _at: fromDate(v.startAt) };
  });
  const nowMs = fromDate(now);
  const upcoming = visits.filter((v) => v._at >= nowMs).sort((x, y) => x._at - y._at);
  const past = visits.filter((v) => v._at < nowMs);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropping the sort key
  const strip = ({ _at, ...v }: (typeof visits)[number]) => v;
  return json({
    id: c.id,
    name: c.name,
    phoneLast4: last4(c.phone),
    // §6.8: the full contact only with the `contacts` scope. Absent, not null, without it.
    ...(hasScope(caller, 'contacts') ? { phone: c.phone, email: c.email } : {}),
    reliability: { noShows: r.noShows, lateCancels: r.lateCancels, deskOnly: r.selfServeBlocked },
    noShowCount: r.noShows,
    upcoming: upcoming.map(strip),
    past: past.map(strip),
  });
}

export const waitlistQuery = z.object({ day: z.string().optional() }).strict();

export async function getWaitlist({ caller, deps, url, now }: RequestContext): Promise<Response> {
  const q = parseWith(waitlistQuery, queryOf(url), 'query');
  const day = q.day ? parseDay(q.day, 'day') : null;
  const today = toLabel(fromDate(now), caller.timezone).day;
  const rows = await listWaitlistEntries(deps.prisma, { businessId: caller.businessId, today });
  return json({
    data: rows
      .filter((r) => !day || (r.fromDay <= day && day <= r.toDay))
      .map((r) => ({
        id: r.id,
        client: { id: r.clientId, name: r.clientName },
        serviceIds: r.serviceIds,
        services: r.serviceNames,
        /** Empty means any qualified provider. */
        providerIds: r.providerIds,
        fromDay: r.fromDay,
        toDay: r.toDay,
        /** Weekday and time-band preferences; empty means any time. */
        dayParts: r.dayParts,
        createdAt: when(r.createdAt, caller.timezone).at,
      })),
    nextCursor: null,
  });
}
