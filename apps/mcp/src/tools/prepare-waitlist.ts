import { TIME_BAND_TAGS, WEEKDAY_TAGS } from '@bookable/core/waitlist';
import { daysBetween } from '@bookable/core/time';
import { createWaitlistEntry } from '@bookable/db/waitlist';
import { z } from 'zod';
import { invalidArgument } from '../errors';
import { parseDay, readableDay } from '../time';
import { clientOf, providerOf, servicesOf } from './ids';
import { defineWrite } from './proposals';

export interface WaitlistCanonical {
  client_id: string;
  service_ids: string[];
  provider_ids: string[];
  from_day: string;
  to_day: string;
  day_parts: string[];
  [key: string]: string | string[];
}

const DAY_PARTS = [...WEEKDAY_TAGS, ...TIME_BAND_TAGS] as [string, ...string[]];

export const waitlistAction = defineWrite({
  name: 'prepare_waitlist_entry',
  description:
    'Preview adding a client to the waitlist for a range of days, with optional stylist and day-part preferences (weekday names, morning/afternoon/evening — ALL must hold). ' +
    'Use when find_open_times has nothing the client can take. Ids from find_client, list_services and list_providers.',
  inputSchema: {
    client_id: z.string(),
    service_ids: z.array(z.string()).min(1),
    from_day: z.string().describe('YYYY-MM-DD'),
    to_day: z.string().describe('YYYY-MM-DD, on or after from_day'),
    provider_id: z.string().optional().describe('Only this stylist. Omit for anyone qualified.'),
    day_parts: z.array(z.enum(DAY_PARTS)).optional().describe('e.g. ["saturday", "morning"]'),
  },
  outputSchema: {
    entry_id: z.string(),
    from_day: z.string(),
    to_day: z.string(),
  },
  async prepare(ctx, args, deps) {
    const db = deps.prisma;
    const client = await clientOf(db, ctx.businessId, args.client_id);
    const services = await servicesOf(db, ctx.businessId, args.service_ids);
    const provider = args.provider_id ? await providerOf(db, ctx.businessId, args.provider_id) : null;
    const fromDay = parseDay(args.from_day, 'from_day');
    const toDay = parseDay(args.to_day, 'to_day');
    if (daysBetween(fromDay, toDay) < 0) throw invalidArgument('to_day', 'to_day is before from_day.');
    const parts = [...new Set(args.day_parts ?? [])];
    const canonical: WaitlistCanonical = {
      client_id: client.id,
      service_ids: [...args.service_ids],
      provider_ids: provider ? [provider.id] : [],
      from_day: fromDay,
      to_day: toDay,
      day_parts: parts,
    };
    const when = fromDay === toDay ? readableDay(fromDay) : `${readableDay(fromDay)} – ${readableDay(toDay)}`;
    const prefs = [...(parts.length ? [parts.join(' ')] : []), ...(provider ? [`with ${provider.displayName}`] : [])];
    return {
      canonical,
      summary: `Add ${client.name ?? 'the client'} to the waitlist for ${services.map((s) => s.name).join(' + ')}, ${when}${prefs.length ? `, ${prefs.join(', ')}` : ''}.`,
    };
  },
  async commit(ctx, c, deps) {
    const row = await createWaitlistEntry(deps.prisma, {
      businessId: ctx.businessId,
      clientId: c.client_id,
      serviceIds: c.service_ids,
      providerIds: c.provider_ids,
      fromDay: c.from_day,
      toDay: c.to_day,
      dayParts: c.day_parts,
    });
    return { summary: `on the waitlist (entry ${row.id}).`, data: { entry_id: row.id, from_day: row.fromDay, to_day: row.toDay } };
  },
});
