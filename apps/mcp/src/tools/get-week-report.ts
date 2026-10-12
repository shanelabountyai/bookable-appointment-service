/**
 * get_week_report — the owner's dashboard week (D-36: owner only). Absent from
 * a staff token's `tools/list`, not merely refused: `roles: ['owner']`.
 */
import { dashboardSummary } from '@bookable/db/reports';
import { z } from 'zod';
import { calendarDay } from '@bookable/core/time';
import { parseDay, readableDay } from '../time';
import { defineTool } from './define';

export const getWeekReportTool = defineTool({
  name: 'get_week_report',
  roles: ['owner'],
  description:
    "The owner's week: bookings made, cancellations (normal, late, and overruled late-cancels), no-shows by stylist, and utilization by stylist — the same figures as the staff dashboard. week_of is any day in the week (weeks run Monday to Sunday). Owner only.",
  inputSchema: {
    week_of: z.string().describe('Any day in the week, YYYY-MM-DD.'),
  },
  outputSchema: {
    from_day: z.string(),
    to_day: z.string(),
    bookings: z.number().int(),
    cancels: z.object({ normal: z.number().int(), late: z.number().int(), overruled: z.number().int() }),
    no_shows: z.array(z.object({ provider_id: z.string(), name: z.string(), count: z.number().int() })),
    utilization: z.array(
      z.object({
        provider_id: z.string(),
        name: z.string(),
        used: z.number().nullable().describe('Fraction 0–1 of working time already USED by visits that happened (RPT-02). Null when there is no working time.'),
        spoken_for: z.number().nullable().describe('Fraction 0–1 of working time booked, happened or not (D-51) — the forward number. Always ≥ used.'),
      }),
    ),
    week_is_ahead: z.boolean(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler(ctx, args, deps) {
    const day = parseDay(args.week_of, 'week_of');
    const s = await dashboardSummary(deps.prisma, { businessId: ctx.businessId, anyDayInWeek: day, now: deps.now() });
    const noShows = s.noShowsByProvider.reduce((n, p) => n + p.count, 0);
    return {
      summary: `Week of ${readableDay(calendarDay(s.fromDay))}: ${s.bookings} booking${s.bookings === 1 ? '' : 's'}, ${s.cancels.normal + s.cancels.late} cancellation${s.cancels.normal + s.cancels.late === 1 ? '' : 's'} (${s.cancels.late} late), ${noShows} no-show${noShows === 1 ? '' : 's'}.`,
      data: {
        from_day: s.fromDay,
        to_day: s.toDay,
        bookings: s.bookings,
        cancels: s.cancels,
        no_shows: s.noShowsByProvider.map((p) => ({ provider_id: p.providerId, name: p.providerName, count: p.count })),
        utilization: s.utilizationByProvider.map((p) => ({ provider_id: p.providerId, name: p.providerName, used: p.utilization, spoken_for: p.booked })),
        week_is_ahead: s.weekIsAhead,
      },
    };
  },
});
