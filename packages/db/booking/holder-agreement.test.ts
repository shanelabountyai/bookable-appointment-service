/**
 * A-083 — THE OFFER AND THE WRITE, ASKED ABOUT THE SAME CLIENT.
 *
 * A-082 gave the room's question an input — WHO would be sitting in the chair
 * — and threaded it through every caller holding an APPOINTMENT. The two it
 * missed hold a CLIENT and no appointment yet, which is exactly what a booking
 * panel is: `/staff/book` resolved the client five lines above the call and
 * passed `null`, and `anyProviderTimes` had no client field at all. `null` is
 * the STRICT question, so those callers compiled, passed every test, and
 * silently asked a question they already knew the answer to.
 *
 * The offer was then STRICTER than the write on the desk's own screen: the
 * chair her other appointment holds is hers to share (A-063), and she was told
 * "every chair is taken then" about it. The only way through is a BOOK-05
 * override, which by D-30 holds no chair at all — so one wrongly refused offer
 * becomes one client sitting in a chair the room believes is empty, and the
 * room's model of the day is then wrong for everybody else.
 *
 * THIS IS AN AGREEMENT TEST, WHICH IS CHECKPOINT 6'S WHOLE LESSON. Two
 * separate assertions ("the offer says X", "the write says Y") both pass while
 * X and Y disagree — that is how the read model and the chooser drifted apart
 * for fifty items. So the assertion below is that the two answers to ONE
 * operational question are EQUAL, over every candidate whose fate the ROOM
 * decided, in a room interesting enough for them to differ.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { type Instant, instant, instantFromIso, toDate } from '../../core/time';
import { computeDaySlots } from '../scheduling';
import { resetDatabase } from '../testing';
import { seedSetup } from '../settings';
import { anyProviderTimes } from './any-provider';
import { bookAppointment } from './book';
import { findFreeResource } from './resources';
import { walkInOptions } from './walk-in';

const prisma = new PrismaClient();
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));
const MIN = 60_000;

/** Saturday, the busiest day the seed's week has. */
const DAY = '2026-06-13';
const NOW = at('2026-06-13T08:00:00-05:00');
/** The instant the desk is refused. Her cut's after-buffer ends 13:55; a
 *  colour starting here has a before-buffer reaching back to 13:35, so the two
 *  ENVELOPES overlap and the two BODIES do not — A-063's shareable chair. */
const CONTESTED = '2026-06-13T13:45:00-05:00';

let businessId: string;
let chairTypeId: string;
let providerByName: Record<string, string> = {};
let serviceByName: Record<string, string> = {};
let colour: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number };
let nadiaId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const book = (providerName: string, serviceName: string, startIso: string, clientId: string | null) =>
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

beforeEach(async () => {
  await resetDatabase(prisma);
  const setup = await seedSetup(prisma);
  businessId = setup.businessId;

  const providers = await prisma.provider.findMany({ where: { businessId } });
  providerByName = Object.fromEntries(providers.map((p) => [p.displayName, p.id]));
  const services = await prisma.service.findMany({ where: { businessId } });
  serviceByName = Object.fromEntries(services.map((s) => [s.name, s.id]));
  colour = services.find((s) => s.name === 'Colour')!;
  chairTypeId = (await prisma.resourceType.findFirstOrThrow({ where: { businessId, name: 'Chair' } })).id;

  // TWO chairs, because a room that cannot bind cannot disagree with anything
  // — and a fixture with no room in it is what let A-069 through (CLAUDE.md).
  const spare = await prisma.resource.findMany({ where: { businessId, active: true }, orderBy: { name: 'asc' }, skip: 2 });
  await prisma.resource.updateMany({ where: { id: { in: spare.map((r) => r.id) } }, data: { active: false } });

  // Chair 1: Nadia is in it for a cut (envelope 13:00–13:55).
  nadiaId = (await prisma.client.create({ data: { businessId, name: 'Nadia Okafor' } })).id;
  await book('Dana', 'Cut', '2026-06-13T13:00:00-05:00', nadiaId);
  // Chair 2: somebody else, for the whole afternoon (envelope 13:35–16:05).
  const ben = await prisma.client.create({ data: { businessId, name: 'Ben Rios' } });
  await book('Marcus', 'Colour', CONTESTED, ben.id);
});

/** Her colour with Priya, as the panel asks for it: with a holder, or with the
 *  `null` the panel actually passed. */
const offers = (holderKey: string | null, now = NOW) =>
  computeDaySlots(prisma, {
    businessId,
    providerId: providerByName['Priya']!,
    serviceIds: [serviceByName['Colour']!],
    day: DAY,
    now,
    audience: 'staff',
    holderKey,
  });

/** The envelope and body a candidate at this instant would occupy — the same
 *  arithmetic the engine does, asserted against the engine's own numbers below
 *  so it cannot drift into agreeing with itself. */
const rangesAt = (start: Instant) => ({
  bodyStart: toDate(start),
  bodyEnd: toDate(instant(start + colour.durationMinutes * MIN)),
  envStart: toDate(instant(start - colour.bufferBeforeMinutes * MIN)),
  envEnd: toDate(instant(start + (colour.durationMinutes + colour.bufferAfterMinutes) * MIN)),
});

describe('A-083 — the desk names the client, so the room is asked about her', () => {
  it('offers the shareable chair to her and withholds it from a stranger', async () => {
    const anonymous = await offers(null);
    const hers = await offers(nadiaId);

    const contested = instantFromIso(CONTESTED);
    // Refused for the ROOM, with the reason named — an absence assertion that
    // does not check the reason passes for a dozen wrong reasons (CLAUDE.md).
    expect(anonymous.excluded.find((e) => e.candidateStart === contested)?.reasons).toEqual(['no-resource-free']);
    expect(hers.slots.map((s) => s.start)).toContain(contested);
    expect(hers.slots.length).toBeGreaterThan(anonymous.slots.length);
  });

  it('AGREEMENT — every candidate the room decided, offered exactly when the chooser would seat it', async () => {
    const hers = await offers(nadiaId);

    // Only the candidates whose fate the ROOM decided: `computeSlotsIn` adds
    // `no-resource-free` to candidates that already passed the engine, so this
    // set is precisely "she is free, the room may not be".
    const roomRefused = hers.excluded.filter((e) => e.reasons.length === 1 && e.reasons[0] === 'no-resource-free');
    const decided = [
      ...hers.slots.map((s) => ({ start: s.start, label: s.label.time, offered: true })),
      ...roomRefused.map((e) => ({ start: e.candidateStart, label: e.label.time, offered: false })),
    ].sort((a, b) => a.start - b.start);
    expect(decided.length).toBeGreaterThan(1);

    // The test's own arithmetic, checked against the engine's ranges once, so
    // the loop below is not two copies of the same mistake.
    const sample = hers.slots[0]!;
    expect(rangesAt(sample.start)).toEqual({
      bodyStart: toDate(sample.start),
      bodyEnd: toDate(sample.end),
      envStart: toDate(sample.blockedStart),
      envEnd: toDate(sample.blockedEnd),
    });

    for (const candidate of decided) {
      const r = rangesAt(candidate.start);
      const seat = await findFreeResource(prisma, {
        businessId,
        resourceTypeId: chairTypeId,
        start: r.envStart,
        end: r.envEnd,
        holder: { key: nadiaId, bodyStart: r.bodyStart, bodyEnd: r.bodyEnd },
      });
      // ONE assertion, both answers, labelled — a failure names the time.
      expect({ at: candidate.label, offered: candidate.offered }).toEqual({
        at: candidate.label,
        offered: seat !== null,
      });
    }
  });

  it('and the write really does accept the time the anonymous question withheld', async () => {
    const booked = await book('Priya', 'Colour', CONTESTED, nadiaId);
    expect(booked.id).toBeTruthy();
    // Her chair, not a second one: the offer was right about which chair, too.
    const holds = await prisma.appointmentResourceHold.findMany({
      where: { businessId, status: { notIn: ['cancelled', 'cancelled_late'] }, holderKey: nadiaId },
      select: { resourceId: true },
    });
    expect(holds).toHaveLength(2);
    expect(new Set(holds.map((h) => h.resourceId)).size).toBe(1);
  });

  it('"anyone on Thursday" is still a question about her', async () => {
    const args = { businessId, serviceIds: [serviceByName['Colour']!], day: DAY, now: NOW, audience: 'staff' as const };
    const anonymous = await anyProviderTimes(prisma, args);
    const hers = await anyProviderTimes(prisma, { ...args, holderKey: nadiaId });

    const contested = at(CONTESTED).toISOString();
    expect(anonymous.map((t) => t.at.toISOString())).not.toContain(contested);
    expect(hers.map((t) => t.at.toISOString())).toContain(contested);
  });

  it('and so is a walk-in the desk has named', async () => {
    // From 13:45 on: the stranger at the door waits, she does not.
    const args = { businessId, serviceIds: [serviceByName['Colour']!], day: DAY, now: at(CONTESTED) };
    const anonymous = await walkInOptions(prisma, args);
    const hers = await walkInOptions(prisma, { ...args, holderKey: nadiaId });

    const soonest = (options: { providerId: string; startAt: Date }[]) =>
      options.find((o) => o.providerId === providerByName['Priya'])?.startAt.toISOString();
    expect(soonest(hers)).toBe(at(CONTESTED).toISOString());
    expect(soonest(anonymous)).not.toBe(at(CONTESTED).toISOString());
  });
});
