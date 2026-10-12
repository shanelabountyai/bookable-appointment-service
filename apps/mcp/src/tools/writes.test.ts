/**
 * M-011/M-012 — prepare_reschedule, prepare_cancel, prepare_status_change,
 * prepare_waitlist_entry, each through commit_proposal.
 *
 * NOW is Tue 2026-06-09 09:00 CDT; Maria's Cut with Dana is Wed 10 Jun 10:00.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { transitionAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { connectAs, errorOf, type Connected } from '../testing/connect';
import { seedTwoSalons, type Salon } from '../testing/two-salons';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
let clock = NOW;
const deps = { prisma, now: () => clock };

interface Proposal {
  proposal_id: string;
  summary: string;
}
interface Committed {
  result: Record<string, unknown>;
}

let a: Salon;
let staff: Connected;
let dana: string;
let priya: string;
let tess: string;
let cut: string;
let colour: string;
let maria: string;
let appt: string;

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
  const p = async (n: string) => (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: n } })).id;
  const s = async (n: string) => (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: n } })).id;
  [dana, priya, tess, cut, colour] = await Promise.all([p('Dana'), p('Priya'), p('Tess'), s('Cut'), s('Colour')]);
  maria = (await prisma.client.create({ data: { businessId: a.businessId, name: 'Maria Gomez', phone: '+13125550142' }, select: { id: true } })).id;
  appt = (
    await bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: dana,
      serviceIds: [cut],
      clientId: maria,
      startAt: toDate(instantFromIso('2026-06-10T15:00:00Z')),
      now: NOW,
      actor: staffActor(a.ownerId),
      audience: 'staff',
    })
  ).id;
});

const call = (name: string, args: Record<string, unknown>) => staff.client.callTool({ name, arguments: args });
const commit = (proposal_id: string) => call('commit_proposal', { proposal_id });
const prepareAndCommit = async (name: string, args: Record<string, unknown>) => {
  const p = await call(name, args);
  expect(errorOf(p), `prepare ${name}`).toBeNull();
  const proposal = p.structuredContent as Proposal;
  const c = await commit(proposal.proposal_id);
  expect(errorOf(c), `commit ${name}`).toBeNull();
  return { proposal, result: (c.structuredContent as Committed).result };
};
const events = (id: string) => prisma.appointmentEvent.findMany({ where: { appointmentId: id }, orderBy: { createdAt: 'asc' } });

describe('prepare_reschedule', () => {
  it('moves the visit to another stylist and time; the event names the person and the mcp channel', async () => {
    const { proposal, result } = await prepareAndCommit('prepare_reschedule', { appointment_id: appt, start: '2026-06-11 15:00', provider_id: priya });
    expect(proposal.summary).toBe('Move Maria Gomez — Cut from Dana to Priya, Wed 10 Jun, 10:00 am → Thu 11 Jun, 3:00 pm.');
    expect(result).toMatchObject({ appointment_id: appt, provider_id: priya, to: { iso: '2026-06-11T15:00:00-05:00' }, end: { iso: '2026-06-11T15:45:00-05:00' } });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appt } });
    expect(row.providerId).toBe(priya);
    expect(row.startAt).toEqual(toDate(instantFromIso('2026-06-11T20:00:00Z')));
    const moved = (await events(appt)).find((e) => e.type === 'rescheduled')!;
    expect(moved).toMatchObject({ actor: 'staff', actorRef: a.staffId, channel: 'mcp' });
  });

  it('same time, different stylist, is a REASSIGNMENT — the sick-stylist move — and the event names the mcp channel', async () => {
    const { proposal, result } = await prepareAndCommit('prepare_reschedule', { appointment_id: appt, start: '2026-06-10 10:00', provider_id: priya });
    expect(proposal.summary).toBe('Move Maria Gomez — Cut from Dana to Priya, Wed 10 Jun, 10:00 am (same time).');
    expect(result).toMatchObject({ appointment_id: appt, provider_id: priya, from: { iso: '2026-06-10T10:00:00-05:00' }, to: { iso: '2026-06-10T10:00:00-05:00' } });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appt } });
    expect(row.providerId).toBe(priya);
    expect(row.startAt).toEqual(toDate(instantFromIso('2026-06-10T15:00:00Z')));
    const ev = (await events(appt)).at(-1)!;
    expect(ev).toMatchObject({ actor: 'staff', actorRef: a.staffId, channel: 'mcp' });
    expect(ev.type).toMatch(/provider|reassign/);
  });

  it('same stylist, time inside its own footprint, is allowed (the visit is not its own clash)', async () => {
    const { result } = await prepareAndCommit('prepare_reschedule', { appointment_id: appt, start: '2026-06-10 10:15' });
    expect(result).toMatchObject({ provider_id: dana, to: { iso: '2026-06-10T10:15:00-05:00' } });
  });

  it('refuses: a taken time, an unqualified stylist, a visit in the chair, an unknown id', async () => {
    await bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: priya,
      serviceIds: [cut],
      startAt: toDate(instantFromIso('2026-06-11T20:00:00Z')),
      now: NOW,
      actor: staffActor(a.ownerId),
      audience: 'staff',
    });
    expect(errorOf(await call('prepare_reschedule', { appointment_id: appt, start: '2026-06-11 15:00', provider_id: priya }))).toMatchObject({ error: 'SLOT_TAKEN', field: 'start' });
    // Tess CAN do a Cut, so NOT_QUALIFIED needs a Colour.
    const colourAppt = await bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: dana,
      serviceIds: [colour],
      clientId: maria,
      startAt: toDate(instantFromIso('2026-06-11T18:00:00Z')), // 13:00 CDT, after the lunch break: a Colour is long
      now: NOW,
      actor: staffActor(a.ownerId),
      audience: 'staff',
    });
    expect(errorOf(await call('prepare_reschedule', { appointment_id: colourAppt.id, start: '2026-06-12 10:00', provider_id: tess }))).toMatchObject({ error: 'NOT_QUALIFIED', field: 'provider_id', next: { tool: 'list_providers' } });

    clock = toDate(instantFromIso('2026-06-10T15:05:00Z'));
    await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt, to: 'checked_in', actor: staffActor(a.ownerId), now: clock });
    await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt, to: 'in_progress', actor: staffActor(a.ownerId), now: clock });
    expect(errorOf(await call('prepare_reschedule', { appointment_id: appt, start: '2026-06-12 10:00' }))).toMatchObject({ error: 'INVALID_TRANSITION', next: { tool: 'get_appointment' } });
    expect(errorOf(await call('prepare_reschedule', { appointment_id: 'nope', start: '2026-06-12 10:00' }))).toMatchObject({ error: 'NOT_FOUND', field: 'appointment_id' });
  });

  it('STALE: cancelled at the desk between preview and commit → refused by the table, nothing moved', async () => {
    const { proposal_id } = (await call('prepare_reschedule', { appointment_id: appt, start: '2026-06-11 15:00' })).structuredContent as Proposal;
    await transitionAppointment(prisma, {
      businessId: a.businessId,
      appointmentId: appt,
      to: 'cancelled',
      cancellation: 'derive',
      actor: staffActor(a.ownerId),
      now: NOW,
      reason: 'desk got there first',
    });
    const r = await commit(proposal_id);
    expect(errorOf(r)).toMatchObject({ error: 'INVALID_TRANSITION', next: { tool: 'get_appointment' } });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appt } });
    expect(row.status).toBe('cancelled');
    expect(row.startAt).toEqual(toDate(instantFromIso('2026-06-10T15:00:00Z')));
  });
});

describe('prepare_cancel', () => {
  it('cancels outside the cutoff, tells the client by default, and the event carries the reason and the channel', async () => {
    const { proposal, result } = await prepareAndCommit('prepare_cancel', { appointment_id: appt, reason: 'client called, stuck at work' });
    expect(proposal.summary).toBe('Cancel Maria Gomez — Cut with Dana, Wed 10 Jun, 10:00 am (client called, stuck at work). Maria will be texted.');
    expect(result).toEqual({ appointment_id: appt, status: 'cancelled', client_told: true });
    const ev = (await events(appt)).at(-1)!;
    expect(ev).toMatchObject({ actor: 'staff', actorRef: a.staffId, channel: 'mcp', reason: 'client called, stuck at work' });
    expect(await prisma.notificationOutbox.count({ where: { appointmentId: appt, template: { contains: 'cancel' } } })).toBe(1);
  });

  it('inside the cutoff the preview says "late", and tell_client false sends nothing', async () => {
    clock = toDate(instantFromIso('2026-06-10T14:30:00Z')); // 30 min before, cutoff is 120
    const { proposal, result } = await prepareAndCommit('prepare_cancel', { appointment_id: appt, reason: 'no reason given', tell_client: false });
    expect(proposal.summary).toMatch(/Counts as a late cancellation\. Maria will not be told\.$/);
    expect(result).toMatchObject({ status: 'cancelled_late', client_told: false });
    expect(await prisma.notificationOutbox.count({ where: { appointmentId: appt, template: { contains: 'cancel' } } })).toBe(0);
  });

  it('a finished visit cannot be cancelled; a blank reason is refused by the schema', async () => {
    clock = toDate(instantFromIso('2026-06-10T15:05:00Z'));
    for (const to of ['checked_in', 'in_progress', 'completed'] as const) {
      await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt, to, actor: staffActor(a.ownerId), now: clock });
    }
    expect(errorOf(await call('prepare_cancel', { appointment_id: appt, reason: 'x' }))).toMatchObject({ error: 'INVALID_TRANSITION', next: { tool: 'get_appointment' } });
    expect(errorOf(await call('prepare_cancel', { appointment_id: appt, reason: '' }))).toMatchObject({ error: 'SDK' });
  });
});

describe('prepare_status_change', () => {
  it('walks check-in → in the chair → finished, each committed, each event on the mcp channel', async () => {
    clock = toDate(instantFromIso('2026-06-10T15:02:00Z'));
    const a1 = await prepareAndCommit('prepare_status_change', { appointment_id: appt, to: 'checked_in' });
    expect(a1.proposal.summary).toBe('Mark Maria Gomez — Cut with Dana as checked in.');
    expect(a1.result).toEqual({ appointment_id: appt, from: 'booked', to: 'checked_in' });
    const a2 = await prepareAndCommit('prepare_status_change', { appointment_id: appt, to: 'in_progress' });
    expect(a2.result).toMatchObject({ from: 'checked_in', to: 'in_progress' });
    const a3 = await prepareAndCommit('prepare_status_change', { appointment_id: appt, to: 'completed' });
    expect(a3.result).toMatchObject({ from: 'in_progress', to: 'completed' });
    const evs = await events(appt);
    expect(evs.filter((e) => e.type === 'status_changed')).toHaveLength(3);
    expect(evs.filter((e) => e.type === 'status_changed').every((e) => e.channel === 'mcp' && e.actorRef === a.staffId)).toBe(true);
  });

  it('a no-show names its ordinal; a move the table forbids is INVALID_TRANSITION; a stale expected_from is PROPOSAL_STALE', async () => {
    // Before the appointment starts, a no-show is refused by the table ('before-appointment-start') —
    // an early check-in is NOT, because clients arrive early.
    const early = errorOf(await call('prepare_status_change', { appointment_id: appt, to: 'no_show' }));
    expect(early).toMatchObject({ error: 'INVALID_TRANSITION', field: 'to', next: { tool: 'get_appointment' } });
    expect(early?.message).toMatch(/before-appointment-start/);

    clock = toDate(instantFromIso('2026-06-10T15:30:00Z'));
    const p = await call('prepare_status_change', { appointment_id: appt, to: 'no_show' });
    expect((p.structuredContent as Proposal).summary).toBe('Mark Maria Gomez — Cut with Dana, Wed 10 Jun, 10:00 am, as a no-show (their 1st in 12 months).');

    // Desk checks her in after the no-show was previewed: the preview's expected_from is wrong, nothing is overwritten.
    await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: appt, to: 'checked_in', actor: staffActor(a.ownerId), now: clock });
    const r = await commit((p.structuredContent as Proposal).proposal_id);
    expect(errorOf(r)).toMatchObject({ error: 'PROPOSAL_STALE', next: { tool: 'prepare_status_change' } });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt } })).status).toBe('checked_in');
  });
});

describe('prepare_waitlist_entry', () => {
  it('adds an entry with preferences, then list_waitlist shows it', async () => {
    const { proposal, result } = await prepareAndCommit('prepare_waitlist_entry', {
      client_id: maria,
      service_ids: [cut],
      from_day: '2026-06-15',
      to_day: '2026-06-19',
      provider_id: dana,
      day_parts: ['afternoon', 'friday'],
    });
    expect(proposal.summary).toBe('Add Maria Gomez to the waitlist for Cut, Mon 15 Jun – Fri 19 Jun, afternoon friday, with Dana.');
    expect(result).toMatchObject({ from_day: '2026-06-15', to_day: '2026-06-19' });
    const listed = (await call('list_waitlist', { day: '2026-06-17' })).structuredContent as { entries: { entry_id: string; day_parts: string[]; provider_ids: string[] }[] };
    expect(listed.entries.find((e) => e.entry_id === result.entry_id)).toMatchObject({ day_parts: ['afternoon', 'friday'], provider_ids: [dana] });
  });

  it('refuses an inverted range, an unknown client, an unknown day part', async () => {
    expect(errorOf(await call('prepare_waitlist_entry', { client_id: maria, service_ids: [cut], from_day: '2026-06-19', to_day: '2026-06-15' }))).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'to_day' });
    expect(errorOf(await call('prepare_waitlist_entry', { client_id: 'nope', service_ids: [cut], from_day: '2026-06-15', to_day: '2026-06-19' }))).toMatchObject({ error: 'NOT_FOUND', field: 'client_id' });
    expect(errorOf(await call('prepare_waitlist_entry', { client_id: maria, service_ids: [cut], from_day: '2026-06-15', to_day: '2026-06-19', day_parts: ['lunchtime'] }))).toMatchObject({ error: 'SDK' });
  });
});
