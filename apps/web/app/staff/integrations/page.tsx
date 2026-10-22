import { requireOwner } from '@/lib/auth/session';
import { listIntegrationKeys } from '@/lib/auth/api-key-actions';
import { listDeliveries, listEndpoints } from '@/lib/webhooks/actions';
import { ApiKeys } from './api-keys';
import { EVENT_TYPES } from '@/lib/webhooks/event-types';
import { DeliveryLog, WebhookEndpoints } from './webhooks';

export const dynamic = 'force-dynamic';

const STATUSES = ['pending', 'sending', 'succeeded', 'failed', 'dead'] as const;
const select = 'rounded-md border border-zinc-400 bg-transparent px-2 py-1 text-sm dark:border-zinc-600';

/**
 * W-001 / W-011 — /staff/integrations (API PRD §5, §7 "Owner UI").
 *
 * OWNER ONLY, guarded here AND in every action (`requireOwner` redirects a
 * stylist to the day grid). API keys, webhook endpoints, and the delivery log
 * — filtered by a plain GET form, so a filtered view is a link.
 */
export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined);
  const filter = { endpointId: one('endpoint'), status: one('status'), eventType: one('type') };
  const [keys, endpoints, deliveries] = await Promise.all([listIntegrationKeys(), listEndpoints(), listDeliveries(filter)]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <div>
        <h1 className="text-page-title font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Connect another system — a CRM, a spreadsheet, an automation — to the book. It works through
          the same rules as the desk, and everything it does is logged under the key’s name.
        </p>
      </div>
      <ApiKeys keys={keys} />
      <WebhookEndpoints endpoints={endpoints} />

      <section aria-labelledby="deliveries-heading" className="flex flex-col gap-4">
        <h2 id="deliveries-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Delivery log
        </h2>
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            Endpoint
            <select name="endpoint" defaultValue={filter.endpointId ?? ''} className={`${select} max-w-56`}>
              <option value="">All</option>
              {endpoints.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.url}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Status
            <select name="status" defaultValue={filter.status ?? ''} className={select}>
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Event
            <select name="type" defaultValue={filter.eventType ?? ''} className={select}>
              <option value="">All</option>
              {EVENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600">
            Filter
          </button>
        </form>
        <DeliveryLog deliveries={deliveries} />
      </section>
    </main>
  );
}
