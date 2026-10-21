/**
 * M-013 — the two proofs PRD §9.5–9.6 ask for.
 *
 * RACE, two shapes. (1) ONE proposal, TWO commits at once: the claim is a
 * conditional UPDATE, and the interleaving is forced with `behindRowLock` —
 * the proposal row is held until both commits are provably queued on it, then
 * released, so both read the same unused row and exactly one wins. (2) TWO
 * proposals (two people) for ONE slot, committed at once: the domain layer's
 * advisory lock serialises them (races.test.ts #1), and exactly one booking
 * results; both proposals are consumed, the loser with SLOT_TAKEN.
 *
 * PARITY. A booking and a cancellation made through MCP and the same ones made
 * at the desk produce identical appointment rows and identical event rows,
 * except `channel` — and the proposal's own bookkeeping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { transitionAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { behindRowLock, resetDatabase } from '@bookable/db/testing';
import { connectAs, errorOf, type Connected } from '../testing/connect';
import { seedTwoSalons, type Salon } from '../testing/two-salons';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const TEN = '2026-06-10T10:00:00-05:00';
const TEN_INSTANT = toDate(instantFromIso('2026-06-10T15:00:00Z'));

let a: Salon;
let staff: Connected;
let owner: Connected;
let dana: string;
let cut: string;
let maria: string;
let nadia: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
  staff = await connectAs(prisma, { businessId: a.businessId, staffUserId: a.staffId, issuedById: a.ownerId }, deps);
  owner = await connectAs(prisma, { businessId: a.businessId, staffUserId: a.ownerId, issuedById: a.ownerId }, deps);
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
  maria = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Maria Gomez', phone: '+13125550142' }, select: { id: true } })).id;
  nadia = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Nadia Khan', phone: '+13125550177' }, select: { id: true } })).id;
});

const call = (c: Connected, name: string, args: Record<string, unknown>) => c.client.callTool({ name, arguments: args });
const prepare = async (c: Connected, clientId: string) => {
  const p = await call(c, 'prepare_booking', { client_id: clientId, service_ids: [cut], provider_id: dana, start: TEN });
  expect(errorOf(p)).toBeNull();
  return (p.structuredContent as { proposal_id: string }).proposal_id;
};
const bookingsAtTen = () => prisma.appointment.count({ where: { businessId: a.businessId, providerId: dana, startAt: TEN_INSTANT, status: 'booked' } });

describe('race', () => {
  it('one proposal, two simultaneous commits → exactly one booking, the other PROPOSAL_USED (barrier-forced)', async () => {
    const id = await prepare(staff, maria);
    const [x, y] = await behindRowLock('McpProposal', id, 2, () =>
      Promise.all([call(staff, 'commit_proposal', { proposal_id: id }), call(staff, 'commit_proposal', { proposal_id: id })]),
    );
    const errors = [errorOf(x), errorOf(y)];
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(errors.filter((e) => e?.error === 'PROPOSAL_USED')).toHaveLength(1);
    expect(await bookingsAtTen()).toBe(1);
  });

  it('two people, two proposals, one slot → exactly one booking; the loser is SLOT_TAKEN and both proposals are spent', async () => {
    const [p1, p2] = await Promise.all([prepare(staff, maria), prepare(owner, nadia)]);
    const [x, y] = await Promise.all([call(staff, 'commit_proposal', { proposal_id: p1 }), call(owner, 'commit_proposal', { proposal_id: p2 })]);
    const errors = [errorOf(x), errorOf(y)];
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    const loser = errors.find((e) => e !== null)!;
    expect(loser).toMatchObject({ error: 'SLOT_TAKEN', next: { tool: 'find_open_times' } });
    expect(await bookingsAtTen()).toBe(1);
    const rows = await prisma.mcpProposal.findMany({ where: { id: { in: [p1, p2] } } });
    expect(rows.every((r) => r.usedAt !== null)).toBe(true);
    expect(rows.map((r) => (r.outcome as { ok: boolean }).ok).sort()).toEqual([false, true]);
  });
});

/** Columns that legitimately differ between any two bookings, or carry the MCP bookkeeping. */
const APPOINTMENT_VARIES = new Set(['id', 'createdAt', 'updatedAt', 'idempotencyKey', 'clientId', 'cancelledAt']);
const EVENT_VARIES = new Set(['id', 'appointmentId', 'createdAt', 'channel', 'seq']); // seq: the per-business commit order (W-008), different by design
const strip = (row: Record<string, unknown>, skip: Set<string>) => Object.fromEntries(Object.entries(row).filter(([k]) => !skip.has(k)));

describe('parity (PRD §9.6)', () => {
  it('a booking then a cancellation via MCP and via the desk produce the same rows and events except channel', async () => {
    // MCP: Maria, by the stylist's token.
    const id = await prepare(staff, maria);
    const c = await call(staff, 'commit_proposal', { proposal_id: id });
    expect(errorOf(c)).toBeNull();
    const mcpId = (c.structuredContent as { result: { appointment_id: string } }).result.appointment_id;
    const cp = await call(staff, 'prepare_cancel', { appointment_id: mcpId, reason: 'parity' });
    expect(errorOf(await call(staff, 'commit_proposal', { proposal_id: (cp.structuredContent as { proposal_id: string }).proposal_id }))).toBeNull();

    // Desk: Nadia, the same stylist, the same slot (free again after the cancellation), the same person acting.
    const desk = await bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: dana,
      serviceIds: [cut],
      clientId: nadia,
      startAt: TEN_INSTANT,
      now: NOW,
      actor: staffActor(a.staffId),
      audience: 'staff',
    });
    await transitionAppointment(prisma, {
      businessId: a.businessId,
      appointmentId: desk.id,
      to: 'cancelled',
      cancellation: 'derive',
      actor: staffActor(a.staffId),
      now: NOW,
      reason: 'parity',
      notify: true,
      expectedFrom: 'booked',
    });

    const [mcpRow, deskRow] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({ where: { id: mcpId } }),
      prisma.appointment.findUniqueOrThrow({ where: { id: desk.id } }),
    ]);
    expect(strip(mcpRow, APPOINTMENT_VARIES)).toEqual(strip(deskRow, APPOINTMENT_VARIES));
    expect(mcpRow.idempotencyKey).toMatch(/^mcp:/);

    const [mcpEvents, deskEvents] = await Promise.all([
      prisma.appointmentEvent.findMany({ where: { appointmentId: mcpId }, orderBy: { createdAt: 'asc' } }),
      prisma.appointmentEvent.findMany({ where: { appointmentId: desk.id }, orderBy: { createdAt: 'asc' } }),
    ]);
    expect(mcpEvents).toHaveLength(deskEvents.length);
    expect(mcpEvents.map((e) => strip(e, EVENT_VARIES))).toEqual(deskEvents.map((e) => strip(e, EVENT_VARIES)));
    expect(mcpEvents.map((e) => e.channel)).toEqual(mcpEvents.map(() => 'mcp'));
    expect(deskEvents.map((e) => e.channel)).toEqual(deskEvents.map(() => 'desk'));
    expect(mcpEvents.length).toBeGreaterThanOrEqual(2);
  });
});
