/**
 * M-002 — MCP bearer tokens (MCP PRD §5).
 *
 * One token = one named, active staff member. The token is shown once and the
 * database holds its SHA-256 (same pattern as the manage link, D-5). Resolution
 * requires the token to be unrevoked AND its person to be active, so taking
 * somebody off the roster revokes every token they hold on the next call —
 * exactly what `findStaffById` already does for a signed-in session.
 *
 * `now` is injected everywhere: a token's last-used time and its revocation
 * are physical moments, and a test that reads the clock is wrong even when it
 * passes.
 */
import { randomBytes } from 'node:crypto';
import { hashManageToken } from '../../core/auth';
import type { Prisma, PrismaClient, StaffRole } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** Recognisable in a log or a scanner, like `ghp_` and `sk_`. 256 random bits after it. */
const TOKEN_PREFIX = 'bk_mcp_';

export class McpTokenRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpTokenRejected';
  }
}

export interface IssueMcpTokenInput {
  businessId: string;
  /** Whose token this is. Must be an ACTIVE member of `businessId`. */
  staffUserId: string;
  /** The owner issuing it. */
  issuedById: string;
  label: string;
  now: Date;
}

export interface IssuedMcpToken {
  id: string;
  /** Shown ONCE. Never stored, never logged. */
  token: string;
}

export async function issueMcpToken(db: Db, input: IssueMcpTokenInput): Promise<IssuedMcpToken> {
  const label = input.label.trim();
  if (!label) throw new McpTokenRejected('Give the token a label — it is the name revocation will use.');

  // Scoped to the business: an id from another salon is "nobody", never a hint.
  const person = await db.staffUser.findFirst({
    where: { id: input.staffUserId, businessId: input.businessId },
    select: { active: true },
  });
  if (!person) throw new McpTokenRejected('That person is not on this roster.');
  if (!person.active) throw new McpTokenRejected('That person is off the roster. Put them back on before issuing a token.');

  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const row = await db.mcpToken.create({
    data: {
      businessId: input.businessId,
      staffUserId: input.staffUserId,
      issuedById: input.issuedById,
      label,
      tokenHash: hashManageToken(token),
      createdAt: input.now,
    },
    select: { id: true },
  });
  return { id: row.id, token };
}

/** Idempotent: revoking a revoked token keeps the FIRST revocation time. Returns false when the id is not this business's. */
export async function revokeMcpToken(db: Db, args: { businessId: string; id: string; now: Date }): Promise<boolean> {
  const { count } = await db.mcpToken.updateMany({
    where: { id: args.id, businessId: args.businessId, revokedAt: null },
    data: { revokedAt: args.now },
  });
  if (count > 0) return true;
  return (await db.mcpToken.count({ where: { id: args.id, businessId: args.businessId } })) > 0;
}

export interface McpTokenRow {
  id: string;
  staffUserId: string;
  staffName: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listMcpTokens(db: Db, businessId: string): Promise<McpTokenRow[]> {
  const rows = await db.mcpToken.findMany({
    where: { businessId },
    orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      staffUserId: true,
      label: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      staffUser: { select: { name: true } },
    },
  });
  return rows.map(({ staffUser, ...r }) => ({ ...r, staffName: staffUser.name }));
}

/** What a resolved token grants. The business comes from HERE, never from a tool argument (PRD §5). */
export interface McpGrant {
  tokenId: string;
  businessId: string;
  staffUserId: string;
  staffName: string;
  role: StaffRole;
}

/**
 * Token → grant, or null for unknown, revoked, or belonging to somebody no
 * longer active. Touches `lastUsedAt` on success so the owner's list shows
 * which tokens are live. One indexed lookup; no timing-oracle concern, because
 * the hash is of a 256-bit random value, not of something guessable.
 */
export async function resolveMcpToken(db: Db, token: string, now: Date): Promise<McpGrant | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await db.mcpToken.findUnique({
    where: { tokenHash: hashManageToken(token) },
    select: {
      id: true,
      businessId: true,
      revokedAt: true,
      staffUser: { select: { id: true, name: true, role: true, active: true } },
    },
  });
  if (!row || row.revokedAt || !row.staffUser.active) return null;
  await db.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  return {
    tokenId: row.id,
    businessId: row.businessId,
    staffUserId: row.staffUser.id,
    staffName: row.staffUser.name,
    role: row.staffUser.role,
  };
}
