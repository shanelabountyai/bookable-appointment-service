/**
 * W-001 — API keys (API PRD §5).
 *
 * One key = one INTEGRATION ("HubSpot sync"), issued by an owner, carrying a
 * set of scopes. Shown once; the database holds its SHA-256 (the manage-link
 * and MCP-token pattern, D-5). Unlike an MCP token, a key is not a person:
 * deactivating the owner who issued it does not revoke it, and revoking it
 * touches nothing else.
 *
 * Resolution happens on EVERY request (`resolveApiKey`): unknown, revoked or
 * malformed → null. The business comes from here and from nowhere else — no
 * endpoint takes a `businessId`.
 *
 * `now` is injected everywhere, as in `mcp/tokens.ts`.
 */
import { randomBytes } from 'node:crypto';
import { hashManageToken } from '../../core/auth';
import type { ApiScope, Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** Recognisable in a log or a secret scanner. 256 random bits after it. */
export const API_KEY_PREFIX = 'bk_api_';

export type { ApiScope };

/** Every scope, in the order the owner page lists them. */
export const API_SCOPES = ['read', 'write', 'prices', 'contacts'] as const satisfies readonly ApiScope[];

export class ApiKeyRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyRejected';
  }
}

export interface IssueApiKeyInput {
  businessId: string;
  /** The owner issuing it. Must be an ACTIVE OWNER of `businessId`. */
  issuedById: string;
  label: string;
  scopes: readonly string[];
  now: Date;
}

export interface IssuedApiKey {
  id: string;
  /** Shown ONCE. Never stored, never logged. */
  key: string;
}

export async function issueApiKey(db: Db, input: IssueApiKeyInput): Promise<IssuedApiKey> {
  const label = input.label.trim();
  if (!label) throw new ApiKeyRejected('Give the key a label — it is the name the audit line and revocation use.');
  if (label.length > 80) throw new ApiKeyRejected('Keep the label under 80 characters.');

  const scopes = [...new Set(input.scopes)];
  const unknown = scopes.filter((s) => !(API_SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new ApiKeyRejected(`Unknown scope: ${unknown.join(', ')}.`);
  if (scopes.length === 0) throw new ApiKeyRejected('Pick at least one scope — a key with none can do nothing.');
  // `prices` and `contacts` widen what a READ returns; on their own they grant nothing.
  if (!scopes.includes('read') && !scopes.includes('write')) {
    throw new ApiKeyRejected('A key needs read or write — prices and contacts only widen what a read returns.');
  }

  // Scoped to the business, and owners only (D-36: the owner hands out credentials).
  const issuer = await db.staffUser.findFirst({
    where: { id: input.issuedById, businessId: input.businessId },
    select: { active: true, role: true },
  });
  if (!issuer || !issuer.active || issuer.role !== 'owner') throw new ApiKeyRejected('Only an owner of this salon can issue an API key.');

  const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  const row = await db.apiKey.create({
    data: {
      businessId: input.businessId,
      issuedById: input.issuedById,
      label,
      scopes: API_SCOPES.filter((s) => scopes.includes(s)),
      keyHash: hashManageToken(key),
      createdAt: input.now,
    },
    select: { id: true },
  });
  return { id: row.id, key };
}

/** Idempotent: revoking a revoked key keeps the FIRST revocation time. False when the id is not this business's. */
export async function revokeApiKey(db: Db, args: { businessId: string; id: string; now: Date }): Promise<boolean> {
  const { count } = await db.apiKey.updateMany({
    where: { id: args.id, businessId: args.businessId, revokedAt: null },
    data: { revokedAt: args.now },
  });
  if (count > 0) return true;
  return (await db.apiKey.count({ where: { id: args.id, businessId: args.businessId } })) > 0;
}

export interface ApiKeyRow {
  id: string;
  label: string;
  scopes: ApiScope[];
  issuedByName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listApiKeys(db: Db, businessId: string): Promise<ApiKeyRow[]> {
  const rows = await db.apiKey.findMany({
    where: { businessId },
    // Live keys first. Explicit, because Postgres puts NULLs LAST in an ascending sort.
    orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
    select: {
      id: true,
      label: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      issuedBy: { select: { name: true } },
    },
  });
  return rows.map(({ issuedBy, ...r }) => ({ ...r, issuedByName: issuedBy.name }));
}

/** What a resolved key grants. The business comes from HERE, never from a request parameter (§5). */
export interface ApiGrant {
  keyId: string;
  businessId: string;
  label: string;
  scopes: ApiScope[];
}

/**
 * Bearer → grant, or null for malformed, unknown or revoked. Touches
 * `lastUsedAt` on success so the owner's list shows which keys are live.
 * No timing-oracle concern: the hash is of a 256-bit random value.
 */
export async function resolveApiKey(db: Db, key: string, now: Date): Promise<ApiGrant | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const row = await db.apiKey.findUnique({
    where: { keyHash: hashManageToken(key) },
    select: { id: true, businessId: true, label: true, scopes: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return null;
  await db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  return { keyId: row.id, businessId: row.businessId, label: row.label, scopes: row.scopes };
}

/**
 * Labels for the keys named by a batch of `actorRef`s — for the audit line
 * ("Booked via API (HubSpot sync)"). ONE query; revoked keys included, because
 * the history must still say who did it after the key is gone.
 */
export async function apiKeyLabels(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.apiKey.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, label: true } });
  return new Map(rows.map((r) => [r.id, r.label]));
}
