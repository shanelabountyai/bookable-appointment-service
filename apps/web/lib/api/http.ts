/**
 * W-002 — the one shape every /api/v1 route is written in (API PRD §5, §6).
 *
 * In order, on EVERY request: the key (401), the scope (403), the per-key
 * rate limit (429 + Retry-After), then the handler; any thrown value goes
 * through `toProblem` once, here. Handlers receive `deps.now()` instead of the
 * clock — the rule the engine follows, one layer out — and tests freeze it.
 *
 * A route file is two lines: `export const GET = route(spec, handler)`.
 */
import type { PrismaClient } from '@bookable/db';
import type { ApiScope } from '@bookable/db/api';
import { consumeRateLimit } from '@bookable/db/rate-limit';
import type { z } from 'zod';
import { type ApiCaller, resolveCaller } from './auth';
import { fail, problem, problemResponse, toProblem } from './problem';

export interface ApiDeps {
  prisma: PrismaClient;
  now: () => Date;
}

/** §5: 120 reads and 20 writes per key per minute. A fixed window (rate-limit.ts's ceiling applies). */
export const RATE = { read: 120, write: 20, windowMs: 60_000 } as const;

export interface RequestContext {
  caller: ApiCaller;
  request: Request;
  url: URL;
  params: Record<string, string>;
  deps: ApiDeps;
  now: Date;
}

export interface RouteSpec {
  /** `read` for a GET, `write` for anything that changes the book (§5). */
  scope: Extract<ApiScope, 'read' | 'write'>;
}

export type Handler = (ctx: RequestContext) => Promise<Response>;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    // §6.7: reads say they are safe to retry by never being cached anywhere.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function hasScope(caller: ApiCaller, scope: ApiScope): boolean {
  return caller.scopes.includes(scope);
}

/** Runs one request through auth → scope → rate limit → handler → error mapping. */
export async function handle(
  spec: RouteSpec,
  handler: Handler,
  request: Request,
  params: Record<string, string>,
  deps: ApiDeps,
): Promise<Response> {
  const now = deps.now();
  const caller = await resolveCaller(deps.prisma, request, now);
  if (!caller) {
    return problemResponse(
      problem('UNAUTHENTICATED', 'Send an API key as "Authorization: Bearer bk_api_…". An owner issues one on /staff/integrations.', {
        next: { endpoint: '/staff/integrations', why: 'ask the salon owner for a key' },
      }),
      { 'WWW-Authenticate': 'Bearer realm="bookable-api"' },
    );
  }
  if (!hasScope(caller, spec.scope)) {
    return problemResponse(
      problem('FORBIDDEN_SCOPE', `This key does not have the "${spec.scope}" scope.`, {
        errors: [{ field: 'scope', message: `requires ${spec.scope}` }],
        next: { endpoint: '/staff/integrations', why: `ask the owner for a key with the ${spec.scope} scope` },
      }),
    );
  }
  const allowed = await consumeRateLimit(deps.prisma, {
    key: `api:${spec.scope}:${caller.keyId}`,
    limit: RATE[spec.scope],
    windowMs: RATE.windowMs,
    now,
  });
  if (!allowed) {
    const seconds = RATE.windowMs / 1000;
    return problemResponse(problem('RATE_LIMITED', `Too many ${spec.scope} requests for this key. Wait ${seconds} seconds.`), {
      'Retry-After': String(seconds),
    });
  }

  try {
    return await handler({ caller, request, url: new URL(request.url), params, deps, now });
  } catch (error) {
    const mapped = toProblem(error);
    if (mapped) return problemResponse(mapped.problem, mapped.headers);
    throw error;
  }
}

/**
 * Next route adapter. Route files stay two lines:
 *   export const GET = (r: Request, c: Ctx) => api({ scope: 'read' }, getServices, r, c);
 * The database client is imported lazily so a unit test can import a handler
 * module without constructing the app's global client.
 */
export async function api(
  spec: RouteSpec,
  handler: Handler,
  request: Request,
  context: { params: Promise<Record<string, string>> } | undefined,
): Promise<Response> {
  const { prisma } = await import('@bookable/db');
  return handle(spec, handler, request, (await context?.params) ?? {}, { prisma, now: () => new Date() });
}

/** zod issues → §6.5's `errors[]`, field paths dotted. */
function issuesOf(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join('.') || '(body)', message: i.message }));
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown, where: 'query' | 'body'): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw fail('VALIDATION', `The ${where} did not validate: ${issuesOf(result.error).map((e) => `${e.field} ${e.message}`).join('; ')}.`, {
      errors: issuesOf(result.error),
    });
  }
  return result.data;
}

/** Query string → plain object; a key given twice keeps the last value. Comma lists are split by the schema. */
export function queryOf(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

/** The JSON body, or VALIDATION naming the body — a malformed body is the caller's to fix. */
export async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw fail('VALIDATION', 'The body is not valid JSON.', { errors: [{ field: '(body)', message: 'not JSON' }] });
  }
}
