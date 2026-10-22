'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { API_SCOPES, ApiKeyRejected, issueApiKey, listApiKeys, revokeApiKey } from '@bookable/db/api';
import { readableInstant } from '../customer-format';
import { requireOwner } from './session';

/**
 * W-001 — the owner's API keys (API PRD §5), on /staff/integrations.
 *
 * Owner only, at EVERY entry point (`requireOwner`), not merely in what the
 * page draws: hiding a link hides nothing (D-36). The minted key appears once,
 * in the response to the issue that made it, and never again.
 */

export interface ApiKeyState {
  ok?: boolean;
  message?: string;
  /** Present exactly once, on the response to the issue that minted it. */
  key?: string;
}

export interface IntegrationKeyRow {
  id: string;
  label: string;
  scopes: string[];
  issuedBy: string;
  /** Already worded in the SALON's zone — a client component formatting a Date would use the browser's. */
  lastUsed: string | null;
  revoked: boolean;
}

export async function listIntegrationKeys(): Promise<IntegrationKeyRow[]> {
  const owner = await requireOwner();
  const [rows, business] = await Promise.all([
    listApiKeys(prisma, owner.businessId),
    prisma.business.findUniqueOrThrow({ where: { id: owner.businessId }, select: { timezone: true } }),
  ]);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    scopes: r.scopes,
    issuedBy: r.issuedByName,
    lastUsed: r.lastUsedAt ? readableInstant(r.lastUsedAt, business.timezone) : null,
    revoked: r.revokedAt !== null,
  }));
}

export async function issueIntegrationKey(_prev: ApiKeyState, formData: FormData): Promise<ApiKeyState> {
  const owner = await requireOwner();
  const scopes = formData.getAll('scope').map(String).filter((s) => (API_SCOPES as readonly string[]).includes(s));
  try {
    const issued = await issueApiKey(prisma, {
      businessId: owner.businessId,
      issuedById: owner.id,
      label: String(formData.get('label') ?? ''),
      scopes,
      now: new Date(),
    });
    revalidatePath('/staff/integrations');
    return { ok: true, key: issued.key, message: 'Copy this now — it is shown once.' };
  } catch (error) {
    if (error instanceof ApiKeyRejected) return { ok: false, message: error.message };
    throw error;
  }
}

export async function revokeIntegrationKey(_prev: ApiKeyState, formData: FormData): Promise<ApiKeyState> {
  const owner = await requireOwner();
  const found = await revokeApiKey(prisma, {
    businessId: owner.businessId,
    id: String(formData.get('id') ?? ''),
    now: new Date(),
  });
  revalidatePath('/staff/integrations');
  return found ? { ok: true, message: 'Revoked.' } : { ok: false, message: 'That key is not one of yours.' };
}
