/**
 * Ids come from tools, never from the model's head (PRD §6.3). Every id
 * argument is checked against THIS business before anything else happens, and
 * an unknown or cross-business id is `NOT_FOUND` — never a hint that it exists
 * elsewhere. Inactive rows are "not found" too: `list_*` never handed them out.
 */
import type { PrismaClient } from '@bookable/db';
import { findClient, type ClientSummary } from '@bookable/db/clients';
import { invalidArgument, notFound } from '../errors';

export interface ServiceRef {
  id: string;
  name: string;
  durationMinutes: number;
}

export async function servicesOf(db: PrismaClient, businessId: string, ids: readonly string[]): Promise<ServiceRef[]> {
  if (new Set(ids).size !== ids.length) throw invalidArgument('service_ids', 'The same service is listed twice.');
  const rows = await db.service.findMany({
    where: { businessId, active: true, id: { in: [...ids] } },
    select: { id: true, name: true, durationMinutes: true },
  });
  if (rows.length !== ids.length) throw notFound('service', 'service_ids', 'list_services');
  // Keep the caller's order: it is the visit order (D-23), and buffers come from the ends.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!);
}

export interface ProviderRef {
  id: string;
  displayName: string;
}

export async function providerOf(db: PrismaClient, businessId: string, id: string): Promise<ProviderRef> {
  const row = await db.provider.findFirst({ where: { id, businessId, active: true }, select: { id: true, displayName: true } });
  if (!row) throw notFound('stylist', 'provider_id', 'list_providers');
  return row;
}

export async function clientOf(db: PrismaClient, businessId: string, id: string): Promise<ClientSummary> {
  const row = await findClient(db, businessId, id);
  if (!row) throw notFound('client', 'client_id', 'find_client');
  return row;
}
