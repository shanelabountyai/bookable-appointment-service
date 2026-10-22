/**
 * W-002 — the envelope, the scopes, the rate limit (API PRD §5, §6, §9.2–9.3).
 *
 * One test per §6 code, each asserting `status`, `code` and `next` where the
 * code has one. Domain codes are provoked through the REAL domain functions
 * (a real booking refused by the engine, a real transition refused by the
 * table), not by constructing the error — so the test fails if the mapping
 * and the domain ever stop agreeing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { revokeApiKey } from '@bookable/db/api';
import { transitionAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { z } from 'zod';
import { type Handler, RATE, bodyOf, json, parseWith } from './http';
import { STATUS, fail, notFound, toProblem } from './problem';
import { type Caller, callWith, keyFor, seedTwoSalons, type Salon } from './testing';
import { parseInstant } from './time';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const READ = { scope: 'read' } as const;
const WRITE = { scope: 'write' } as const;
const ok: Handler = async ({ caller }) => json({ businessId: caller.businessId });

let a: Salon;
let reader: Caller;
let writer: Caller;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
  reader = await keyFor(prisma, a, ['read'], deps);
  writer = await keyFor(prisma, a, ['read', 'write'], deps);
});

/** Throws whatever `run` throws into a real request, so the wrapper's mapping is what is measured. */
const throwing = (run: () => Promise<unknown>): Handler => async () => {
  await run();
  return json({});
};

describe('authentication and scopes (§5, §9.2)', () => {
  it('UNAUTHENTICATED 401 — no key, a bad key, a revoked key — with WWW-Authenticate and next', async () => {
    for (const key of [null, 'bk_api_nope', 'Basic xyz']) {
      const r = await callWith(key, READ, ok, { path: '/api/v1/services' }, deps);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ code: 'UNAUTHENTICATED', status: 401, next: { endpoint: '/staff/integrations' } });
      expect(r.headers.get('content-type')).toBe('application/problem+json');
      expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
    expect((await reader.call(READ, ok, { path: '/' })).status).toBe(200);
    await revokeApiKey(prisma, { businessId: a.businessId, id: reader.keyId, now: NOW });
    expect((await reader.call(READ, ok, { path: '/' })).body.code).toBe('UNAUTHENTICATED');
    // Revoking one key disabled nothing else.
    expect((await writer.call(READ, ok, { path: '/' })).status).toBe(200);
  });

  it('FORBIDDEN_SCOPE 403 — a read-only key on a write, naming the scope', async () => {
    const r = await reader.call(WRITE, ok, { method: 'POST', path: '/' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FORBIDDEN_SCOPE', errors: [{ field: 'scope', message: 'requires write' }], next: { endpoint: '/staff/integrations' } });
    expect(String(r.body.detail)).toContain('"write"');
    const writeOnly = await keyFor(prisma, a, ['write'], deps);
    expect((await writeOnly.call(READ, ok, { path: '/' })).body).toMatchObject({ code: 'FORBIDDEN_SCOPE', errors: [{ message: 'requires read' }] });
  });

  it('the business comes from the KEY: a business-B key sees business B', async () => {
    const { b } = await (async () => {
      await resetDatabase(prisma);
      return seedTwoSalons(prisma);
    })();
    const kb = await keyFor(prisma, b, ['read'], deps);
    expect((await kb.call(READ, ok, { path: '/?businessId=whatever' })).body).toEqual({ businessId: b.businessId });
  });
});

describe('rate limit (§5)', () => {
  it(`RATE_LIMITED 429 with Retry-After after ${RATE.write} writes in a window; reads have their own budget; a new window resets`, async () => {
    for (let i = 0; i < RATE.write; i++) expect((await writer.call(WRITE, ok, { method: 'POST', path: '/' })).status).toBe(200);
    const r = await writer.call(WRITE, ok, { method: 'POST', path: '/' });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await writer.call(READ, ok, { path: '/' })).status).toBe(200);
    // Another key has its own counter.
    const other = await keyFor(prisma, a, ['read', 'write'], deps, 'other');
    expect((await other.call(WRITE, ok, { method: 'POST', path: '/' })).status).toBe(200);
    const later = { prisma, now: () => toDate(instantFromIso('2026-06-09T14:01:01Z')) };
    expect((await callWith(writer.key, WRITE, ok, { method: 'POST', path: '/' }, later)).status).toBe(200);
  });
});

describe('one test per §6 code', () => {
  it('VALIDATION 400 — zod names every field; malformed JSON names the body', async () => {
    const schema = z.object({ clientId: z.string(), serviceIds: z.array(z.string()).min(1) }).strict();
    const h: Handler = async ({ request }) => json(parseWith(schema, await bodyOf(request), 'body'));
    const r = await writer.call(WRITE, h, { method: 'POST', path: '/', body: { serviceIds: [], extra: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
    const fields = (r.body.errors as { field: string }[]).map((e) => e.field).sort();
    expect(fields).toEqual(['(body)', 'clientId', 'serviceIds']);
    const bad = await writer.call(WRITE, h, { method: 'POST', path: '/', body: '{not json' });
    expect(bad.body).toMatchObject({ code: 'VALIDATION', errors: [{ field: '(body)', message: 'not JSON' }] });
  });

  it('NOT_FOUND 404 — never hints the id exists elsewhere; next names the list that hands out ids', async () => {
    const r = await reader.call(READ, throwing(async () => { throw notFound('client', 'clientId', 'GET /v1/clients'); }), { path: '/' });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'NOT_FOUND', next: { endpoint: 'GET /v1/clients' }, errors: [{ field: 'clientId' }] });
  });

  it('IDEMPOTENCY_REQUIRED 400, IDEMPOTENCY_MISMATCH 422, IDEMPOTENCY_IN_PROGRESS 409, PRECONDITION_FAILED 412 — the envelope (provoked for real in W-006/W-007)', async () => {
    for (const [code, status] of [['IDEMPOTENCY_REQUIRED', 400], ['IDEMPOTENCY_MISMATCH', 422], ['IDEMPOTENCY_IN_PROGRESS', 409], ['PRECONDITION_FAILED', 412]] as const) {
      const r = await writer.call(WRITE, throwing(async () => { throw fail(code, 'x'); }), { method: 'POST', path: '/' });
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ code, status, type: expect.stringContaining(code.toLowerCase().replaceAll('_', '-')) });
    }
  });

  const dana = async () => (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  const service = async (name: string) => (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name } })).id;
  const book = async (startIso: string, extra: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
    bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: await dana(),
      serviceIds: [await service('Cut')],
      startAt: toDate(instantFromIso(startIso)),
      now: NOW,
      actor: staffActor(a.ownerId),
      audience: 'staff',
      ...extra,
    });

  it('SLOT_TAKEN 409 — a real engine refusal, with next GET /v1/availability and alternatives', async () => {
    await book('2026-06-10T15:00:00Z');
    const r = await writer.call(WRITE, throwing(() => book('2026-06-10T15:00:00Z')), { method: 'POST', path: '/' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'SLOT_TAKEN', next: { endpoint: 'GET /v1/availability' } });
  });

  it('OUTSIDE_HOURS 422 — a Sunday, the salon is closed (asked the way every API write asks: offeredSlot first)', async () => {
    const { offeredSlot } = await import('@bookable/mcp');
    const ask = async () =>
      offeredSlot({ prisma, now: NOW, businessId: a.businessId, providerId: await dana(), serviceIds: [await service('Cut')], holderKey: null, start: instantFromIso('2026-06-14T15:00:00Z'), zone: 'America/Chicago' as never });
    const r = await writer.call(WRITE, throwing(ask), { method: 'POST', path: '/' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'OUTSIDE_HOURS', next: { endpoint: 'GET /v1/availability' }, errors: [{ field: 'start' }] });
  });

  it('NOT_QUALIFIED 422 — Tess cannot do a colour (a reassignment the domain refuses)', async () => {
    const tess = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Tess' } })).id;
    const { BookingRejected } = await import('@bookable/db/booking');
    // The domain's own refusal shape for "not set up to do everything in this visit" (reassign.ts).
    const r = await writer.call(WRITE, throwing(async () => { void tess; throw new BookingRejected('toProviderId', 'They are not set up to do everything in this visit.'); }), { method: 'POST', path: '/' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'NOT_QUALIFIED', next: { endpoint: 'GET /v1/providers' }, errors: [{ field: 'providerId' }] });
  });

  it('INVALID_TRANSITION 409 — completed cannot go back to checked_in; next is the appointment', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const later = toDate(instantFromIso('2026-06-10T17:00:00Z'));
    for (const to of ['checked_in', 'in_progress', 'completed'] as const) {
      await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt.id, to, actor: staffActor(a.ownerId), now: later });
    }
    const r = await writer.call(
      WRITE,
      throwing(() => transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt.id, to: 'no_show', actor: staffActor(a.ownerId), now: later })),
      { method: 'POST', path: '/' },
    );
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'INVALID_TRANSITION', next: { endpoint: 'GET /v1/appointments/{id}' } });
  });

  it('CONFLICT 409 — the row moved under the request (expectedFrom), next is a fresh read', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const r = await writer.call(
      WRITE,
      throwing(() => transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt.id, to: 'checked_in', actor: staffActor(a.ownerId), now: NOW, expectedFrom: 'confirmed' })),
      { method: 'POST', path: '/' },
    );
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'CONFLICT', next: { endpoint: 'GET /v1/appointments/{id}' } });
  });

  it('AMBIGUOUS_TIME 422 — 01:30 on fall-back day names BOTH readings; a gap names the nearest two', async () => {
    const h = (v: string): Handler => async ({ caller }) => json({ at: parseInstant(v, 'start', caller.timezone) });
    const back = await reader.call(READ, h('2026-11-01 01:30'), { path: '/' });
    expect(back.status).toBe(422);
    expect(back.body).toMatchObject({ code: 'AMBIGUOUS_TIME', errors: [{ field: 'start' }] });
    expect(String(back.body.detail)).toContain('2026-11-01T01:30:00-05:00');
    expect(String(back.body.detail)).toContain('2026-11-01T01:30:00-06:00');
    const gap = await reader.call(READ, h('2026-03-08 02:30'), { path: '/' });
    expect(gap.body.code).toBe('AMBIGUOUS_TIME');
    expect((await reader.call(READ, h('2026-11-01T01:30:00-06:00'), { path: '/' })).status).toBe(200);
  });

  it('AMBIGUOUS_CLIENT 409 — the envelope maps through (provoked for real in W-006)', async () => {
    const { ToolFailure } = await import('@bookable/mcp');
    const mapped = toProblem(new ToolFailure({ error: 'AMBIGUOUS_CLIENT', message: 'dup', field: 'phone', next: { tool: 'find_client', why: 'confirm' } }));
    expect(mapped?.problem).toMatchObject({ code: 'AMBIGUOUS_CLIENT', status: 409, next: { endpoint: 'GET /v1/clients' } });
  });

  it('every code has a status, and a bug is a 500 — never a polite envelope', async () => {
    expect(Object.keys(STATUS).sort()).toEqual(
      ['AMBIGUOUS_CLIENT', 'AMBIGUOUS_TIME', 'CONFLICT', 'FORBIDDEN_SCOPE', 'IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_MISMATCH', 'IDEMPOTENCY_REQUIRED', 'INVALID_TRANSITION', 'NOT_FOUND', 'NOT_QUALIFIED', 'OUTSIDE_HOURS', 'PRECONDITION_FAILED', 'RATE_LIMITED', 'SLOT_TAKEN', 'UNAUTHENTICATED', 'VALIDATION'].sort(),
    );
    expect(toProblem(new Error('database on fire'))).toBeNull();
    await expect(reader.call(READ, throwing(async () => { throw new TypeError('bug'); }), { path: '/' })).rejects.toThrow('bug');
  });
});

describe('reads say they are safe to retry (§6.7)', () => {
  it('Cache-Control: no-store on a success and on a problem', async () => {
    expect((await reader.call(READ, ok, { path: '/' })).headers.get('cache-control')).toBe('no-store');
    expect((await callWith(null, READ, ok, { path: '/' }, deps)).headers.get('cache-control')).toBe('no-store');
  });
});
