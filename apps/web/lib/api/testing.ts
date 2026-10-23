/**
 * Test harness for /api/v1 handlers: real database, real keys, real
 * `Request`s through the same `handle()` a route uses — so auth, scopes, the
 * rate limit and the error mapping are exercised on every call, never
 * bypassed by calling a handler directly.
 *
 * Two salons (the MCP track's `seedTwoSalons`), so every test can assert
 * tenancy rather than assume it (PRD §9.1).
 */
import type { PrismaClient } from '@bookable/db';
import { issueApiKey } from '@bookable/db/api';
import { seedTwoSalons, type Salon } from '../../../mcp/src/testing/two-salons';
import { type ApiDeps, type Handler, type RouteSpec, handle } from './http';

export { seedTwoSalons, type Salon };

export interface Caller {
  key: string;
  keyId: string;
  call: (spec: RouteSpec, handler: Handler, init: CallInit) => Promise<{ status: number; headers: Headers; body: Record<string, unknown>; text: string }>;
}

export interface CallInit {
  method?: string;
  path: string;
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function keyFor(
  prisma: PrismaClient,
  salon: Salon,
  scopes: string[],
  deps: ApiDeps,
  label = 'test sync',
): Promise<Caller> {
  const { key, id } = await issueApiKey(prisma, { businessId: salon.businessId, issuedById: salon.ownerId, label, scopes, now: deps.now() });
  return { key, keyId: id, call: (spec, handler, init) => callWith(key, spec, handler, init, deps) };
}

export async function callWith(key: string | null, spec: RouteSpec, handler: Handler, init: CallInit, deps: ApiDeps) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://localhost${init.path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
  });
  const res = await handle(spec, handler, request, init.params ?? {}, deps);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text };
}
