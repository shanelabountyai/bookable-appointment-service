/**
 * W-006 — idempotent writes: POST /v1/appointments and POST /v1/clients
 * (API PRD §6.6, §9.3–9.4).
 *
 *   - a replay returns the stored response BYTE-FOR-BYTE with `Idempotent-Replayed: true`;
 *   - the same key with a different body → 422;
 *   - a BARRIER-forced concurrent pair → exactly one appointment and one 409 —
 *     the first request is held inside its work transaction (claim committed)
 *     until the second has been answered, so the interleaving is forced, not hoped for;
 *   - a crash after the domain write and before the outcome → no appointment, and the key runs again;
 *   - both error SHAPES of the exclusion constraint reach the API as SLOT_TAKEN (A-078).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { revokeApiKey } from '@bookable/db/api';
import { OUR_EXCLUSION_CONSTRAINTS } from '@bookable/db/errors';
import { resetDatabase } from '@bookable/db/testing';
import { type Caller, callWith, keyFor, seedTwoSalons, type Salon } from './testing';
import { postAppointment, postClient } from './writes';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const WRITE = { scope: 'write' } as const;

let a: Salon;
let b: Salon;
let key: Caller;
let dana: string;
let cut: string;
let maria: string;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a, b } = await seedTwoSalons(prisma));
  key = await keyFor(prisma, a, ['read', 'write'], deps, 'HubSpot sync');
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
  maria = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Maria Gomez', phone: '+13125550142' }, select: { id: true } })).id;
});

const booking = (over: Record<string, unknown> = {}) => ({ clientId: maria, serviceIds: [cut], providerId: dana, start: '2026-06-10 10:00', ...over });
const post = (body: unknown, idem: string | null = 'k-1', handler = postAppointment(), k = key) =>
  k.call(WRITE, handler, { method: 'POST', path: '/api/v1/appointments', body, headers: idem ? { 'Idempotency-Key': idem } : {} });
const count = () => prisma.appointment.count({ where: { businessId: a.businessId, providerId: dana, startAt: toDate(instantFromIso('2026-06-10T15:00:00Z')) } });

describe('POST /v1/appointments', () => {
  it('201 with the appointment view and Location; the row is channel api, actorRef the KEY, and the audit is the desk rules', async () => {
    const r = await post(booking({ note: 'bring the photo' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'booked', startAt: '2026-06-10T10:00:00-05:00', providerId: dana, client: { id: maria, name: 'Maria Gomez' }, note: 'bring the photo' });
    expect(r.headers.get('location')).toBe(`/api/v1/appointments/${r.body.id}`);
    const ev = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: r.body.id as string } });
    expect(ev).toMatchObject({ type: 'booked', actor: 'staff', channel: 'api', actorRef: key.keyId });
    expect(await prisma.notificationOutbox.count({ where: { appointmentId: r.body.id as string } })).toBeGreaterThan(0);
  });

  it('IDEMPOTENCY_REQUIRED without the header; VALIDATION for a 256-char key; nothing written', async () => {
    expect((await post(booking(), null)).body).toMatchObject({ code: 'IDEMPOTENCY_REQUIRED', status: 400, errors: [{ field: 'Idempotency-Key' }] });
    expect((await post(booking(), 'x'.repeat(256))).body.code).toBe('VALIDATION');
    expect(await count()).toBe(0);
  });

  it('a replay is BYTE-FOR-BYTE the first response, with Idempotent-Replayed: true, and books nothing twice', async () => {
    const first = await post(booking());
    // The same body with its keys in another order is the same request.
    const again = await post({ start: '2026-06-10 10:00', providerId: dana, serviceIds: [cut], clientId: maria });
    expect(again.status).toBe(201);
    expect(again.text).toBe(first.text);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect(await count()).toBe(1);
  });

  it('the same key with a different body is 422 IDEMPOTENCY_MISMATCH; a key is scoped to its API key', async () => {
    await post(booking());
    expect((await post(booking({ start: '2026-06-10 11:00' }))).body).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', status: 422 });
    const other = await keyFor(prisma, a, ['read', 'write'], deps, 'n8n');
    const r = await post(booking({ start: '2026-06-10 11:00' }), 'k-1', postAppointment(), other);
    expect(r.status).toBe(201);
  });

  it('a refusal is an ANSWER and replays as one: SLOT_TAKEN stays SLOT_TAKEN even after the slot frees', async () => {
    const taken = await post(booking(), 'first');
    const refused = await post(booking({ clientId: (await prisma.client.create({ data: { businessId: a.businessId, name: 'Nadia' } })).id }), 'second');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'SLOT_TAKEN', next: { endpoint: 'GET /v1/availability' } });
    await prisma.appointment.update({ where: { id: taken.body.id as string }, data: { status: 'cancelled' } });
    const replay = await post(JSON.parse(JSON.stringify(refused.body)) && booking({ clientId: (await prisma.client.findFirstOrThrow({ where: { name: 'Nadia' } })).id }), 'second');
    expect(replay.text).toBe(refused.text);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  it('BARRIER RACE: two concurrent requests with one key → exactly one appointment, one 201 and one 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstInside!: () => void;
    const inside = new Promise<void>((resolve) => (firstInside = resolve));
    const handler = postAppointment({
      // Runs only for the request that CLAIMED the key: it is now provably mid-flight.
      beforeWork: async () => {
        firstInside();
        await gate;
      },
    });
    const first = post(booking(), 'race', handler);
    await inside;
    const second = await post(booking(), 'race', handler);
    releaseFirst();
    const done = await first;
    expect([done.status, second.status].sort()).toEqual([201, 409]);
    expect(second.body).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 });
    expect(second.headers.get('retry-after')).toBe('1');
    expect(await count()).toBe(1);
    // And once the first has finished, the loser's retry replays the winner.
    const retry = await post(booking(), 'race', handler);
    expect(retry.text).toBe(done.text);
  });

  it('CRASH between the domain write and the outcome → no appointment, no outbox row, and the key runs again', async () => {
    const outboxBefore = await prisma.notificationOutbox.count();
    const eventsBefore = await prisma.appointmentEvent.count();
    const crashing = postAppointment({ afterWrite: async () => { throw new Error('simulated crash after the write'); } });
    await expect(post(booking(), 'crash', crashing)).rejects.toThrow('simulated crash');
    expect(await count()).toBe(0);
    expect(await prisma.notificationOutbox.count()).toBe(outboxBefore);
    expect(await prisma.appointmentEvent.count()).toBe(eventsBefore);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
    const retry = await post(booking(), 'crash');
    expect(retry.status).toBe(201);
    expect(await count()).toBe(1);
  });

  it('an abandoned in_progress claim (its process died) is reclaimed after 10 minutes, never before', async () => {
    await prisma.idempotencyRecord.create({ data: { businessId: a.businessId, apiKeyId: key.keyId, idemKey: 'orphan', requestHash: (await import('@bookable/db/api')).requestHashOf('POST', '/api/v1/appointments', booking()), status: 'in_progress', expiresAt: toDate(instantFromIso('2026-06-10T14:00:00Z')), updatedAt: NOW } });
    expect((await post(booking(), 'orphan')).body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    const later = { prisma, now: () => toDate(instantFromIso('2026-06-09T14:10:00Z')) };
    const r = await callWith(key.key, WRITE, postAppointment(), { method: 'POST', path: '/api/v1/appointments', body: booking(), headers: { 'Idempotency-Key': 'orphan' } }, later);
    expect(r.status).toBe(201);
  });

  it('BOTH error shapes of the exclusion constraint reach the API as SLOT_TAKEN (A-078)', async () => {
    // Both shapes provoked FOR REAL against the live constraint (a mapper tested on one shape is tested on
    // neither — CLAUDE.md): a second worked block over the first one's range, refused at statement end and,
    // with the constraint deferred, at COMMIT.
    const { bookAppointment } = await import('@bookable/db/booking');
    const { staffActor } = await import('@bookable/core/auth');
    const { toProblem } = await import('./problem');
    const base = { businessId: a.businessId, providerId: dana, serviceIds: [cut], startAt: toDate(instantFromIso('2026-06-10T15:00:00Z')), now: NOW, actor: staffActor(a.ownerId), audience: 'staff' as const };
    await bookAppointment(prisma, base);
    // 1) the immediate shape: refused at statement end.
    let immediate: unknown;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AppointmentBlock" ("id","businessId","appointmentId","providerId","ordinal","status","blockedStart","blockedEnd")
         SELECT 'x', "businessId", "appointmentId", "providerId", 99, "status", "blockedStart", "blockedEnd" FROM "AppointmentBlock" LIMIT 1`,
      );
    } catch (e) {
      immediate = e;
    }
    // 2) the deferred shape: the same refusal at COMMIT. Provoked through node-postgres (as constraint.test.ts
    //    does) — the local stand-in's Prisma driver adapter hangs on a commit-time failure inside an interactive
    //    transaction (W-D9), which is an environment defect, not a property of the product.
    const { Client } = await import('pg');
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    let deferred: unknown;
    try {
      await pg.query('BEGIN');
      for (const name of OUR_EXCLUSION_CONSTRAINTS) await pg.query(`SET CONSTRAINTS "${name}" DEFERRED`);
      await pg.query(
        `INSERT INTO "AppointmentBlock" ("id","businessId","appointmentId","providerId","ordinal","status","blockedStart","blockedEnd")
         SELECT 'y', "businessId", "appointmentId", "providerId", 98, "status", "blockedStart", "blockedEnd" FROM "AppointmentBlock" WHERE id <> 'x' LIMIT 1`,
      );
      await pg.query('COMMIT');
    } catch (e) {
      deferred = e;
      await pg.query('ROLLBACK').catch(() => {});
    } finally {
      await pg.end();
    }
    // 3) and the shape Prisma's NATIVE engine gives that same commit-time refusal (A-078, verified there):
    //    no code, no SQLSTATE — only the constraint's name in the message.
    const prismaDeferred = Object.assign(new Error('Error in connector: Error querying the database: ERROR: conflicting key value violates exclusion constraint "appointment_block_no_overlap"'), { name: 'PrismaClientUnknownRequestError' });
    for (const e of [immediate, deferred, prismaDeferred]) {
      expect(e, 'the constraint must actually have refused').toBeDefined();
      expect(toProblem(e)?.problem).toMatchObject({ code: 'SLOT_TAKEN', status: 409, next: { endpoint: 'GET /v1/availability' } });
    }
  });

  it('tenancy: business-B ids are NOT_FOUND, a read-only key is FORBIDDEN_SCOPE, a revoked key is UNAUTHENTICATED — nothing written', async () => {
    for (const over of [{ clientId: b.clientId }, { providerId: b.providerIds[0] }, { serviceIds: b.serviceIds }]) {
      expect((await post(booking(over), `t-${Object.keys(over)[0]}`)).body.code).toBe('NOT_FOUND');
    }
    const reader = await keyFor(prisma, a, ['read'], deps, 'r');
    expect((await post(booking(), 'ro', postAppointment(), reader)).body.code).toBe('FORBIDDEN_SCOPE');
    await revokeApiKey(prisma, { businessId: a.businessId, id: key.keyId, now: NOW });
    expect((await post(booking(), 'rev')).body.code).toBe('UNAUTHENTICATED');
    expect(await prisma.appointment.count({ where: { businessId: a.businessId } })).toBe(1); // the seed's own
  });

  it('OUTSIDE_HOURS for a Sunday, NOT_QUALIFIED for Tess on a colour, AMBIGUOUS_TIME on fall-back 01:30, VALIDATION for "any"', async () => {
    expect((await post(booking({ start: '2026-06-14 10:00' }), 'sun')).body).toMatchObject({ code: 'OUTSIDE_HOURS', status: 422 });
    const tess = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Tess' } })).id;
    const colour = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Colour' } })).id;
    expect((await post(booking({ providerId: tess, serviceIds: [colour] }), 'tess')).body).toMatchObject({ code: 'NOT_QUALIFIED', status: 422 });
    expect((await post(booking({ start: '2026-11-01 01:30' }), 'dst')).body).toMatchObject({ code: 'AMBIGUOUS_TIME', status: 422 });
    expect((await post(booking({ providerId: 'any' }), 'any')).body).toMatchObject({ code: 'VALIDATION', errors: [{ field: 'providerId' }] });
  });
});

describe('POST /v1/clients', () => {
  const add = (body: unknown, idem = 'c-1', k = key) => k.call(WRITE, postClient(), { method: 'POST', path: '/api/v1/clients', body, headers: { 'Idempotency-Key': idem } });

  it('adds a client through the shared createClient; the phone is canonicalised by the database; no contacts without the scope', async () => {
    const r = await add({ name: '  Rae Núñez ', phone: '(312) 555-0199' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Rae Núñez', phoneLast4: '0199' });
    expect(r.body).not.toHaveProperty('phone');
    const row = await prisma.client.findUniqueOrThrow({ where: { id: r.body.id as string } });
    expect(row.phone).toBe('+13125550199');
    expect(row.businessId).toBe(a.businessId);
  });

  it('a phone already on the book is AMBIGUOUS_CLIENT naming the match; allowDuplicate adds a second person on it (D-17)', async () => {
    const r = await add({ name: 'Maria G', phone: '312 555 0142' }, 'dup');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'AMBIGUOUS_CLIENT', matches: [{ id: maria, name: 'Maria Gomez' }], next: { endpoint: 'GET /v1/clients' } });
    expect(JSON.stringify(r.body)).not.toContain('5550142');
    const ok = await add({ name: 'Lucia Gomez', phone: '312 555 0142', allowDuplicate: true }, 'dup2');
    expect(ok.status).toBe(201);
    expect(await prisma.client.count({ where: { businessId: a.businessId, phone: '+13125550142' } })).toBe(2);
  });

  it('a phone in ANOTHER business is not a duplicate here, and is never named', async () => {
    const r = await add({ name: 'Alex', phone: '+17735550100' }, 'b-phone');
    expect(r.status).toBe(201);
  });

  it('VALIDATION for a short phone and a bad email; replay is byte-for-byte', async () => {
    expect((await add({ name: 'X', phone: '12345' }, 'v1')).body.code).toBe('VALIDATION');
    expect((await add({ name: 'X', phone: '3125550111', email: 'not-an-email' }, 'v2')).body.code).toBe('VALIDATION');
    const first = await add({ name: 'Sam Lee', phone: '3125550111' }, 'r1');
    const again = await add({ name: 'Sam Lee', phone: '3125550111' }, 'r1');
    expect(again.text).toBe(first.text);
    expect(await prisma.client.count({ where: { name: 'Sam Lee' } })).toBe(1);
  });
});
