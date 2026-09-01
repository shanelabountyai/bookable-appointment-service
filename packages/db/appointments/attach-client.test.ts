/**
 * A-068 — WHO WAS THIS? (BOOK-04, CLIENT-01, D-17), against a real database.
 *
 * Two weekly cases, and the second one is why this is a correctness item
 * rather than a convenience: the desk picks the wrong Sarah Jones, finds out
 * at check-in, and the only correction available was cancel-and-rebook — which
 * since A-060 derives `cancelled_late`, putting a late cancellation on an
 * innocent client's twelve-month count for the desk's own typo.
 *
 * The chair tests are the mirror of A-063's. A walk-in holds `appt:<id>` and
 * is therefore a STRANGER to her own next appointment, so the room seats them
 * separately; naming her makes them one holder, and a fix that only wrote
 * `clientId` would leave one body in two of four chairs — the exact defect
 * A-063 exists to prevent, arriving through the door this item opens.
 */
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { NoResourceFree, bookAppointment } from '../booking';
import { clientReliability } from '../clients';
import { ClientAlreadyChanged, ClientNotAttachable, setAppointmentClient } from './attach-client';
import { transitionAppointment } from './transition';

const prisma = new PrismaClient();
const STAFF = staffActor('staff-1');
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };

const at = (iso: string) => toDate(instantFromIso(iso));

// Tuesday 9 June 2026, Chicago.
const NOW = at('2026-06-08T08:00:00-05:00');
const TEN_AM = at('2026-06-09T10:00:00-05:00');

let businessId: string;
let danaId: string;
let priyaId: string;
let cutId: string;
let colourId: string;
let sarahId: string;
let otherSarahId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({
    data: {
      name: 'Shear Genius',
      timezone: 'America/Chicago',
      slotIntervalMinutes: 15,
      minimumLeadMinutes: 0,
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  danaId = (await prisma.provider.create({ data: { businessId, displayName: 'Dana' } })).id;
  priyaId = (await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } })).id;

  // UNEQUAL BUFFERS on purpose (CLAUDE.md): the chair tests below turn on
  // whose buffer meets whose, and equal ones hide that.
  cutId = (
    await prisma.service.create({
      data: {
        businessId,
        name: 'Cut',
        durationMinutes: 45,
        priceCents: 5500,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 15,
      },
    })
  ).id;
  colourId = (
    await prisma.service.create({
      data: {
        businessId,
        name: 'Colour',
        durationMinutes: 60,
        priceCents: 12000,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 5,
      },
    })
  ).id;
  await prisma.serviceProvider.createMany({
    data: [danaId, priyaId].flatMap((providerId) =>
      [cutId, colourId].map((serviceId) => ({ businessId, serviceId, providerId })),
    ),
  });

  // D-17's guarantee, made concrete: two of them, and the desk picks wrong.
  sarahId = (await prisma.client.create({ data: { businessId, name: 'Sarah Jones', phone: '5125550101' } })).id;
  otherSarahId = (
    await prisma.client.create({ data: { businessId, name: 'Sarah Jones', phone: '5125550202' } })
  ).id;

  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
    STAFF_WINDOW,
  );
  for (const providerId of [danaId, priyaId]) {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
      STAFF_WINDOW,
    );
  }
});

const book = (over: Record<string, unknown> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [cutId],
    clientId: null,
    startAt: TEN_AM,
    now: NOW,
    actor: STAFF,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

const set = (appointmentId: string, clientId: string | null, reason: string | null = null) =>
  setAppointmentClient(prisma, { businessId, appointmentId, clientId, actor: STAFF, reason });

/**
 * Blocks until `count` transactions are waiting on a row lock held elsewhere.
 *
 * `pg_locks.granted = false` IS the happens-before edge, exactly as in
 * `reschedule.test.ts` — the only difference is the lock type, because this
 * file's guard is the conditional `UPDATE` itself rather than an advisory lock
 * it takes first. Polling a real database condition, never a timer: a `sleep`
 * here would reintroduce the flakiness the barrier exists to remove, and
 * CLAUDE.md is explicit that a flaky race test is a broken race test.
 */
async function waitForRowLockWaiters(client: PgClient, count: number): Promise<void> {
  for (;;) {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype IN ('tuple','transactionid') AND NOT granted`,
    );
    if (Number(rows[0]?.n ?? 0) >= count) return;
  }
}

const eventsOf = (appointmentId: string) =>
  prisma.appointmentEvent.findMany({ where: { appointmentId, type: 'client_changed' } });

describe('the walk-in who rebooks at the till (BOOK-04)', () => {
  it('attaches a client to an appointment booked as nothing but a time', async () => {
    const appointment = await book();
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).clientId).toBeNull();

    const changed = await set(appointment.id, sarahId, 'Rebooked at the till');

    expect(changed.kind).toBe('attached');
    expect(changed.from).toBeNull();
    expect(changed.to).toMatchObject({ id: sarahId, name: 'Sarah Jones' });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).clientId).toBe(sarahId);
  });

  /** The row survives, so the log is the only record that it ever named
   *  anybody else — the whole audit trail for "why is there a no-show on my
   *  client's record". */
  it('writes one event naming BOTH sides, with the reason', async () => {
    const appointment = await book({ clientId: sarahId });
    await set(appointment.id, otherSarahId, 'Wrong Sarah — caught at check-in');

    const [event, ...rest] = await eventsOf(appointment.id);

    expect(rest).toHaveLength(0);
    expect(event!.reason).toBe('Wrong Sarah — caught at check-in');
    expect(event!.payload).toMatchObject({
      fromClientId: sarahId,
      fromClientName: 'Sarah Jones',
      toClientId: otherSarahId,
      kind: 'changed',
    });
  });

  /** THE WHOLE POINT OF CASE (b). Every workaround the desk had wrote one of
   *  these, on a client who did nothing wrong. */
  it('never writes a cancellation of any kind, and never sends anything', async () => {
    const appointment = await book({ clientId: sarahId });
    // The BOOKING's own confirmation is already sitting here; what must not
    // move is the count ACROSS the correction. Asserting zero would pass for
    // the wrong reason on a walk-in, who is never sent anything anyway.
    const sent = await prisma.notificationOutbox.count();

    await set(appointment.id, otherSarahId);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.status).toBe('booked');
    expect(await prisma.appointment.count({ where: { status: { in: ['cancelled', 'cancelled_late'] } } })).toBe(0);
    // A correction is not news. A-059 and A-061 assert the same thing about
    // the marks they write, for the same reason — and the wrong Sarah must
    // certainly not be told her appointment changed.
    expect(await prisma.notificationOutbox.count()).toBe(sent);
  });

  it('detaches — "that wasn\'t her" is the same write with no client', async () => {
    const appointment = await book({ clientId: sarahId });

    const changed = await set(appointment.id, null);

    expect(changed.kind).toBe('detached');
    expect(changed.to).toBeNull();
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).clientId).toBeNull();
  });

  it('refuses to write an event saying nothing happened', async () => {
    const appointment = await book({ clientId: sarahId });

    await expect(set(appointment.id, sarahId)).rejects.toBeInstanceOf(ClientNotAttachable);
    expect(await eventsOf(appointment.id)).toHaveLength(0);
  });

  it('refuses a client from another business, and a merged-away record', async () => {
    const appointment = await book();
    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
    const stranger = await prisma.client.create({ data: { businessId: other.id, name: 'Nobody' } });
    await prisma.client.update({ where: { id: otherSarahId }, data: { mergedIntoClientId: sarahId } });

    await expect(set(appointment.id, stranger.id)).rejects.toBeInstanceOf(ClientNotAttachable);
    // Following the merge silently would be the product deciding which Sarah
    // Jones this was — the one question the desk is here to answer.
    await expect(set(appointment.id, otherSarahId)).rejects.toBeInstanceOf(ClientNotAttachable);
  });

  /**
   * TWO STATIONS, ONE WALK-IN. Both read a null client and both try to name
   * her; the second `UPDATE` blocks on the row lock, re-evaluates its `WHERE`
   * against the committed row and matches nothing.
   *
   * No advisory lock and none needed — unlike a move, which has to serialize
   * against the destination as well. The conditional write IS the mechanism
   * here, which is why the test asserts the ROW and the LOG agree afterwards
   * rather than only that one call failed.
   */
  it('refuses the second of two desks naming the same walk-in', async () => {
    const appointment = await book();

    const holder = new PgClient({ connectionString: process.env.DATABASE_URL });
    await holder.connect();

    let results: PromiseSettledResult<unknown>[];
    try {
      await holder.query('BEGIN');
      // Both calls will read the null client freely (MVCC) and then queue
      // behind this on their `UPDATE`. Without it they simply run in
      // sequence and the second one legitimately succeeds as a CHANGE — which
      // is right, and is not the race being asserted.
      await holder.query('SELECT 1 FROM "Appointment" WHERE id = $1 FOR UPDATE', [appointment.id]);

      const pending = Promise.allSettled([set(appointment.id, sarahId), set(appointment.id, otherSarahId)]);
      await waitForRowLockWaiters(holder, 2);
      await holder.query('COMMIT');

      results = await pending;
    } finally {
      await holder.end();
    }

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')?.reason).toBeInstanceOf(ClientAlreadyChanged);

    // Exactly one write happened, and the log agrees with the row.
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    const events = await eventsOf(appointment.id);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { toClientId: string }).toClientId).toBe(row.clientId);
  });
});

describe('the record it moves (CLIENT-04)', () => {
  /** "She was a no-show and it turns out she is Mrs Kerr" is a real
   *  correction, and the count moving IS the reason to want it. */
  it('moves a past no-show onto the client it is attached to', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'no_show',
      now: at('2026-06-09T10:30:00-05:00'),
      actor: STAFF,
    });

    const before = await clientReliability(prisma, {
      businessId,
      clientIds: [sarahId],
      today: '2026-06-10',
    });
    expect(before.get(sarahId)!.noShows).toBe(0);

    await set(appointment.id, sarahId);

    const after = await clientReliability(prisma, { businessId, clientIds: [sarahId], today: '2026-06-10' });
    expect(after.get(sarahId)!.noShows).toBe(1);
  });

  /** The mirror, and the more valuable half: taking a wrongly-attributed
   *  no-show BACK OFF a client who was never involved. A status guard that
   *  excluded terminal rows would have closed this door. */
  it('takes a no-show off a client it was never hers', async () => {
    const appointment = await book({ clientId: sarahId });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'no_show',
      now: at('2026-06-09T10:30:00-05:00'),
      actor: STAFF,
    });
    expect(
      (await clientReliability(prisma, { businessId, clientIds: [sarahId], today: '2026-06-10' })).get(sarahId)!
        .noShows,
    ).toBe(1);

    await set(appointment.id, otherSarahId, 'Wrong Sarah');

    expect(
      (await clientReliability(prisma, { businessId, clientIds: [sarahId], today: '2026-06-10' })).get(sarahId)!
        .noShows,
    ).toBe(0);
    expect(
      (await clientReliability(prisma, { businessId, clientIds: [otherSarahId], today: '2026-06-10' })).get(
        otherSarahId,
      )!.noShows,
    ).toBe(1);
  });
});

/**
 * THE MIRROR OF A-063. Two chairs, and a client whose own two visits are
 * SEQUENTIAL with their buffers overlapping — Cut with Dana 10:00–10:45
 * (envelope to 11:00) then Colour with Priya 11:00–12:00 (envelope from
 * 10:50). Twenty… ten minutes of overlapping envelope, no overlapping body.
 */
describe('the chair the correction moves her into (A-063, RES-02)', () => {
  let chairs: string[];

  beforeEach(async () => {
    const type = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
    chairs = [];
    for (const name of ['Chair 1', 'Chair 2']) {
      chairs.push((await prisma.resource.create({ data: { businessId, resourceTypeId: type.id, name } })).id);
    }
    await prisma.service.updateMany({ where: { businessId }, data: { requiredResourceTypeId: type.id } });
  });

  const chairOf = async (appointmentId: string) =>
    (await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).resourceId;

  /** Her named visit, and the walk-in beside it that the room could not know
   *  was the same person. */
  async function pair() {
    const named = await book({ clientId: sarahId });
    const walkIn = await book({
      providerId: priyaId,
      serviceIds: [colourId],
      startAt: at('2026-06-09T11:00:00-05:00'),
    });
    return { named, walkIn };
  }

  it('seats a nameless walk-in in a SECOND chair — two strangers, two chairs', async () => {
    const { named, walkIn } = await pair();

    expect(await chairOf(named.id)).not.toBe(await chairOf(walkIn.id));
  });

  /** THE ROW'S OWN TEST. One body, one chair — and it takes an ordinary row
   *  UPDATE plus the re-pick, because writing `clientId` alone would leave her
   *  holding two of the four chairs for ten minutes. */
  it('collapses the walk-in onto her own chair the moment she is named', async () => {
    const { named, walkIn } = await pair();

    await set(walkIn.id, sarahId);

    expect(await chairOf(walkIn.id)).toBe(await chairOf(named.id));
    // The trigger is the only writer of a hold, so this is the room's own
    // answer rather than a restatement of the column above.
    const holds = await prisma.appointmentResourceHold.findMany({
      where: { appointmentId: { in: [named.id, walkIn.id] } },
      select: { resourceId: true, holderKey: true },
    });
    expect(new Set(holds.map((h) => h.resourceId)).size).toBe(1);
    expect(new Set(holds.map((h) => h.holderKey))).toEqual(new Set([sarahId]));
  });

  /** The opposite direction, and the arm that can genuinely refuse: taking her
   *  off one of two visits that were legally SHARING a chair needs a second
   *  one, because they are two holders again. */
  it('moves her to another chair when detaching splits a shared one', async () => {
    const { named, walkIn } = await pair();
    await set(walkIn.id, sarahId);
    expect(await chairOf(walkIn.id)).toBe(await chairOf(named.id));

    await set(walkIn.id, null);

    expect(await chairOf(walkIn.id)).not.toBe(await chairOf(named.id));
  });

  it('refuses, naming the room, when the split has nowhere to go', async () => {
    const { named, walkIn } = await pair();
    await set(walkIn.id, sarahId);
    const held = await chairOf(named.id);
    const spare = chairs.find((id) => id !== held);
    await prisma.resource.update({ where: { id: spare! }, data: { active: false } });

    await expect(set(walkIn.id, null)).rejects.toBeInstanceOf(NoResourceFree);
    // …and nothing was written: the refusal is inside the transaction.
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: walkIn.id } })).clientId).toBe(sarahId);
    expect(await eventsOf(walkIn.id)).toHaveLength(1);
  });
});
