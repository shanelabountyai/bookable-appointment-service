/**
 * find_open_times — what the desk's booking panel offers, over MCP.
 *
 * Same engine, same arguments as `/staff/book` (`audience: 'staff'`: no lead
 * time (D-25), no horizon (D-21)); the named-stylist path is `computeDaySlots`
 * and the "any" path is `anyProviderTimes`, exactly the two the panel uses.
 * `client_id` is threaded through as `holderKey` for the same reason the panel
 * threads it (A-082/A-083): the offer must ask the question the write will
 * ask, or the server offers a time the room then refuses.
 *
 * Never offers an override: the engine has no such output.
 */
import { addDays, daysBetween, type CalendarDay } from '@bookable/core/time';
import { TIME_BAND_TAGS, tagsFor } from '@bookable/core/waitlist';
import { anyProviderTimes } from '@bookable/db/booking';
import { qualifiedForVisit } from '@bookable/db/qualification';
import { computeDaySlots, DESK_DAY_SEARCH_DAYS } from '@bookable/db/scheduling';
import { z } from 'zod';
import { ToolFailure, invalidArgument } from '../errors';
import { parseDay, readableDay, timeOut, timeOutOf, type TimeOut } from '../time';
import { ALL_ROLES, defineTool } from './define';
import { clientOf, providerOf, servicesOf } from './ids';

const ANY = 'any';

const timeShape = z.object({
  label: z.string(),
  iso: z.string(),
  free_count: z.number().int().optional().describe('With "any": how many qualified stylists are free at this time.'),
});

export const findOpenTimesTool = defineTool({
  name: 'find_open_times',
  roles: ALL_ROLES,
  description:
    `Find times a visit can be booked, grouped by day and stylist, up to ${DESK_DAY_SEARCH_DAYS} days at once. ` +
    'provider_id is a stylist id from list_providers, or "any" to search everyone qualified — then each time is listed ONCE, under the stylist the desk would assign, with free_count saying how many others could take it. Pass client_id when you know who the visit is for — it keeps the offer honest about the chairs. ' +
    'Days are the salon\'s calendar (YYYY-MM-DD); every time comes back as a label and an ISO instant — send the iso to prepare_booking. ' +
    'Staff rules apply: no lead time, no booking horizon. This does not book anything and never offers a double-booking.',
  inputSchema: {
    service_ids: z.array(z.string()).min(1).describe('The services in the visit, in order. From list_services.'),
    provider_id: z.string().describe('A stylist id from list_providers, or "any".'),
    from_day: z.string().describe('First day to search, YYYY-MM-DD.'),
    to_day: z.string().describe(`Last day to search, YYYY-MM-DD, at most ${DESK_DAY_SEARCH_DAYS} days after from_day.`),
    part_of_day: z.enum(TIME_BAND_TAGS).optional().describe('morning (before 12:00), afternoon (12:00–17:00) or evening.'),
    client_id: z.string().optional().describe('The client this is for, from find_client, when known.'),
  },
  outputSchema: {
    days: z.array(
      z.object({
        day: z.string(),
        label: z.string(),
        providers: z.array(z.object({ provider_id: z.string(), name: z.string(), times: z.array(timeShape) })),
      }),
    ),
    count: z.number().int(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler(ctx, args, deps) {
    const db = deps.prisma;
    const now = deps.now();
    const fromDay = parseDay(args.from_day, 'from_day');
    const toDay = parseDay(args.to_day, 'to_day');
    const span = daysBetween(fromDay, toDay);
    if (span < 0) throw invalidArgument('to_day', 'to_day is before from_day.');
    if (span >= DESK_DAY_SEARCH_DAYS) {
      throw invalidArgument('to_day', `Search at most ${DESK_DAY_SEARCH_DAYS} days at once; move from_day forward for later dates.`);
    }

    await servicesOf(db, ctx.businessId, args.service_ids);
    const holderKey = args.client_id ? (await clientOf(db, ctx.businessId, args.client_id)).id : null;

    const provider = args.provider_id === ANY ? null : await providerOf(db, ctx.businessId, args.provider_id);
    if (provider && !(await qualifiedForVisit(db, { businessId: ctx.businessId, providerId: provider.id, serviceIds: args.service_ids }))) {
      throw new ToolFailure({
        error: 'NOT_QUALIFIED',
        message: `${provider.displayName} cannot do everything in this visit.`,
        field: 'provider_id',
        next: { tool: 'list_providers', why: 'pass these service_ids to see who can' },
      });
    }

    const wanted = args.part_of_day;
    const inPart = (day: CalendarDay, time: string) => !wanted || tagsFor(day, time as never).includes(wanted);

    type Offered = TimeOut & { free_count?: number };
    const days: { day: string; label: string; providers: { provider_id: string; name: string; times: Offered[] }[] }[] = [];
    let count = 0;
    for (let day = fromDay; daysBetween(day, toDay) >= 0; day = addDays(day, 1)) {
      const perProvider = new Map<string, { name: string; times: Offered[] }>();
      if (provider) {
        const { slots } = await computeDaySlots(db, {
          businessId: ctx.businessId,
          providerId: provider.id,
          serviceIds: args.service_ids,
          day,
          now,
          audience: 'staff',
          holderKey,
        });
        const times = slots.filter((s) => inPart(s.label.day, s.label.time)).map((s) => timeOut(s.start, ctx.timezone));
        if (times.length) perProvider.set(provider.id, { name: provider.displayName, times });
      } else {
        const offered = await anyProviderTimes(db, {
          businessId: ctx.businessId,
          serviceIds: args.service_ids,
          day,
          now,
          audience: 'staff',
          holderKey,
        });
        for (const t of offered) {
          const out = timeOutOf(t.at, ctx.timezone);
          if (!inPart(day, out.iso.slice(11, 16))) continue;
          const entry = perProvider.get(t.providerId) ?? { name: t.providerName, times: [] };
          entry.times.push({ ...out, free_count: t.freeCount });
          perProvider.set(t.providerId, entry);
        }
      }
      if (perProvider.size === 0) continue;
      const providers = [...perProvider.entries()].map(([provider_id, p]) => ({ provider_id, name: p.name, times: p.times }));
      count += providers.reduce((n, p) => n + p.times.length, 0);
      days.push({ day, label: readableDay(day), providers });
    }

    const who = provider ? provider.displayName : 'any stylist';
    const where = fromDay === toDay ? readableDay(fromDay) : `${readableDay(fromDay)} – ${readableDay(toDay)}`;
    return {
      summary: `${count} open time${count === 1 ? '' : 's'} with ${who}, ${where}${count === 0 ? ' — try other days or "any"' : ''}.`,
      data: { days, count },
    };
  },
});
