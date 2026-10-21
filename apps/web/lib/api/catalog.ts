/**
 * W-003 — `GET /v1/services`, `GET /v1/providers`, `GET /v1/availability`
 * (API PRD §7).
 *
 * Availability is the desk's question, asked the desk's way: a named provider
 * is `computeDaySlots` (which is `computeSlotsIn` on a built query) and `any`
 * is `anyProviderTimes` — the exact two paths `/staff/book` and MCP's
 * `find_open_times` use, with `audience: 'staff'` (no lead time D-25, no
 * horizon D-21) and the client as `holderKey` when one is named (A-082/A-083),
 * so the offer asks the question the write will ask. Never an override — the
 * engine has no such output — and never an exclusion reason (CLAUDE.md:
 * reasons are for tests and staff screens).
 */
import { type CalendarDay, addDays, daysBetween, fromDate } from '@bookable/core/time';
import { anyProviderTimes } from '@bookable/db/booking';
import { providersForVisit, qualifiedForVisit } from '@bookable/db/qualification';
import { DESK_DAY_SEARCH_DAYS, computeDaySlots } from '@bookable/db/scheduling';
import { listProviders, listServices } from '@bookable/db/settings';
import { z } from 'zod';
import { type RequestContext, hasScope, json, parseWith, queryOf } from './http';
import { clientOf, providerOf, servicesOf } from './ids';
import { fail } from './problem';
import { isoOf, localOf, parseDay } from './time';

/** The salon's only currency (the booking flow prints `$`); a constant until a second one exists. */
export const CURRENCY = 'USD';

const idList = z
  .string()
  .min(1)
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().min(1)).min(1).max(10));

export async function getServices({ caller, deps }: RequestContext): Promise<Response> {
  const rows = await listServices(deps.prisma, caller.businessId, false);
  const segments = await deps.prisma.serviceSegment.findMany({
    where: { businessId: caller.businessId, serviceId: { in: rows.map((r) => r.id) }, status: 'active' },
    orderBy: [{ serviceId: 'asc' }, { ordinal: 'asc' }],
    select: { serviceId: true, durationMinutes: true, isGap: true },
  });
  const bySvc = new Map<string, { durationMinutes: number; providerNeeded: boolean }[]>();
  for (const s of segments) bySvc.set(s.serviceId, [...(bySvc.get(s.serviceId) ?? []), { durationMinutes: s.durationMinutes, providerNeeded: !s.isGap }]);
  // W-D2: money only with the `prices` scope (D-36 — the owner chose to issue it).
  const prices = hasScope(caller, 'prices');
  const services = rows.map((s) => ({
    id: s.id,
    name: s.name,
    durationMinutes: s.durationMinutes,
    /** Empty for an ordinary service; for a colour, the worked/developing pattern (D-29). */
    segments: bySvc.get(s.id) ?? [],
    bookableOnline: s.bookableOnline,
    ...(prices ? { priceCents: s.priceCents, currency: CURRENCY } : {}),
  }));
  return json({ data: services, nextCursor: null });
}

const providersQuery = z.object({ serviceIds: idList.optional() }).strict();

export async function getProviders({ caller, deps, url }: RequestContext): Promise<Response> {
  const q = parseWith(providersQuery, queryOf(url), 'query');
  const db = deps.prisma;
  let base: { id: string; displayName: string }[];
  if (q.serviceIds) {
    await servicesOf(db, caller.businessId, q.serviceIds);
    base = await providersForVisit(db, { businessId: caller.businessId, serviceIds: q.serviceIds });
  } else {
    base = await listProviders(db, caller.businessId, false);
  }
  const links = await db.serviceProvider.findMany({
    where: { businessId: caller.businessId, providerId: { in: base.map((p) => p.id) }, service: { active: true } },
    select: { providerId: true, serviceId: true },
  });
  const byProvider = new Map<string, string[]>();
  for (const l of links) byProvider.set(l.providerId, [...(byProvider.get(l.providerId) ?? []), l.serviceId]);
  return json({
    data: base.map((p) => ({ id: p.id, name: p.displayName, serviceIds: (byProvider.get(p.id) ?? []).sort() })),
    nextCursor: null,
  });
}

const availabilityQuery = z
  .object({
    serviceIds: idList,
    providerId: z.string().min(1).default('any'),
    from: z.string(),
    to: z.string(),
    clientId: z.string().min(1).optional(),
  })
  .strict();

export interface OfferedStart {
  startAt: string;
  startLocal: { date: string; time: string; zone: string };
  /** With `providerId=any`: how many qualified providers are free at this instant. */
  freeCount?: number;
}

/**
 * Offered starts grouped by day and provider, ≤ 14 days. With `any`, each
 * instant is listed ONCE, under the provider the desk would assign, with
 * `freeCount` (M-D9's shape).
 */
export async function getAvailability({ caller, deps, url, now }: RequestContext): Promise<Response> {
  const q = parseWith(availabilityQuery, queryOf(url), 'query');
  const db = deps.prisma;
  const from = parseDay(q.from, 'from');
  const to = parseDay(q.to, 'to');
  const span = daysBetween(from, to);
  if (span < 0) throw fail('VALIDATION', '`to` is before `from`.', { errors: [{ field: 'to', message: 'before from' }] });
  if (span >= DESK_DAY_SEARCH_DAYS) {
    throw fail('VALIDATION', `Ask for at most ${DESK_DAY_SEARCH_DAYS} days at once.`, { errors: [{ field: 'to', message: `at most ${DESK_DAY_SEARCH_DAYS} days after from` }] });
  }
  await servicesOf(db, caller.businessId, q.serviceIds);
  const holderKey = q.clientId ? (await clientOf(db, caller.businessId, q.clientId)).id : null;
  const provider = q.providerId === 'any' ? null : await providerOf(db, caller.businessId, q.providerId);
  if (provider && !(await qualifiedForVisit(db, { businessId: caller.businessId, providerId: provider.id, serviceIds: q.serviceIds }))) {
    throw fail('NOT_QUALIFIED', `${provider.displayName} cannot do everything in this visit.`, {
      errors: [{ field: 'providerId', message: 'not qualified for every service' }],
      next: { endpoint: 'GET /v1/providers?serviceIds=', why: 'see who can do this whole visit' },
    });
  }

  const zone = caller.timezone;
  const days: { date: string; providers: { providerId: string; name: string; starts: OfferedStart[] }[] }[] = [];
  for (let day: CalendarDay = from; daysBetween(day, to) >= 0; day = addDays(day, 1)) {
    const perProvider = new Map<string, { name: string; starts: OfferedStart[] }>();
    if (provider) {
      const { slots } = await computeDaySlots(db, {
        businessId: caller.businessId,
        providerId: provider.id,
        serviceIds: q.serviceIds,
        day,
        now,
        audience: 'staff',
        holderKey,
      });
      if (slots.length) {
        perProvider.set(provider.id, { name: provider.displayName, starts: slots.map((s) => ({ startAt: isoOf(s.start, zone), startLocal: localOf(s.start, zone) })) });
      }
    } else {
      const offered = await anyProviderTimes(db, { businessId: caller.businessId, serviceIds: q.serviceIds, day, now, audience: 'staff', holderKey });
      for (const t of offered) {
        const at = fromDate(t.at);
        const entry = perProvider.get(t.providerId) ?? { name: t.providerName, starts: [] };
        entry.starts.push({ startAt: isoOf(at, zone), startLocal: localOf(at, zone), freeCount: t.freeCount });
        perProvider.set(t.providerId, entry);
      }
    }
    if (perProvider.size === 0) continue;
    days.push({ date: day, providers: [...perProvider.entries()].map(([providerId, p]) => ({ providerId, name: p.name, starts: p.starts })) });
  }
  return json({ data: days, zone, nextCursor: null });
}
