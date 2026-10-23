/**
 * W-012 — the OpenAPI document (API PRD §6.9), generated from the SAME zod
 * schemas the handlers validate with (`z.toJSONSchema`, zod 4 — no new
 * dependency). One source: change a schema and the document changes; the
 * committed copy (`docs/api/openapi.json`) is compared by `openapi.test.ts`,
 * which CI runs, so a schema change without a doc change fails the gate.
 * Regenerate with `npm run openapi:write`.
 *
 * Responses are described in prose plus the problem+json envelope: they are
 * TypeScript interfaces, not zod, and a second hand-written schema for them
 * would be a second source that drifts.
 */
import { z } from 'zod';
import { dayQuery, listQuery } from './appointments';
import { availabilityQuery, providersQuery } from './catalog';
import { searchQuery, waitlistQuery } from './clients';
import { eventsQuery } from './events';
import { cancelBody, rescheduleBody, statusBody, waitlistBody } from './moves';
import { PUBLISHED_TYPES } from './webhook-endpoints';
import { bookBody, clientBody } from './writes';

interface Op {
  method: 'get' | 'post';
  path: string;
  summary: string;
  scope: 'read' | 'write';
  query?: z.ZodObject;
  body?: z.ZodType;
  pathParams?: string[];
  ifMatch?: boolean;
}

/** Every `/api/v1` route. `openapi.test.ts` checks this list against the route files on disk. */
export const OPERATIONS: Op[] = [
  { method: 'get', path: '/services', scope: 'read', summary: 'Active services with durations and segments; prices only with the `prices` scope.' },
  { method: 'get', path: '/providers', scope: 'read', summary: 'Stylists and the services each can do; `serviceIds` narrows to those qualified for the whole visit.', query: providersQuery },
  { method: 'get', path: '/availability', scope: 'read', summary: 'Offered start instants for a visit over ≤ 14 days, per stylist or `any`. Never exclusion reasons.', query: availabilityQuery },
  { method: 'get', path: '/days/{day}', scope: 'read', summary: 'One salon day (23/25 h on DST days): every appointment occupying any part of it.', query: dayQuery, pathParams: ['day'] },
  { method: 'get', path: '/appointments', scope: 'read', summary: 'Appointments whose occupied time overlaps [from, to), cursor-paginated.', query: listQuery },
  { method: 'post', path: '/appointments', scope: 'write', summary: 'Book. Requires `Idempotency-Key`.', body: bookBody },
  { method: 'get', path: '/appointments/{id}', scope: 'read', summary: 'One appointment with `allowedActions` and `version` (also sent as ETag).', pathParams: ['id'] },
  { method: 'post', path: '/appointments/{id}/reschedule', scope: 'write', summary: 'Move to another time or stylist (same time + new stylist is a reassignment). Requires `Idempotency-Key`; `If-Match` optional.', body: rescheduleBody, pathParams: ['id'], ifMatch: true },
  { method: 'post', path: '/appointments/{id}/cancel', scope: 'write', summary: 'Cancel; the salon decides on-time vs late. Tells the client unless `tellClient: false`. Requires `Idempotency-Key`.', body: cancelBody, pathParams: ['id'] },
  { method: 'post', path: '/appointments/{id}/status', scope: 'write', summary: 'Check in, start, finish or mark a no-show. Requires `Idempotency-Key`; `If-Match` optional.', body: statusBody, pathParams: ['id'], ifMatch: true },
  { method: 'get', path: '/clients', scope: 'read', summary: 'Up to five matches: name, phone last 4, reliability.', query: searchQuery },
  { method: 'post', path: '/clients', scope: 'write', summary: 'Add a client; a phone already on the book is AMBIGUOUS_CLIENT unless `allowDuplicate`. Requires `Idempotency-Key`.', body: clientBody },
  { method: 'get', path: '/clients/{id}', scope: 'read', summary: 'One client and their visits; full phone and email only with the `contacts` scope; notes never.', pathParams: ['id'] },
  { method: 'get', path: '/waitlist', scope: 'read', summary: 'Active waitlist entries, optionally those covering `day`.', query: waitlistQuery },
  { method: 'post', path: '/waitlist', scope: 'write', summary: 'Add a waitlist entry. Requires `Idempotency-Key`.', body: waitlistBody },
  { method: 'get', path: '/events', scope: 'read', summary: 'Published appointment events after `since` in seq (commit) order — the webhook body shape. The catch-up door.', query: eventsQuery },
];

const NOT_PUBLISHED = [
  'override_booked',
  'services_changed',
  'client_changed',
  'time_released',
  'column_pushed',
  'conflict_acknowledged',
  'hours_changed_underneath',
  'notification_skipped_*',
  'client.created',
  'waitlist.*',
];

const CHANGELOG = ['v1 (2026-10-21): first version.'];

const schemaOf = (s: z.ZodType) => {
  const json = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
};

const problem = { $ref: '#/components/schemas/Problem' };

export function openApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const parameters: Record<string, unknown>[] = (op.pathParams ?? []).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    if (op.query) {
      const shape = schemaOf(op.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(shape.properties ?? {})) {
        parameters.push({ name, in: 'query', required: (shape.required ?? []).includes(name), schema });
      }
    }
    if (op.method === 'post') parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', maxLength: 255 } });
    if (op.ifMatch) parameters.push({ name: 'If-Match', in: 'header', required: false, schema: { type: 'string' } });
    (paths[`/api/v1${op.path}`] ??= {})[op.method] = {
      summary: op.summary,
      security: [{ bearer: [] }],
      'x-scope': op.scope,
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: schemaOf(op.body) } } } } : {}),
      responses: {
        [op.method === 'post' && (op.path === '/appointments' || op.path === '/clients') ? '201' : '200']: { description: 'Success (JSON).' },
        default: { description: 'An error, as RFC 9457 problem+json with `code` and `next`.', content: { 'application/problem+json': { schema: problem } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Bookable API',
      version: 'v1',
      description: [
        'Key-authenticated API over the Bookable salon book, plus signed outbound webhooks.',
        '',
        `**Published webhook / event types:** ${PUBLISHED_TYPES.join(', ')}.`,
        `**Not published in v1 (by decision, OQ-W6):** ${NOT_PUBLISHED.join(', ')}.`,
        '',
        '**Delivery:** at-least-once; dedupe on the event `id`; `seq` is per-business and increasing in commit order, gapless only if you subscribe to every published type. Signature: `Bookable-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, reject |now − t| > 300 s.',
        '',
        '**CHANGELOG** (additive changes are not breaking; breaking changes are a /v2):',
        ...CHANGELOG.map((c) => `- ${c}`),
      ].join('\n'),
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: '`Authorization: Bearer bk_api_…`, issued by the owner on /staff/integrations.' } },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'code'],
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string' },
            next: { type: 'object', properties: { endpoint: { type: 'string' }, why: { type: 'string' } } },
            errors: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
          },
        },
      },
    },
    paths,
  };
}

export const openApiJson = (): string => `${JSON.stringify(openApiDocument(), null, 2)}\n`;
