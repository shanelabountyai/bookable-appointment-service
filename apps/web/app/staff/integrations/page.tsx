import { requireOwner } from '@/lib/auth/session';
import { listIntegrationKeys } from '@/lib/auth/api-key-actions';
import { ApiKeys } from './api-keys';

export const dynamic = 'force-dynamic';

/**
 * W-001 — /staff/integrations (API PRD §5, §7 "Owner UI").
 *
 * OWNER ONLY, guarded here AND in every action (`requireOwner` redirects a
 * stylist to the day grid). v1 holds the keys; endpoints, the delivery log and
 * replay join this page with the webhook items (W-009, W-011).
 */
export default async function IntegrationsPage() {
  await requireOwner();
  const keys = await listIntegrationKeys();

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
    </main>
  );
}
