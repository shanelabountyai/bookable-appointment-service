/**
 * Ids come from responses, never from a caller's head (API PRD §6.3). Every id
 * is checked against THIS key's business before anything else happens, and an
 * unknown or cross-business id is `NOT_FOUND` — never a hint it exists
 * elsewhere (§5). Inactive rows read as not found too: no list handed them out.
 */
import type { PrismaClient } from '@bookable/db';
import { findClient, type ClientSummary } from '@bookable/db/clients';
import { fail, notFound } from './problem';

export async function servicesOf(db: PrismaClient, businessId: string, ids: readonly string[]) {
  if (new Set(ids).size !== ids.length) throw fail('VALIDATION', 'The same service is listed twice.', { errors: [{ field: 'serviceIds', message: 'duplicate id' }] });
  const rows = await db.service.findMany({
    where: { businessId, active: true, id: { in: [...ids] } },
    select: { id: true, name: true, durationMinutes: true },
  });
  if (rows.length !== ids.length) throw notFound('service', 'serviceIds', 'GET /v1/services');
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!);
}

export async function providerOf(db: PrismaClient, businessId: string, id: string) {
  const row = await db.provider.findFirst({ where: { id, businessId, active: true }, select: { id: true, displayName: true } });
  if (!row) throw notFound('provider', 'providerId', 'GET /v1/providers');
  return row;
}

export async function clientOf(db: PrismaClient, businessId: string, id: string): Promise<ClientSummary> {
  const row = await findClient(db, businessId, id);
  if (!row) throw notFound('client', 'clientId', 'GET /v1/clients');
  return row;
}
