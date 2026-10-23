/**
 * W-008 — `AppointmentEvent.seq` and the catch-up door `GET /v1/events`
 * (API PRD §8, §9.7).
 *
 * The lock audit found no business-row lock on every event writer (booking
 * locks provider+day, reschedule its own key, transitions the appointment
 * row), so the sequence is the PRD's fallback, assigned AT COMMIT by a
 * deferred trigger (W-D18). These tests pin the property a receiver relies
 * on: seq order is COMMIT order, gapless, per business — proven with two
 * real connections whose commit order is chosen by the test, never sampled.
 */
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { transitionAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { listEvents } from './events';
import { postCancel, postReschedule } from './moves';
import { type Caller, keyFor, seedTwoSalons, type Salon } from './testing';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const READ = { scope: 'read' } as const;
const WRITE = { scope: 'write' } as const;

let a: Salon;
let b: Salon;
let key: Caller;
let dana: string;
let cut: string;
let maria: string;
let n = 0;

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a, b } = await seedTwoSalons(prisma));
  key = await keyFor(prisma, a, ['read', 'write'], deps);
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
  maria = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Maria Gomez', phone: '+13125550142', email: 'maria@example.test' }, select: { id: true } })).id;
});

const book = (iso: string, businessId = a.businessId, providerId = dana, serviceIds = [cut], clientId: string | null = maria, owner = a.ownerId) =>
  bookAppointment(prisma, { businessId, providerId, serviceIds, clientId, startAt: toDate(instantFromIso(iso)), now: NOW, actor: staffActor(owner), audience: 'staff' });
const events = (query = '', k = key) => k.call(READ, listEvents, { path: `/api/v1/events${query}` });
const seqs = async (businessId: string) =>
  (await prisma.appointmentEvent.findMany({ where: { businessId }, orderBy: { seq: 'asc' }, select: { seq: true } })).map((e) => e.seq);

async function pg(): Promise<PgClient> {
  const c = new PgClient({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c;
}
const rawEvent = (c: PgClient, appointmentId: string, businessId = a.businessId) =>
  c.query(
    `INSERT INTO "AppointmentEvent" (id, "businessId", "appointmentId", type, actor) VALUES ($1, $2, $3, 'conflict_acknowledged', 'staff')`,
    [`ev-${++n}`, businessId, appointmentId],
  ).then(() => `ev-${n}`);

describe('AppointmentEvent.seq', () => {
  it('every committed event has a seq: per business, from 1, gapless', async () => {
    await book('2026-06-10T15:00:00Z');
    await book('2026-06-10T19:00:00Z');
    const seqA = await seqs(a.businessId);
    expect(seqA.length).toBeGreaterThan(2); // the seed's own events + these two
    expect(seqA).toEqual(seqA.map((_, i) => i + 1));
    const seqB = await seqs(b.businessId);
    expect(seqB).toEqual(seqB.map((_, i) => i + 1)); // B counts on its own
  });

  it('is assigned in COMMIT order, not insert order — the second writer to insert commits first and gets the lower seq', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const before = Math.max(...((await seqs(a.businessId)) as number[]));
    const [t1, t2, reader] = [await pg(), await pg(), await pg()];
    try {
      await t1.query('BEGIN');
      await t2.query('BEGIN');
      const first = await rawEvent(t1, appt.id); // inserted first …
      const second = await rawEvent(t2, appt.id);
      await t2.query('COMMIT'); // … but committed second
      // A reader between the commits sees the committed one only, already numbered.
      const mid = await reader.query<{ id: string; seq: number }>(`SELECT id, seq FROM "AppointmentEvent" WHERE id = ANY($1)`, [[first, second]]);
      expect(mid.rows).toEqual([{ id: second, seq: before + 1 }]);
      await t1.query('COMMIT');
      const after = await reader.query<{ id: string; seq: number }>(`SELECT id, seq FROM "AppointmentEvent" WHERE id = ANY($1) ORDER BY seq`, [[first, second]]);
      expect(after.rows).toEqual([
        { id: second, seq: before + 1 },
        { id: first, seq: before + 2 },
      ]);
    } finally {
      await Promise.all([t1, t2, reader].map((c) => c.end()));
    }
  });

  it('a concurrent committer BLOCKS on the sequence row until the first commit is visible', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const [holder, writer] = [await pg(), await pg()];
    try {
      // Hold the business's sequence row the way a committing transaction does.
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM "BusinessEventSeq" WHERE "businessId" = $1 FOR UPDATE`, [a.businessId]);
      await writer.query('BEGIN');
      await rawEvent(writer, appt.id);
      const commit = writer.query('COMMIT');
      for (;;) {
        const { rows } = await holder.query<{ n: string }>(`SELECT count(*) AS n FROM pg_locks WHERE locktype IN ('tuple','transactionid') AND NOT granted`);
        if (Number(rows[0]!.n) >= 1) break; // the writer's COMMIT is queued on our lock
      }
      await holder.query('COMMIT');
      await commit;
    } finally {
      await Promise.all([holder, writer].map((c) => c.end()));
    }
    const seqA = await seqs(a.businessId);
    expect(seqA).toEqual(seqA.map((_, i) => i + 1));
  });

  it('a rolled-back transaction leaves no gap', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const c = await pg();
    try {
      await c.query('BEGIN');
      await rawEvent(c, appt.id);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    await book('2026-06-10T19:00:00Z');
    const seqA = await seqs(a.businessId);
    expect(seqA).toEqual(seqA.map((_, i) => i + 1));
  });

  it('the log stays append-only: seq is set once, and nothing else about an event can change', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const ev = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: appt.id } });
    await expect(prisma.$executeRawUnsafe(`UPDATE "AppointmentEvent" SET seq = 999 WHERE id = $1`, ev.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AppointmentEvent" SET reason = 'x' WHERE id = $1`, ev.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AppointmentEvent" WHERE id = $1`, ev.id)).rejects.toThrow(/append-only/);
  });
});

describe('GET /v1/events', () => {
  it('returns the PUBLISHED events in seq order, in the webhook body shape, with a snapshot of the appointment', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const r = await events();
    expect(r.status).toBe(200);
    const data = r.body.data as Record<string, unknown>[];
    const booked = data.find((e) => (e.data as { appointment: { id: string } }).appointment.id === appt.id)!;
    expect(booked).toMatchObject({
      type: 'appointment.booked',
      apiVersion: 'v1',
      replayed: false,
      data: { appointment: { id: appt.id, status: 'booked', startAt: '2026-06-10T10:00:00-05:00', client: { id: maria, name: 'Maria Gomez' } } },
    });
    expect(typeof booked.id).toBe('string');
    expect(typeof booked.occurredAt).toBe('string');
    const s = data.map((e) => e.seq as number);
    expect(s).toEqual([...s].sort((x, y) => x - y));
  });

  it('maps each published type, and leaves the rest out (OQ-W6, §8)', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    await key.call(WRITE, postReschedule(), { method: 'POST', path: '/x', params: { id: appt.id }, body: { start: '2026-06-10 11:00' }, headers: { 'Idempotency-Key': 'r1' } });
    const other = await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: { not: 'Dana' }, serviceProviders: { some: { serviceId: cut } } } });
    await key.call(WRITE, postReschedule(), { method: 'POST', path: '/x', params: { id: appt.id }, body: { start: '2026-06-10 11:00', providerId: other.id }, headers: { 'Idempotency-Key': 'r2' } });
    await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt.id, to: 'checked_in', actor: staffActor(a.ownerId), now: toDate(instantFromIso('2026-06-10T15:55:00Z')) });
    const second = await book('2026-06-11T15:00:00Z');
    await key.call(WRITE, postCancel(), { method: 'POST', path: '/x', params: { id: second.id }, body: { reason: 'client called' }, headers: { 'Idempotency-Key': 'c1' } });
    const raw = await prisma.$executeRawUnsafe(
      `INSERT INTO "AppointmentEvent" (id, "businessId", "appointmentId", type, actor) VALUES ('ev-unpub', $1, $2, 'conflict_acknowledged', 'staff')`,
      a.businessId,
      appt.id,
    );
    expect(raw).toBe(1);

    const data = (await events('?limit=100')).body.data as { id: string; type: string; data: { appointment: { id: string }; change?: Record<string, unknown> } }[];
    const mine = data.filter((e) => [appt.id, second.id].includes(e.data.appointment.id));
    expect(mine.map((e) => e.type)).toEqual([
      'appointment.booked',
      'appointment.rescheduled',
      'appointment.reassigned',
      'appointment.status_changed',
      'appointment.booked',
      'appointment.cancelled',
    ]);
    expect(mine[3]!.data.change).toMatchObject({ from: 'booked', to: 'checked_in' });
    expect(data.some((e) => e.id === 'ev-unpub')).toBe(false);
  });

  it('?since=<seq> is the catch-up door, and the cursor pages every event exactly once', async () => {
    for (const d of ['10', '11', '12', '13', '16']) await book(`2026-06-${d}T15:00:00Z`);
    const all = (await events('?limit=100')).body.data as { id: string; seq: number }[];
    expect(all.length).toBeGreaterThanOrEqual(5);
    const mid = all[2]!.seq;
    const since = (await events(`?since=${mid}&limit=100`)).body.data as { seq: number }[];
    expect(since.map((e) => e.seq)).toEqual(all.filter((e) => e.seq > mid).map((e) => e.seq));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await events(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...(r.body.data as { id: string }[]).map((e) => e.id));
      cursor = r.body.nextCursor as string | null;
    } while (cursor);
    expect(seen).toEqual(all.map((e) => e.id));
  });

  it('the snapshot is taken once: after the appointment moves, the booked event still shows the booked time', async () => {
    const appt = await book('2026-06-10T15:00:00Z');
    const first = ((await events('?limit=100')).body.data as { type: string; data: { appointment: { id: string; startAt: string } } }[]).find(
      (e) => e.data.appointment.id === appt.id,
    )!;
    expect(first.data.appointment.startAt).toBe('2026-06-10T10:00:00-05:00');
    await key.call(WRITE, postReschedule(), { method: 'POST', path: '/x', params: { id: appt.id }, body: { start: '2026-06-10 13:00' }, headers: { 'Idempotency-Key': 'r1' } });
    const again = (await events('?limit=100')).body.data as { type: string; data: { appointment: { id: string; startAt: string } } }[];
    const booked = again.find((e) => e.type === 'appointment.booked' && e.data.appointment.id === appt.id)!;
    const moved = again.find((e) => e.type === 'appointment.rescheduled' && e.data.appointment.id === appt.id)!;
    expect(booked.data.appointment.startAt).toBe('2026-06-10T10:00:00-05:00');
    expect(moved.data.appointment.startAt).toBe('2026-06-10T13:00:00-05:00');
  });

  it('tenancy and PII: B\'s key never sees A\'s events, and no body carries a phone or email', async () => {
    await book('2026-06-10T15:00:00Z');
    const keyB = await keyFor(prisma, b, ['read', 'contacts'], deps);
    const rB = await events('?limit=100', keyB);
    const aIds = new Set((await prisma.appointment.findMany({ where: { businessId: a.businessId }, select: { id: true } })).map((x) => x.id));
    for (const e of rB.body.data as { data: { appointment: { id: string } } }[]) expect(aIds.has(e.data.appointment.id)).toBe(false);
    const rA = await events('?limit=100');
    expect(rA.text).not.toContain('5550142');
    expect(rA.text).not.toContain('maria@example.test');
  });

  it('refuses a bad since, a junk cursor and an oversized limit as VALIDATION', async () => {
    for (const q of ['?since=-1', '?since=abc', '?cursor=junk', '?limit=101']) {
      const r = await events(q);
      expect(r.status, q).toBe(400);
      expect(r.body.code, q).toBe('VALIDATION');
    }
  });
});
