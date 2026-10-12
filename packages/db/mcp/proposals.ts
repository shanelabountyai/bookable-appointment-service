/**
 * M-009 — proposals (MCP PRD §8).
 *
 * `prepare_*` stores one; `commit_proposal` claims it. The claim is a single
 * conditional UPDATE, so two commits of the same proposal — two tabs, a
 * retrying model — produce exactly one write and one `PROPOSAL_USED`. Why the
 * claim is refused is worked out AFTER it fails, from the row as it is, so the
 * model gets the specific code (§6) rather than "no".
 */
import { createHash } from 'node:crypto';
import { fromDate, instant, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** §8: ten minutes. Long enough to read a sentence, short enough that the world has not moved much. */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

export interface CreateProposalInput {
  businessId: string;
  staffUserId: string;
  tokenId: string;
  action: string;
  args: Prisma.InputJsonValue;
  summary: string;
  now: Date;
}

export interface Proposal {
  id: string;
  businessId: string;
  staffUserId: string;
  tokenId: string;
  action: string;
  args: Prisma.JsonValue;
  argsHash: string;
  summary: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * Key-sorted JSON, so the hash survives the round trip through `jsonb` —
 * Postgres stores objects in its own key order, and a hash of the original
 * insertion order would refuse every proposal it ever stored.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashArgs(args: Prisma.InputJsonValue): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

export async function createProposal(db: Db, input: CreateProposalInput): Promise<Proposal> {
  return db.mcpProposal.create({
    data: {
      businessId: input.businessId,
      staffUserId: input.staffUserId,
      tokenId: input.tokenId,
      action: input.action,
      args: input.args,
      argsHash: hashArgs(input.args),
      summary: input.summary,
      // A PHYSICAL duration from `now`, on the instant axis (never wall-clock arithmetic).
      expiresAt: toDate(instant(fromDate(input.now) + PROPOSAL_TTL_MS)),
      createdAt: input.now,
    },
    select: SELECT,
  });
}

const SELECT = {
  id: true,
  businessId: true,
  staffUserId: true,
  tokenId: true,
  action: true,
  args: true,
  argsHash: true,
  summary: true,
  expiresAt: true,
  usedAt: true,
} as const;

export type ClaimResult =
  | { ok: true; proposal: Proposal }
  /** Unknown id, another business, or another person's proposal — one answer for all three (§6.3). */
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'used'; usedAt: Date }
  | { ok: false; reason: 'expired'; expiresAt: Date };

/**
 * Claims the proposal for `staffUserId` at `now`. Succeeds at most once per row.
 * Also refuses a proposal whose stored args no longer hash to `argsHash` —
 * which cannot happen through this code, and is checked anyway because it is
 * the whole guarantee (§8: "byte-for-byte what was previewed").
 */
export async function claimProposal(
  db: Db,
  args: { id: string; businessId: string; staffUserId: string; now: Date },
): Promise<ClaimResult> {
  const { count } = await db.mcpProposal.updateMany({
    where: { id: args.id, businessId: args.businessId, staffUserId: args.staffUserId, usedAt: null, expiresAt: { gt: args.now } },
    data: { usedAt: args.now },
  });
  if (count === 1) {
    const proposal = await db.mcpProposal.findUniqueOrThrow({ where: { id: args.id }, select: SELECT });
    if (hashArgs(proposal.args as Prisma.InputJsonValue) !== proposal.argsHash) {
      throw new Error(`McpProposal ${proposal.id}: stored args do not match their hash.`);
    }
    return { ok: true, proposal };
  }
  const row = await db.mcpProposal.findFirst({
    where: { id: args.id, businessId: args.businessId, staffUserId: args.staffUserId },
    select: { usedAt: true, expiresAt: true },
  });
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.usedAt) return { ok: false, reason: 'used', usedAt: row.usedAt };
  return { ok: false, reason: 'expired', expiresAt: row.expiresAt };
}

/** What the commit did, kept on the row for the audit trail. */
export async function recordOutcome(db: Db, id: string, outcome: Prisma.InputJsonValue): Promise<void> {
  await db.mcpProposal.update({ where: { id }, data: { outcome } });
}
