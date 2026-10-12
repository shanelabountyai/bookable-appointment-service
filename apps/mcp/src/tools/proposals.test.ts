/**
 * M-009/M-010 — preview-then-commit (PRD §8, §9.5–9.6) for prepare_booking
 * and prepare_new_client.
 *
 * NOW is Tue 2026-06-09 09:00 CDT. Bookings go on Wed 10 Jun with Dana.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { bookAppointment } from '@bookable/db/booking';
import { PROPOSAL_TTL_MS } from '@bookable/db/mcp';
import { resetDatabase } from '@bookable/db/testing';
import { connectAs, errorOf, type CallResult, type Connected } from '../testing/connect';
import { seedTwoSalons, type Salon } from '../testing/two-salons';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
let clock = NOW;
const deps = { prisma, now: () => clock };
const TEN_AM = '2026-06-10T10:00:00-05:00';

interface Proposal {
  proposal_id: string;
  summary: string;
  expires: { label: string; iso: string };
}
interface Committed {
  action: string;
  summary: string;
  result: Record<string, unknown>;
}

let a: Salon;
let staff: Connected;
let dana: string;
let tess: string;
let cut: string;
let colour: string;
let maria: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  clock = NOW;
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
  staff = await connectAs(prisma, { businessId: a.businessId, staffUserId: a.staffId, issuedById: a.ownerId }, deps);
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  tess = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Tess' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
  colour = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Colour' } })).id;
  maria = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Maria Gomez', phone: '+13125550142' }, select: { id: true } })).id;
});

const call = (c: Connected, name: string, args: Record<string, unknown>) => c.client.callTool({ name, arguments: args });
const textOf = (r: CallResult) => (r.content as { text: string }[])[0]!.text;
const prepareBooking = (args: Record<string, unknown> = {}) =>
  call(staff, 'prepare_booking', { client_id: maria, service_ids: [cut], provider_id: dana, start: TEN_AM, ...args });
const commit = (proposal_id: string) => call(staff, 'commit_proposal', { proposal_id });

describe('prepare_booking → commit_proposal', () => {
  it('previews with the exact sentence, writes nothing, then commits the same booking under the person and the mcp channel', async () => {
    const p = await prepareBooking({ note: 'wants it shorter' });
    expect(errorOf(p)).toBeNull();
    const proposal = p.structuredContent as Proposal;
    expect(proposal.summary).toBe('Book Maria Gomez — Cut with Dana, Wed 10 Jun, 10:00 am–10:45 am.');
    expect(proposal.expires.iso).toBe('2026-06-09T09:10:00-05:00');
    expect(textOf(p)).toBe(`Proposed: ${proposal.summary} Commit with proposal_id ${proposal.proposal_id}.`);
    expect(await prisma.appointment.count({ where: { businessId: a.businessId, clientId: maria } })).toBe(0);

    const c = await commit(proposal.proposal_id);
    expect(errorOf(c)).toBeNull();
    const done = c.structuredContent as Committed;
    expect(done.action).toBe('prepare_booking');
    expect(done.result).toMatchObject({ status: 'booked', deduplicated: false, start: { iso: TEN_AM }, end: { iso: '2026-06-10T10:45:00-05:00' } });

    const appt = await prisma.appointment.findUniqueOrThrow({
      where: { id: done.result.appointment_id as string },
      include: { events: true },
    });
    expect(appt.clientId).toBe(maria);
    expect(appt.notes).toBe('wants it shorter');
    expect(appt.idempotencyKey).toBe(`mcp:${proposal.proposal_id}`);
    expect(appt.events).toHaveLength(1);
    expect(appt.events[0]).toMatchObject({ type: 'booked', actor: 'staff', actorRef: a.staffId, channel: 'mcp' });

    const row = await prisma.mcpProposal.findUniqueOrThrow({ where: { id: proposal.proposal_id } });
    expect(row.usedAt).toEqual(NOW);
    expect(row.outcome).toMatchObject({ ok: true, result: { appointment_id: appt.id } });
  });

  it('a second commit is PROPOSAL_USED and nothing is written twice', async () => {
    const { proposal_id } = (await prepareBooking()).structuredContent as Proposal;
    expect(errorOf(await commit(proposal_id))).toBeNull();
    const again = await commit(proposal_id);
    expect(errorOf(again)).toMatchObject({ error: 'PROPOSAL_USED', field: 'proposal_id' });
    expect(await prisma.appointment.count({ where: { businessId: a.businessId, clientId: maria } })).toBe(1);
  });

  it('after ten minutes the proposal is PROPOSAL_EXPIRED', async () => {
    const { proposal_id } = (await prepareBooking()).structuredContent as Proposal;
    clock = toDate(instantFromIso('2026-06-09T14:10:01Z'));
    expect(errorOf(await commit(proposal_id))).toMatchObject({ error: 'PROPOSAL_EXPIRED', field: 'proposal_id' });
    expect(PROPOSAL_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("another person's proposal — even in the same salon — is NOT_FOUND, with no hint it exists", async () => {
    const { proposal_id } = (await prepareBooking()).structuredContent as Proposal;
    const owner = await connectAs(prisma, { businessId: a.businessId, staffUserId: a.ownerId, issuedById: a.ownerId }, deps);
    try {
      const r = await call(owner, 'commit_proposal', { proposal_id });
      expect(errorOf(r)).toMatchObject({ error: 'NOT_FOUND', field: 'proposal_id' });
      expect(JSON.stringify(r)).not.toMatch(/another|elsewhere|someone else/i);
    } finally {
      await owner.close();
    }
    expect(errorOf(await call(staff, 'commit_proposal', { proposal_id: 'nope' }))).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('STALE: the time is taken between preview and commit → SLOT_TAKEN, nothing written, next is prepare_booking again', async () => {
    const { proposal_id } = (await prepareBooking()).structuredContent as Proposal;
    await bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: dana,
      serviceIds: [cut],
      startAt: toDate(instantFromIso('2026-06-10T15:00:00Z')),
      now: NOW,
      actor: staffActor(a.ownerId),
      audience: 'staff',
    });
    const r = await commit(proposal_id);
    expect(errorOf(r)).toMatchObject({ error: 'SLOT_TAKEN', field: 'start', next: { tool: 'find_open_times' } });
    expect(await prisma.appointment.count({ where: { businessId: a.businessId, clientId: maria } })).toBe(0);
    const row = await prisma.mcpProposal.findUniqueOrThrow({ where: { id: proposal_id } });
    expect(row.usedAt).not.toBeNull();
    expect(row.outcome).toMatchObject({ ok: false, error: 'SLOT_TAKEN' });
    // The claim stands: the model re-prepares rather than retrying a dead proposal.
    expect(errorOf(await commit(proposal_id))).toMatchObject({ error: 'PROPOSAL_USED' });
  });

  it('the preview refuses what the write would refuse: taken, outside hours, wrong stylist, DST overlap, unknown ids', async () => {
    await bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: dana,
      serviceIds: [cut],
      startAt: toDate(instantFromIso('2026-06-10T15:00:00Z')),
      now: NOW,
      actor: staffActor(a.ownerId),
      audience: 'staff',
    });
    const taken = errorOf(await prepareBooking());
    expect(taken).toMatchObject({ error: 'SLOT_TAKEN', field: 'start', next: { tool: 'find_open_times' } });
    expect(taken?.message).toMatch(/overlaps-booking/);

    expect(errorOf(await prepareBooking({ start: '2026-06-10 07:00' }))).toMatchObject({ error: 'OUTSIDE_HOURS', field: 'start' });
    expect(errorOf(await prepareBooking({ start: '2026-06-14 10:00' }))).toMatchObject({ error: 'OUTSIDE_HOURS' }); // Sunday
    expect(errorOf(await prepareBooking({ provider_id: tess, service_ids: [colour] }))).toMatchObject({ error: 'NOT_QUALIFIED', field: 'provider_id' });
    expect(errorOf(await prepareBooking({ start: '2026-11-01 01:30' }))).toMatchObject({ error: 'AMBIGUOUS_TIME', field: 'start' });
    expect(errorOf(await prepareBooking({ client_id: 'nope' }))).toMatchObject({ error: 'NOT_FOUND', field: 'client_id' });
    expect(errorOf(await prepareBooking({ provider_id: 'any' }))).toMatchObject({ error: 'NOT_FOUND', field: 'provider_id' });
    expect(await prisma.mcpProposal.count({ where: { staffUserId: a.staffId } })).toBe(0);
  });

  it('commit_proposal is the only destructive tool; prepare_* are not', async () => {
    const { tools } = await staff.client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive).toEqual(['commit_proposal']);
    expect(tools.find((t) => t.name === 'prepare_booking')!.annotations?.readOnlyHint).toBe(false);
  });
});

describe('prepare_new_client → commit_proposal', () => {
  it('adds the client; the phone is stored canonically so find_client finds it', async () => {
    const p = await call(staff, 'prepare_new_client', { name: ' Jordan Lee ', phone: '(312) 555-0199' });
    expect(errorOf(p)).toBeNull();
    const proposal = p.structuredContent as Proposal;
    expect(proposal.summary).toBe('Add client Jordan Lee, phone ending 0199.');
    const c = await commit(proposal.proposal_id);
    const done = c.structuredContent as Committed;
    expect(done.result).toMatchObject({ name: 'Jordan Lee', phone_last4: '0199' });
    const found = await call(staff, 'find_client', { query: '3125550199' });
    expect((found.structuredContent as { clients: { id: string }[] }).clients.map((x) => x.id)).toEqual([done.result.client_id]);
  });

  it('a phone already on the books is AMBIGUOUS_CLIENT naming the existing client', async () => {
    const r = await call(staff, 'prepare_new_client', { name: 'M. Gomez', phone: '312-555-0142' });
    const e = errorOf(r);
    expect(e).toMatchObject({ error: 'AMBIGUOUS_CLIENT', field: 'phone', next: { tool: 'find_client' } });
    expect(e?.message).toContain('Maria Gomez');
    expect(e?.message).toContain(maria);
    expect(e?.message).not.toContain('5550142');
  });

  it('refuses a blank name and a non-number', async () => {
    expect(errorOf(await call(staff, 'prepare_new_client', { name: '   ', phone: '3125550000' }))).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'name' });
    expect(errorOf(await call(staff, 'prepare_new_client', { name: 'Someone', phone: 'call me' }))).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'phone' });
  });
});
