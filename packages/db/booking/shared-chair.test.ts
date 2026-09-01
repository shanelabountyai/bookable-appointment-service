/**
 * A-063 — ONE CLIENT, TWO APPOINTMENTS, TWO CHAIRS (RES-02, D-17, D-30).
 *
 * The supported way to do "cut with Dana, then colour with Priya" is two
 * appointments: two providers never collide on the provider axis, so the
 * booking is accepted twice and the desk gets what it asked for. But the chair
 * hold spans the whole ENVELOPE — body plus buffers (RES-02) — so the cut's
 * after-buffer and the colour's before-buffer overlap, and for those minutes
 * the same client holds two of four chairs. The room then reports full and
 * refuses a real client on the authority of a chair with nobody in it.
 *
 * This file's FIRST job was to prove that is reachable against the real seeded
 * catalogue rather than only against hand-built buffers — the rule A-034 set
 * for itself. It is: Cut (after 10) followed by Colour (before 10) is a
 * twenty-minute double-hold, and both are services the seed ships.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { seedSetup } from '../settings';
import { bookAppointment } from './book';
import { findFreeResource } from './resources';

const prisma = new PrismaClient();
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));

/** Saturday, the busiest day the seed's week has. */
const NOW = at('2026-06-13T08:00:00-05:00');

let businessId: string;
let chairTypeId: string;
let providerByName: Record<string, string> = {};
let serviceByName: Record<string, string> = {};

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const setup = await seedSetup(prisma);
  businessId = setup.businessId;

  const providers = await prisma.provider.findMany({ where: { businessId } });
  providerByName = Object.fromEntries(providers.map((p) => [p.displayName, p.id]));
  const services = await prisma.service.findMany({ where: { businessId } });
  serviceByName = Object.fromEntries(services.map((s) => [s.name, s.id]));
  const chairType = await prisma.resourceType.findFirstOrThrow({ where: { businessId, name: 'Chair' } });
  chairTypeId = chairType.id;
});

const client = (name: string) => prisma.client.create({ data: { businessId, name } });

const book = (providerName: string, serviceName: string, startIso: string, clientId: string) =>
  bookAppointment(prisma, {
    businessId,
    providerId: providerByName[providerName]!,
    serviceIds: [serviceByName[serviceName]!],
    clientId,
    startAt: at(startIso),
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
  });

/** Which chairs are held over an instant range, and by whom. */
async function holdsOver(startIso: string, endIso: string) {
  return prisma.appointmentResourceHold.findMany({
    where: {
      businessId,
      blockedStart: { lt: at(endIso) },
      blockedEnd: { gt: at(startIso) },
      status: { notIn: ['cancelled', 'cancelled_late'] },
    },
    include: { appointment: { select: { clientId: true } } },
  });
}

describe('A-063 — the chair follows the client', () => {
  it('the seeded catalogue really does produce a twenty-minute double hold', async () => {
    const nadia = await client('Nadia Okafor');
    // Cut: 45 minutes, buffers 0/10 -> envelope 13:00-13:55.
    await book('Dana', 'Cut', '2026-06-13T13:00:00-05:00', nadia.id);
    // Colour: 120 minutes, buffers 10/20 -> envelope 13:35-16:05.
    await book('Priya', 'Colour', '2026-06-13T13:45:00-05:00', nadia.id);

    const held = await holdsOver('2026-06-13T13:45:00-05:00', '2026-06-13T13:55:00-05:00');
    expect(held).toHaveLength(2);
    expect(new Set(held.map((h) => h.appointment.clientId))).toEqual(new Set([nadia.id]));
    // THE DEFECT: one client, one body, two chairs.
    expect(new Set(held.map((h) => h.resourceId)).size).toBe(1);
  });

  /**
   * CHECKPOINT 5, FINDING 3. The test below this one asks `findFreeResource`
   * — the CHOOSER — and passed throughout. It could not see that the room's
   * AVAILABILITY model still counted holds rather than chairs, so the client
   * was never offered the time to be chosen for. The chooser is asked at
   * submit; this is asked before anything reaches the screen.
   */
  it('still OFFERS the room a shared chair leaves free', async () => {
    // Two chairs, so the room binds without needing eight clients.
    const spare = await prisma.resource.findMany({
      where: { businessId, active: true },
      orderBy: { name: 'asc' },
      skip: 2,
    });
    await prisma.resource.updateMany({ where: { id: { in: spare.map((r) => r.id) } }, data: { active: false } });

    const nadia = await client('Nadia Okafor');
    await book('Dana', 'Cut', '2026-06-13T13:00:00-05:00', nadia.id);
    await book('Priya', 'Colour', '2026-06-13T13:45:00-05:00', nadia.id);

    // One chair of the two is hers; the other is empty. Marcus is free and so
    // is a chair, so Ben is bookable — and was refused before this was fixed,
    // because her two holds counted as two chairs.
    const held = await holdsOver('2026-06-13T13:45:00-05:00', '2026-06-13T13:55:00-05:00');
    expect(new Set(held.map((h) => h.resourceId)).size).toBe(1);

    const ben = await client('Ben Rios');
    const booked = await book('Marcus', 'Cut', '2026-06-13T13:45:00-05:00', ben.id);
    expect(booked.id).toBeTruthy();
  });

  it('does not let one client fill the room and refuse a real one', async () => {
    const nadia = await client('Nadia Okafor');
    await book('Dana', 'Cut', '2026-06-13T13:00:00-05:00', nadia.id);
    await book('Priya', 'Colour', '2026-06-13T13:45:00-05:00', nadia.id);

    const b = await client('Ben Rios');
    const c = await client('Cara Lund');
    await book('Marcus', 'Cut', '2026-06-13T13:30:00-05:00', b.id);
    await book('Tess', 'Cut', '2026-06-13T13:30:00-05:00', c.id);

    // Three clients are in a four-chair room.
    const held = await holdsOver('2026-06-13T13:45:00-05:00', '2026-06-13T13:55:00-05:00');
    expect(new Set(held.map((h) => h.appointment.clientId)).size).toBe(3);

    const free = await findFreeResource(prisma, {
      businessId,
      resourceTypeId: chairTypeId,
      start: at('2026-06-13T13:45:00-05:00'),
      end: at('2026-06-13T13:55:00-05:00'),
    });
    expect(free).not.toBeNull();
  });

  it('does NOT share when the bodies overlap — D-17\'s mother and daughter are two people', async () => {
    // One client record, one phone number, two people in the room at once.
    // The relaxation above must not reach this: it is keyed on the holder, and
    // the holder is exactly what these two have in common.
    const shared = await client('The Okafors');
    await book('Dana', 'Cut', '2026-06-13T13:00:00-05:00', shared.id);
    await book('Marcus', 'Cut', '2026-06-13T13:00:00-05:00', shared.id);

    const held = await holdsOver('2026-06-13T13:00:00-05:00', '2026-06-13T13:45:00-05:00');
    expect(held).toHaveLength(2);
    expect(new Set(held.map((h) => h.resourceId)).size).toBe(2);
  });

  it('the database refuses two bodies in one chair even for one holder', async () => {
    // Straight at the constraint, bypassing the chooser entirely — the point of
    // `appointment_resource_body_no_overlap` is that a chooser bug lands as a
    // refusal rather than as a client sitting in somebody\'s lap.
    const shared = await client('The Okafors');
    await book('Dana', 'Cut', '2026-06-13T13:00:00-05:00', shared.id);
    await book('Marcus', 'Cut', '2026-06-13T13:00:00-05:00', shared.id);

    const [a, b] = await holdsOver('2026-06-13T13:00:00-05:00', '2026-06-13T13:45:00-05:00');
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "AppointmentResourceHold" SET "resourceId" = $1 WHERE "id" = $2',
        a!.resourceId,
        b!.id,
      ),
    ).rejects.toThrow(/23P01|appointment_resource_body_no_overlap/);
  });

  it('nobody named is nobody shared — two anonymous walk-ins take two chairs', async () => {
    // `holderKey` is COALESCEd to the appointment id precisely so a nullable
    // client cannot make every unnamed appointment in the salon one holder.
    const anon = (providerName: string, serviceName: string, startIso: string) =>
      bookAppointment(prisma, {
        businessId,
        providerId: providerByName[providerName]!,
        serviceIds: [serviceByName[serviceName]!],
        clientId: null,
        startAt: at(startIso),
        now: NOW,
        actor: ACTOR,
        audience: 'staff',
      });

    await anon('Dana', 'Cut', '2026-06-13T13:00:00-05:00');
    await anon('Priya', 'Colour', '2026-06-13T13:45:00-05:00');

    const held = await holdsOver('2026-06-13T13:45:00-05:00', '2026-06-13T13:55:00-05:00');
    expect(held).toHaveLength(2);
    expect(new Set(held.map((h) => h.resourceId)).size).toBe(2);
  });

  it('a shared chair is still refused to a stranger', async () => {
    // Sharing widens what ONE holder may do and nothing else. The chair Nadia
    // keeps for her colour is occupied, and the room must go on saying so.
    const nadia = await client('Nadia Okafor');
    await book('Dana', 'Cut', '2026-06-13T13:00:00-05:00', nadia.id);
    await book('Priya', 'Colour', '2026-06-13T13:45:00-05:00', nadia.id);

    const hers = (await holdsOver('2026-06-13T14:30:00-05:00', '2026-06-13T14:45:00-05:00'))[0]!.resourceId;
    const stranger = await findFreeResource(prisma, {
      businessId,
      resourceTypeId: chairTypeId,
      start: at('2026-06-13T14:30:00-05:00'),
      end: at('2026-06-13T14:45:00-05:00'),
    });
    expect(stranger).not.toBeNull();
    expect(stranger).not.toBe(hers);
  });
});
