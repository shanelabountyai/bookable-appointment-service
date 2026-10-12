import { providersForVisit } from '@bookable/db/qualification';
import { listProviders } from '@bookable/db/settings';
import { z } from 'zod';
import { ALL_ROLES, defineTool } from './define';
import { servicesOf } from './ids';

export const listProvidersTool = defineTool({
  name: 'list_providers',
  roles: ALL_ROLES,
  description:
    'List the stylists who take appointments, each with the service ids they are qualified for. Pass service_ids to get only the stylists who can do ALL of those services in one visit (SVC-02) — use that before find_open_times or prepare_booking with a named stylist. Ids must come from list_services.',
  inputSchema: {
    service_ids: z.array(z.string()).min(1).optional().describe('Narrow to stylists qualified for every one of these services.'),
  },
  outputSchema: {
    providers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        service_ids: z.array(z.string()).describe('Every active service this stylist can perform.'),
      }),
    ),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler(ctx, args, deps) {
    const db = deps.prisma;
    let base: { id: string; displayName: string }[];
    if (args.service_ids) {
      await servicesOf(db, ctx.businessId, args.service_ids);
      base = await providersForVisit(db, { businessId: ctx.businessId, serviceIds: args.service_ids });
    } else {
      base = await listProviders(db, ctx.businessId, false);
    }
    const links = await db.serviceProvider.findMany({
      where: { businessId: ctx.businessId, providerId: { in: base.map((p) => p.id) }, service: { active: true } },
      select: { providerId: true, serviceId: true },
    });
    const byProvider = new Map<string, string[]>();
    for (const l of links) byProvider.set(l.providerId, [...(byProvider.get(l.providerId) ?? []), l.serviceId]);
    const providers = base.map((p) => ({ id: p.id, name: p.displayName, service_ids: (byProvider.get(p.id) ?? []).sort() }));
    const scope = args.service_ids ? ' can do that whole visit' : ' take appointments';
    return {
      summary: `${providers.length} stylist${providers.length === 1 ? '' : 's'}${scope}: ${providers.map((p) => p.name).join(', ') || 'none'}.`,
      data: { providers },
    };
  },
});
