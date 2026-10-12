'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bookable/db';
import { McpTokenRejected, issueMcpToken, listMcpTokens, revokeMcpToken } from '@bookable/db/mcp';
import { readableInstant } from '../customer-format';
import { requireOwner, requireStaff } from './session';

export interface McpTokenState {
  ok?: boolean;
  message?: string;
  /** Present exactly once, on the response to the issue that minted it. */
  token?: string;
}

export interface AiAccessRow {
  id: string;
  staffName: string;
  label: string;
  /** Already worded in the SALON's zone — a client component formatting a Date would use the browser's. */
  lastUsed: string | null;
  revoked: boolean;
}

/** Owner only (D-36: the owner hands out credentials). Everybody else gets `null` and no section. */
export async function listAiAccess(): Promise<AiAccessRow[] | null> {
  const staff = await requireStaff();
  if (staff.role !== 'owner') return null;
  const [rows, business] = await Promise.all([
    listMcpTokens(prisma, staff.businessId),
    prisma.business.findUniqueOrThrow({ where: { id: staff.businessId }, select: { timezone: true } }),
  ]);
  return rows.map((r) => ({
    id: r.id,
    staffName: r.staffName,
    label: r.label,
    lastUsed: r.lastUsedAt ? readableInstant(r.lastUsedAt, business.timezone) : null,
    revoked: r.revokedAt !== null,
  }));
}

export async function issueAiAccess(_prev: McpTokenState, formData: FormData): Promise<McpTokenState> {
  const owner = await requireOwner();
  try {
    const issued = await issueMcpToken(prisma, {
      businessId: owner.businessId,
      staffUserId: String(formData.get('staffUserId') ?? ''),
      issuedById: owner.id,
      label: String(formData.get('label') ?? ''),
      now: new Date(),
    });
    revalidatePath('/staff/people');
    return { ok: true, token: issued.token, message: 'Copy this now — it is shown once.' };
  } catch (error) {
    if (error instanceof McpTokenRejected) return { ok: false, message: error.message };
    throw error;
  }
}

export async function revokeAiAccess(_prev: McpTokenState, formData: FormData): Promise<McpTokenState> {
  const owner = await requireOwner();
  const found = await revokeMcpToken(prisma, {
    businessId: owner.businessId,
    id: String(formData.get('id') ?? ''),
    now: new Date(),
  });
  revalidatePath('/staff/people');
  return found ? { ok: true, message: 'Revoked.' } : { ok: false, message: 'That token is not one of yours.' };
}
