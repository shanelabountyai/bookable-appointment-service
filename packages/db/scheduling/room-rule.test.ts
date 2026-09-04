/**
 * A-084 — ONE ROOM RULE, THREE CALLERS, AND A TEST THAT MAKES THEM SAY IT.
 *
 * "Can this visit sit somewhere?" is asked in three places, for three different
 * reasons, and nothing before this file ever asked whether the three agreed:
 *
 *   - `findFreeResource` — what the WRITE accepts. A Prisma `where`, and so
 *     unavoidably its own expression of the rule; it is the one that cannot
 *     call the shared predicate, which is exactly why it is in this test.
 *   - `canSeat` — what the SCREEN offers, over `loadSeating`'s `ChairHold`s.
 *   - `planChairs` — where the push SEATS a moved column, over its own
 *     in-memory room, deliberately without asking the database.
 *
 * The first two were pinned together by A-082 and say so in their headers. The
 * third was written as `E && (D || B)` where the other two say `(E && D) || B`
 * — arrangements that agree only where a body overlap implies an envelope
 * overlap. It always does: the hold trigger keeps the body inside the envelope
 * on every branch including A-069's release cut, guarded by a CHECK in a
 * migration three files away and asserted nowhere in TypeScript. Two
 * correct-looking halves agreeing for a reason nobody wrote down is the
 * precondition of checkpoint 6, and this is the item that removes it: all
 * three now route through `seatBlocked`, and this file holds them to it.
 *
 * THE ASSERTION IS EQUALITY, NOT THREE CORRECTNESS CHECKS. Three separate
 * "and this one says false" assertions all pass while the three disagree —
 * which is precisely how the read model and the chooser drifted apart for
 * fifty items (A-083's note). One assertion, one room, every candidate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { fromDate, instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { seedSetup } from '../settings';
import { bookAppointment, findFreeResource } from '../booking';
import { loadRoom, planChairs } from '../day/push-column';
import { canSeat, loadSeating } from './resource-load';

const prisma = new PrismaClient();
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));
const iso = (hhmm: string) => `2026-06-13T${hhmm}:00-05:00`;

/** Saturday, the busiest day the seed's week has. */
const NOW = at('2026-06-13T08:00:00-05:00');

let businessId: string;
let chairTypeId: string;
let chairIds: string[] = [];
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
  chairTypeId = (await prisma.resourceType.findFirstOrThrow({ where: { businessId, name: 'Chair' } })).id;

  // TWO chairs. A one-chair room cannot show sharing and a four-chair room is
  // never binding at this fixture's density — two is the size where the three
  // answers have something to disagree about.
  const all = await prisma.resource.findMany({
    where: { businessId, resourceTypeId: chairTypeId },
    orderBy: { name: 'asc' },
  });
  chairIds = all.slice(0, 2).map((r) => r.id);
  await prisma.resource.updateMany({
    where: { id: { in: all.slice(2).map((r) => r.id) } },
    data: { active: false },
  });
});

const client = (name: string) => prisma.client.create({ data: { businessId, name } });

const book = (providerName: string, serviceName: string, hhmm: string, clientId: string | null) =>
  bookAppointment(prisma, {
    businessId,
    providerId: providerByName[providerName]!,
    serviceIds: [serviceByName[serviceName]!],
    clientId,
    startAt: at(iso(hhmm)),
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
  });

/**
 * A room worth asking about — and the shape of it is the whole test, because a
 * room where the three answers CANNOT differ is a room that agrees with the
 * predicate deleted.
 *
 * Nadia holds one of the two chairs twice: Cut, 45 minutes with buffers 0/10,
 * body 13:00-13:45 and envelope 13:00-13:55; then Colour, 120 minutes with
 * 10/20, body 14:30-16:30 and envelope 14:20-16:50. The seed's real catalogue,
 * and unequal buffers on adjacent visits so a whose-buffer bug cannot hide.
 *
 * The gap between her BODIES and the gap between her ENVELOPES are different
 * spans — 13:45-14:30 against 13:55-14:20 — and that difference is the only
 * place A-063's relaxation can be seen: a visit landing in it overlaps her
 * envelope and not her body, so the chair is hers to share and nobody else's
 * to take. Her two visits BACK TO BACK (the obvious fixture, and the one this
 * file had first) makes her bodies contiguous, and then every probe that
 * touches her envelope touches her body too: all three answers are false for
 * both holders, agreement is vacuous, and dropping the holder from any of the
 * three passes. Ben holds the other chair 13:30-14:25 over exactly that gap,
 * so the room's answer really does turn on who is asking.
 */
async function buildTheRoom() {
  const nadia = await client('Nadia Okafor');
  const ben = await client('Ben Rios');
  await book('Dana', 'Cut', '13:00', nadia.id);
  await book('Priya', 'Colour', '14:30', nadia.id);
  await book('Marcus', 'Cut', '13:30', ben.id);
  return { nadia: nadia.id, ben: ben.id };
}

/**
 * The three answers to "could a visit with this envelope and body be seated?".
 *
 * `planChairs` is asked the way the push asks it: one row that is MOVING to
 * this envelope. Its `before` span never reads for a moving row, and the chair
 * it names is only a preference — the boolean is "is any chair free", which is
 * the same question the other two answer.
 */
async function threeAnswers(args: {
  envelope: { start: string; end: string };
  body: { start: string; end: string };
  holderKey: string | null;
}) {
  const envelope = { start: at(args.envelope.start), end: at(args.envelope.end) };
  const body = { start: at(args.body.start), end: at(args.body.end) };
  const spanOf = (r: { start: Date; end: Date }) => ({ start: fromDate(r.start), end: fromDate(r.end) });

  const write = await findFreeResource(prisma, {
    businessId,
    resourceTypeId: chairTypeId,
    start: envelope.start,
    end: envelope.end,
    holder: { key: args.holderKey, bodyStart: body.start, bodyEnd: body.end },
  });

  const seating = await loadSeating(prisma, {
    businessId,
    resourceTypeId: chairTypeId,
    windowStart: envelope.start,
    windowEnd: envelope.end,
  });

  const room = await loadRoom(prisma, {
    businessId,
    excludeAppointmentIds: [],
    windowStart: fromDate(envelope.start),
    windowEnd: fromDate(envelope.end),
  });
  const planned = planChairs(
    [
      {
        id: 'probe',
        resourceId: chairIds[0]!,
        staying: false,
        before: spanOf(envelope),
        after: spanOf(envelope),
        holderKey: args.holderKey ?? '',
        bodyBefore: spanOf(body),
        bodyAfter: spanOf(body),
      },
    ],
    room,
  );

  return {
    write: write !== null,
    offer: canSeat(seating, spanOf(envelope), spanOf(body), args.holderKey),
    push: !('blocked' in planned),
  };
}

/** Ten minutes of body, on the quarter hour, from 13:00 to 16:00 — every one
 *  of which lands somewhere different in the two chairs above. Buffers of 5
 *  before and 15 after, deliberately unequal, so the envelope is not the body. */
const CANDIDATES = Array.from({ length: 13 }, (_, i) => {
  const minutes = 13 * 60 + i * 15;
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return {
    label: hhmm(minutes),
    body: { start: iso(hhmm(minutes)), end: iso(hhmm(minutes + 10)) },
    envelope: { start: iso(hhmm(minutes - 5)), end: iso(hhmm(minutes + 25)) },
  };
});

describe('A-084 — the write, the offer and the push answer the same room question', () => {
  for (const holder of ['anonymous', 'the client already in a chair'] as const) {
    it(`agrees on every candidate, asked as ${holder}`, async () => {
      const { nadia } = await buildTheRoom();
      const holderKey = holder === 'anonymous' ? null : nadia;

      const disagreements: string[] = [];
      for (const candidate of CANDIDATES) {
        const a = await threeAnswers({ ...candidate, holderKey });
        if (!(a.write === a.offer && a.offer === a.push)) {
          disagreements.push(`${candidate.label}: write=${a.write} offer=${a.offer} push=${a.push}`);
        }
      }
      // ONE assertion. Three separate ones all pass while the three disagree.
      expect(disagreements).toEqual([]);
    });
  }

  /**
   * The guard against a suite that agrees because nothing is ever refused: a
   * room whose three answers are all `true` everywhere would pass the tests
   * above with the predicate deleted.
   */
  it('and the candidates are interesting — the two-chair room refuses some and seats others', async () => {
    await buildTheRoom();
    const answers = await Promise.all(
      CANDIDATES.map(async (c) => (await threeAnswers({ ...c, holderKey: null })).write),
    );
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  /**
   * A-063's relaxation, asked of all three at once: naming the client can only
   * WIDEN the answer, never narrow it. An offer stricter than the write is the
   * defect A-083 closed on the booking panel; this is the shape of it that any
   * of the three could reintroduce.
   */
  it('naming the holder never takes a seat away, on any of the three', async () => {
    const { nadia } = await buildTheRoom();
    const narrowed: string[] = [];
    const widened: string[] = [];
    for (const candidate of CANDIDATES) {
      const strict = await threeAnswers({ ...candidate, holderKey: null });
      const named = await threeAnswers({ ...candidate, holderKey: nadia });
      for (const axis of ['write', 'offer', 'push'] as const) {
        if (strict[axis] && !named[axis]) narrowed.push(`${candidate.label} ${axis}`);
        if (!strict[axis] && named[axis]) widened.push(`${candidate.label} ${axis}`);
      }
    }
    expect(narrowed).toEqual([]);
    // And it DOES widen somewhere, on all three: without this the test above
    // and the agreement tests are all vacuous, because a room where the holder
    // changes nothing agrees with the holder arm deleted from every caller.
    expect(new Set(widened.map((w) => w.split(' ')[1]))).toEqual(new Set(['write', 'offer', 'push']));
  });
});
