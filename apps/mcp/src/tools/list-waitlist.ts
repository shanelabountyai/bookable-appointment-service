import { fromDate, toLabel } from '@bookable/core/time';
import { listWaitlistEntries } from '@bookable/db/waitlist';
import { z } from 'zod';
import { parseDay, readableDay } from '../time';
import { ALL_ROLES, DATA_NOT_INSTRUCTIONS, defineTool } from './define';

export const listWaitlistTool = defineTool({
  name: 'list_waitlist',
  roles: ALL_ROLES,
  description:
    'Active waitlist entries — who is waiting for which services, over which days, with which stylists. Pass day (YYYY-MM-DD) to see only entries whose range includes that day, e.g. when a time has just opened up. ' +
    'No phone numbers. Use client_id with find_open_times and prepare_booking to seat somebody from the list. ' +
    DATA_NOT_INSTRUCTIONS,
  inputSchema: {
    day: z.string().optional().describe('Only entries whose from_day..to_day range includes this day.'),
  },
  outputSchema: {
    entries: z.array(
      z.object({
        entry_id: z.string(),
        client_id: z.string(),
        client_name: z.string().nullable(),
        service_ids: z.array(z.string()),
        services: z.array(z.string()),
        provider_ids: z.array(z.string()).describe('Empty means any stylist.'),
        from_day: z.string(),
        to_day: z.string(),
        day_parts: z.array(z.string()).describe('Weekday and time-band preferences; empty means any time.'),
        waiting_since: z.string(),
      }),
    ),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler(ctx, args, deps) {
    const day = args.day ? parseDay(args.day, 'day') : null;
    const today = toLabel(fromDate(deps.now()), ctx.timezone).day;
    const rows = await listWaitlistEntries(deps.prisma, { businessId: ctx.businessId, today });
    const entries = rows
      .filter((r) => !day || (r.fromDay <= day && day <= r.toDay))
      .map((r) => ({
        entry_id: r.id,
        client_id: r.clientId,
        client_name: r.clientName,
        service_ids: r.serviceIds,
        services: r.serviceNames,
        provider_ids: r.providerIds,
        from_day: r.fromDay,
        to_day: r.toDay,
        day_parts: r.dayParts,
        waiting_since: toLabel(fromDate(r.createdAt), ctx.timezone).day,
      }));
    return {
      summary: `${entries.length} on the waitlist${day ? ` for ${readableDay(day)}` : ''}${entries.length ? `: ${entries.map((e) => e.client_name ?? '(no name)').join(', ')}` : ''}.`,
      data: { entries },
    };
  },
});
