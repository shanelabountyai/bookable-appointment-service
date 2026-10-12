/**
 * M-006 — get_day and get_appointment (PRD §7).
 *
 * `allowed_actions` is asserted two ways: concretely for a booked visit
 * tomorrow and for a finished one, and by EQUALITY against the transition
 * module asked with the same context — the tool must mirror the table, never
 * paraphrase it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { availableTransitions, canCancel, canReschedule, staffCancellationStatus } from '@bookable/core/scheduling';
import { fromDate, instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { transitionAppointment } from '@bookable/db/appointments';
import { bookAppointment } from '@bookable/db/booking';
import { setRunningLate } from '@bookable/db/day';
import { resetDatabase } from '@bookable/db/testing';
import { connectAs, errorOf, type CallResult, type Connected } from '../testing/connect';
import { seedTwoSalons, type Salon } from '../testing/two-salons';
import { STATUS_ACTIONS } from './get-appointment';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z')); // Tue 09:00 CDT
const deps = { prisma, now: () => NOW };
const WED = '2026-06-10';
const PHONE = '+13125550142';

interface DayOut {
  columns: {
    provider_id: string;
    name: string;
    closed: boolean;
    running_late_minutes: number | null;
    appointments: { appointment_id: string; status: string; client_name: string | null; start: { label: string; iso: string }; services: string[]; late_minutes: number }[];
  }[];
}
interface Action {
  action: string;
  tool: string;
  to?: string;
}
interface ApptOut {
  status: string;
  allowed_actions: Action[];
  history: { type: string; by: string | null }[];
  client_name: string | null;
  note: string | null;
}

let a: Salon;
let conn: Connected;
let dana: string;
let cut: string;
let clientId: string;
let apptId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
  conn = await connectAs(prisma, { businessId: a.businessId, staffUserId: a.staffId, issuedById: a.ownerId }, deps);
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
  clientId = (
    await prisma.client.create({
      data: { businessId: a.businessId, name: 'Maria Gomez', phone: PHONE, notes: 'SECRET allergy note' },
      select: { id: true },
    })
  ).id;
  apptId = (
    await bookAppointment(prisma, {
      businessId: a.businessId,
      providerId: dana,
      serviceIds: [cut],
      clientId,
      startAt: toDate(instantFromIso('2026-06-10T15:00:00Z')), // Wed 10:00 CDT
      now: NOW,
      actor: staffActor(a.ownerId),
      audience: 'staff',
      notes: 'wants it shorter this time',
    })
  ).id;
});

const call = (name: string, args: Record<string, unknown>) => conn.client.callTool({ name, arguments: args });
const textOf = (r: CallResult) => (r.content as { text: string }[])[0]!.text;

describe('get_day', () => {
  it('shows every column, the booked visit under Dana, and never a phone or a note', async () => {
    await setRunningLate(prisma, { businessId: a.businessId, providerId: dana, day: WED, minutes: 15, actor: staffActor(a.ownerId), now: NOW });
    const r = await call('get_day', { day: WED });
    expect(errorOf(r)).toBeNull();
    const data = r.structuredContent as DayOut;
    expect(data.columns.map((c) => c.name).sort()).toEqual(['Dana', 'Marcus', 'Priya', 'Tess'].sort());
    const col = data.columns.find((c) => c.provider_id === dana)!;
    expect(col.running_late_minutes).toBe(15);
    expect(col.appointments).toHaveLength(1);
    expect(col.appointments[0]).toMatchObject({
      appointment_id: apptId,
      status: 'booked',
      client_name: 'Maria Gomez',
      services: ['Cut'],
      start: { label: 'Wed 10 Jun, 10:00 am', iso: '2026-06-10T10:00:00-05:00' },
      late_minutes: 15,
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain(PHONE.slice(-4));
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('shorter this time');
    expect(textOf(r)).toBe('Wed 10 Jun: 1 appointment for 4 stylists; Dana running 15 min late.');
  });

  it('one stylist with provider_id; a closed day has closed columns and nothing on them', async () => {
    const one = (await call('get_day', { day: WED, provider_id: dana })).structuredContent as DayOut;
    expect(one.columns.map((c) => c.name)).toEqual(['Dana']);
    const sunday = (await call('get_day', { day: '2026-06-14' })).structuredContent as DayOut;
    expect(sunday.columns.every((c) => c.closed && c.appointments.length === 0)).toBe(true);
  });

  it('refuses a malformed day and an unknown stylist, naming the field', async () => {
    expect(errorOf(await call('get_day', { day: 'Wednesday' }))).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'day' });
    expect(errorOf(await call('get_day', { day: WED, provider_id: 'nope' }))).toMatchObject({ error: 'NOT_FOUND', field: 'provider_id', next: { tool: 'list_providers' } });
  });
});

describe('get_appointment', () => {
  it('a booked visit tomorrow: cancel (as cancelled, outside the cutoff) and reschedule, no check-in yet; history names who booked it', async () => {
    const r = await call('get_appointment', { appointment_id: apptId });
    expect(errorOf(r)).toBeNull();
    const data = r.structuredContent as ApptOut;
    expect(data.status).toBe('booked');
    expect(data.allowed_actions).toEqual(
      expect.arrayContaining([
        { action: 'cancel', tool: 'prepare_cancel', to: 'cancelled' },
        { action: 'reschedule', tool: 'prepare_reschedule' },
      ]),
    );
    expect(data.allowed_actions.map((x) => x.action)).not.toContain('complete');
    expect(data.history.map((h) => h.type)).toContain('booked');
    expect(data.history.find((h) => h.type === 'booked')!.by).toBe('Sam');
    expect(data.client_name).toBe('Maria Gomez');
    expect(data.note).toBe('wants it shorter this time');
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(JSON.stringify(r)).not.toContain(PHONE.slice(-4));
    expect(textOf(r)).toMatch(/^Maria Gomez — Cut with Dana, Wed 10 Jun, 10:00 am\. Status booked; can: /);
  });

  it('EQUALITY: allowed_actions is exactly what the transition module says for the same context, at every status we can reach', async () => {
    const check = async () => {
      const data = (await call('get_appointment', { appointment_id: apptId })).structuredContent as ApptOut;
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: apptId }, select: { status: true, startAt: true, endAt: true } });
      const detailCutoff = (await prisma.business.findUniqueOrThrow({ where: { id: a.businessId } })).cancellationCutoffMinutes;
      const context = {
        actor: 'staff' as const,
        now: fromDate(NOW),
        startAt: fromDate(row.startAt),
        endAt: fromDate(row.endAt),
        cancellationCutoffMinutes: detailCutoff,
        reason: 'placeholder',
      };
      const expected: Action[] = [];
      for (const to of availableTransitions(row.status, context)) {
        const action = (STATUS_ACTIONS as Record<string, string>)[to];
        if (action) expected.push({ action, tool: 'prepare_status_change', to });
      }
      if (canCancel(row.status, context)) expected.push({ action: 'cancel', tool: 'prepare_cancel', to: staffCancellationStatus(row.status, context) });
      if (canReschedule(row.status, context).allowed) expected.push({ action: 'reschedule', tool: 'prepare_reschedule' });
      expect(data.allowed_actions, row.status).toEqual(expected);
      return row.status;
    };

    expect(await check()).toBe('booked');
    const late = toDate(instantFromIso('2026-06-10T15:05:00Z')); // after start, so check-in and start are open
    for (const to of ['checked_in', 'in_progress', 'completed'] as const) {
      await transitionAppointment(prisma, { businessId: a.businessId, appointmentId: apptId, to, actor: staffActor(a.ownerId), now: late });
      expect(await check()).toBe(to);
    }
    const done = (await call('get_appointment', { appointment_id: apptId })).structuredContent as ApptOut;
    expect(done.allowed_actions.map((x) => x.action)).not.toContain('reschedule');
  });

  it('an unknown id is NOT_FOUND pointing at get_day', async () => {
    expect(errorOf(await call('get_appointment', { appointment_id: 'nope' }))).toMatchObject({ error: 'NOT_FOUND', field: 'appointment_id', next: { tool: 'get_day' } });
  });
});
