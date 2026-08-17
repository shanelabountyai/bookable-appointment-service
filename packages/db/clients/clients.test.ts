/**
 * A-015 against a real database (CLIENT-01..03, D-17, operator R-10).
 *
 * The spine of this file is the household case D-17 exists for: a mother and
 * her teenage daughter sharing one phone number. Every lookup here has to
 * return both of them, and nothing may quietly decide they are one person.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { DEFAULT_REBOOK_INTERVAL_DAYS } from '../../core/clients';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { transitionAppointment } from '../appointments';
import {
  MergeRefused,
  clientHistory,
  findClient,
  findClientsByPhone,
  mergeClients,
  rebookSuggestion,
  searchClients,
  setClientNotes,
} from './clients';

const prisma = new PrismaClient();
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const STAFF = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const NOW = at('2026-06-08T08:00:00-05:00');

const SHARED_PHONE = '5125550101';

let businessId: string;
let providerId: string;
let otherProviderId: string;
let serviceId: string;
let colourId: string;
let mumId: string;
let daughterId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({
    data: { name: 'Shear Genius', timezone: 'America/Chicago', minimumLeadMinutes: 0, bookingHorizonDays: 365 },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
  providerId = dana.id;
  otherProviderId = priya.id;

  const cut = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, bufferAfterMinutes: 15 },
  });
  const colour = await prisma.service.create({
    data: { businessId, name: 'Colour', durationMinutes: 90, priceCents: 12000, bufferAfterMinutes: 10 },
  });
  serviceId = cut.id;
  colourId = colour.id;
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId: cut.id, providerId: dana.id },
      { businessId, serviceId: colour.id, providerId: dana.id },
      { businessId, serviceId: cut.id, providerId: priya.id },
    ],
  });

  // THE HOUSEHOLD (D-17): one number, two people.
  mumId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: SHARED_PHONE } })).id;
  daughterId = (await prisma.client.create({ data: { businessId, name: 'Mei Chen', phone: SHARED_PHONE } })).id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAFF_WINDOW);
  for (const p of [dana.id, priya.id]) {
    await createWeeklyWindow(prisma, { businessId, providerId: p, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAFF_WINDOW);
  }
});

const book = (over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId: mumId,
    startAt: at('2026-06-09T10:00:00-05:00'),
    now: NOW,
    actor: STAFF,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

describe('CLIENT-01 — lookup returns a LIST (D-17)', () => {
  /** The whole reason `Client.phone` is not unique. */
  it('returns both people who share a household number', async () => {
    const found = await findClientsByPhone(prisma, businessId, SHARED_PHONE);
    expect(found.map((c) => c.name).sort()).toEqual(['Ada Chen', 'Mei Chen']);
  });

  it('finds them however the number was typed', async () => {
    const found = await findClientsByPhone(prisma, businessId, '(512) 555-0101');
    expect(found).toHaveLength(2);
  });

  it('returns nothing for a blank or wordy query rather than everybody', async () => {
    expect(await findClientsByPhone(prisma, businessId, '   ')).toEqual([]);
    expect(await findClientsByPhone(prisma, businessId, 'call the salon')).toEqual([]);
  });

  it('never crosses a business boundary', async () => {
    const other = await prisma.business.create({ data: { name: 'Rival', timezone: 'America/Chicago' } });
    await prisma.client.create({ data: { businessId: other.id, name: 'Someone Else', phone: SHARED_PHONE } });

    const found = await findClientsByPhone(prisma, businessId, SHARED_PHONE);
    expect(found.map((c) => c.name)).not.toContain('Someone Else');
  });

  it('searches on a partial name, case-insensitively', async () => {
    expect((await searchClients(prisma, businessId, 'ada')).map((c) => c.name)).toEqual(['Ada Chen']);
  });

  it('searches on the last few digits of a number', async () => {
    expect(await searchClients(prisma, businessId, '0101')).toHaveLength(2);
  });

  it('does not treat two digits as a phone search', async () => {
    // "51" would otherwise match every number in the salon.
    expect(await searchClients(prisma, businessId, '51')).toEqual([]);
  });
});

describe('CLIENT-03 — the pinned note', () => {
  it('saves and clears', async () => {
    await setClientNotes(prisma, businessId, mumId, '  Allergic to PPD. Bleach only.  ');
    expect((await findClient(prisma, businessId, mumId))?.notes).toBe('Allergic to PPD. Bleach only.');

    await setClientNotes(prisma, businessId, mumId, '   ');
    expect((await findClient(prisma, businessId, mumId))?.notes).toBeNull();
  });

  it('does not write across businesses', async () => {
    const other = await prisma.business.create({ data: { name: 'Rival', timezone: 'America/Chicago' } });
    await setClientNotes(prisma, other.id, mumId, 'should not land');
    expect((await findClient(prisma, businessId, mumId))?.notes).toBeNull();
  });
});

describe('CLIENT-02 — history', () => {
  it('lists date, provider, services, snapshotted price and status', async () => {
    const appointment = await book({ serviceIds: [serviceId, colourId] });

    const [visit] = await clientHistory(prisma, businessId, mumId);
    expect(visit?.appointmentId).toBe(appointment.id);
    expect(visit?.providerName).toBe('Dana');
    expect(visit?.services).toEqual(['Cut', 'Colour']);
    expect(visit?.priceCents).toBe(5500 + 12000);
    expect(visit?.status).toBe('booked');
  });

  /** A history that hides these makes the front desk look unprepared, and it
   *  is the same data CLIENT-04's counter reads. */
  it('includes no-shows and late cancels', async () => {
    const missed = await book();
    await transitionAppointment(prisma, {
      appointmentId: missed.id,
      to: 'no_show',
      actor: STAFF,
      now: at('2026-06-09T10:30:00-05:00'),
    });

    const history = await clientHistory(prisma, businessId, mumId);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe('no_show');
  });

  it('keeps the price she was charged when the catalogue changes (D-18)', async () => {
    await book();
    await prisma.service.update({ where: { id: serviceId }, data: { priceCents: 9900 } });

    expect((await clientHistory(prisma, businessId, mumId))[0]?.priceCents).toBe(5500);
  });

  it('is newest first', async () => {
    await book({ startAt: at('2026-06-09T10:00:00-05:00'), idempotencyKey: 'a' });
    await book({ startAt: at('2026-06-09T14:00:00-05:00'), idempotencyKey: 'b' });

    const history = await clientHistory(prisma, businessId, mumId);
    expect(history[0]!.startAt.getTime()).toBeGreaterThan(history[1]!.startAt.getTime());
  });

  it('does not show the daughter’s visits on the mother’s record', async () => {
    await book({ clientId: daughterId });
    expect(await clientHistory(prisma, businessId, mumId)).toEqual([]);
  });
});

describe('CLIENT-01 — merge (operator R-10)', () => {
  it('moves the history to the survivor', async () => {
    const appointment = await book({ clientId: daughterId });

    const result = await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });

    expect(result.appointmentsMoved).toBe(1);
    expect((await clientHistory(prisma, businessId, mumId))[0]?.appointmentId).toBe(appointment.id);
  });

  it('moves waitlist entries too, so an offer still reaches her', async () => {
    await prisma.waitlistEntry.create({
      data: { businessId, clientId: daughterId, serviceId, fromDay: '2026-06-09', toDay: '2026-06-30', dayParts: [] },
    });

    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });

    expect(await prisma.waitlistEntry.count({ where: { clientId: mumId } })).toBe(1);
  });

  /**
   * THE ONE FAILURE HERE THAT HURTS SOMEBODY. A merge that dropped the losing
   * record's note because the survivor already had one would silently delete
   * "allergic to PPD" — CLIENT-03 calls the note a safety surface, and this is
   * what that means in code.
   */
  it('keeps BOTH notes, never replacing one with the other', async () => {
    await setClientNotes(prisma, businessId, mumId, 'Prefers the 2pm chair.');
    await setClientNotes(prisma, businessId, daughterId, 'Allergic to PPD.');

    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });

    const survivor = await findClient(prisma, businessId, mumId);
    expect(survivor?.notes).toContain('Prefers the 2pm chair.');
    expect(survivor?.notes).toContain('Allergic to PPD.');
  });

  it('fills the survivor’s GAPS but never overwrites what it has', async () => {
    await prisma.client.update({ where: { id: mumId }, data: { email: null } });
    await prisma.client.update({
      where: { id: daughterId },
      data: { email: 'mei@example.test', phone: '5125559999' },
    });

    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });

    const survivor = await prisma.client.findUniqueOrThrow({ where: { id: mumId } });
    expect(survivor.email).toBe('mei@example.test');
    // The survivor is the record staff CHOSE — moving her to the number they
    // just called the old one would undo the decision.
    expect(survivor.phone).toBe(SHARED_PHONE);
  });

  /** R-10, the whole point of the tombstone. */
  it('keeps the losing record so its phone still finds the survivor', async () => {
    await prisma.client.update({ where: { id: daughterId }, data: { phone: '5125559999' } });

    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });

    const found = await findClientsByPhone(prisma, businessId, '5125559999');
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(mumId);
    // And the screen can say so, rather than the front desk wondering why the
    // name changed.
    expect(found[0]?.reachedByOldNumber).toBe(true);
  });

  it('does not list the tombstone as a second person on the shared number', async () => {
    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });

    const found = await findClientsByPhone(prisma, businessId, SHARED_PHONE);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(mumId);
  });

  /**
   * Chain flattening. A→B, then B→C: A must end up pointing at C, so
   * resolution is one hop forever and no recursive read — or cycle — exists.
   */
  it('re-points older tombstones when the survivor is itself merged away', async () => {
    const third = await prisma.client.create({
      data: { businessId, name: 'Ada Chen-Marsh', phone: '5125550202' },
    });

    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });
    const second = await mergeClients(prisma, { businessId, survivorId: third.id, losingId: mumId });

    expect(second.tombstonesRepointed).toBe(1);
    const viaDaughter = await prisma.client.findUniqueOrThrow({ where: { id: daughterId } });
    expect(viaDaughter.mergedIntoClientId).toBe(third.id);

    // And the original number still finds the person, two merges later.
    const found = await findClientsByPhone(prisma, businessId, SHARED_PHONE);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(third.id);
  });

  it('refuses to merge a record into itself', async () => {
    await expect(mergeClients(prisma, { businessId, survivorId: mumId, losingId: mumId })).rejects.toBeInstanceOf(
      MergeRefused,
    );
  });

  it('refuses to merge one that has already been merged', async () => {
    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });
    await expect(
      mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId }),
    ).rejects.toBeInstanceOf(MergeRefused);
  });

  it('refuses to merge INTO a record that has been merged away', async () => {
    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });
    const third = await prisma.client.create({ data: { businessId, name: 'Someone', phone: '5125550303' } });

    await expect(
      mergeClients(prisma, { businessId, survivorId: daughterId, losingId: third.id }),
    ).rejects.toBeInstanceOf(MergeRefused);
  });

  it('refuses across businesses', async () => {
    const other = await prisma.business.create({ data: { name: 'Rival', timezone: 'America/Chicago' } });
    const theirs = await prisma.client.create({ data: { businessId: other.id, name: 'Theirs', phone: '5125550404' } });

    await expect(
      mergeClients(prisma, { businessId, survivorId: mumId, losingId: theirs.id }),
    ).rejects.toBeInstanceOf(MergeRefused);
  });

  it('leaves everything alone when it refuses', async () => {
    await book({ clientId: daughterId });
    await expect(
      mergeClients(prisma, { businessId, survivorId: daughterId, losingId: daughterId }),
    ).rejects.toBeInstanceOf(MergeRefused);

    expect(await clientHistory(prisma, businessId, daughterId)).toHaveLength(1);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: daughterId } })).mergedIntoClientId).toBeNull();
  });
});

describe('CLIENT-02 — rebook last visit', () => {
  const TODAY = '2026-06-10';

  it('prefills the provider and the services of the last visit', async () => {
    await book({ serviceIds: [serviceId, colourId] });

    const suggestion = await rebookSuggestion(prisma, businessId, mumId, TODAY);
    expect(suggestion?.providerName).toBe('Dana');
    expect(suggestion?.serviceNames).toEqual(['Cut', 'Colour']);
  });

  it('jumps to her own interval when she has a rhythm', async () => {
    // Two visits six weeks apart: 28 April and 9 June.
    await prisma.appointment.create({
      data: {
        businessId,
        providerId,
        clientId: mumId,
        startAt: at('2026-04-28T10:00:00-05:00'),
        endAt: at('2026-04-28T11:00:00-05:00'),
        blockedStart: at('2026-04-28T10:00:00-05:00'),
        blockedEnd: at('2026-04-28T11:00:00-05:00'),
        startDay: '2026-04-28',
        startWallTime: '10:00',
        status: 'completed',
        lines: { create: { businessId, serviceId, ordinal: 0, priceCents: 5500, durationMinutes: 60 } },
      },
    });
    await book();

    const suggestion = await rebookSuggestion(prisma, businessId, mumId, TODAY);
    expect(suggestion?.intervalDays).toBe(42);
    expect(suggestion?.fromDay).toBe('2026-07-21'); // 9 June + 42 days
  });

  it('uses the default interval for a first-time client', async () => {
    await book();
    const suggestion = await rebookSuggestion(prisma, businessId, mumId, TODAY);
    expect(suggestion?.intervalDays).toBe(DEFAULT_REBOOK_INTERVAL_DAYS);
  });

  it('never suggests a day in the past', async () => {
    await book();
    // She last came in June; "today" is a year later.
    const suggestion = await rebookSuggestion(prisma, businessId, mumId, '2027-06-10');
    expect(suggestion?.fromDay).toBe('2027-06-10');
  });

  /**
   * A cancelled appointment is not a visit — suggesting "the same as last
   * time" from one she cancelled would rebook a service she may have cancelled
   * precisely because she did not want it.
   *
   * The cancelled one is deliberately the LATER of the two. An earlier one
   * proves nothing: `ORDER BY startAt DESC` would pick the kept visit anyway,
   * and the test would pass with the status filter deleted. It did, until
   * mutation testing said so.
   */
  it('ignores cancelled appointments even when the cancelled one is the most recent', async () => {
    await book({ idempotencyKey: 'kept' }); // 10:00, Dana
    const cancelled = await book({
      providerId: otherProviderId,
      startAt: at('2026-06-09T14:00:00-05:00'),
      idempotencyKey: 'cancel-me',
    }); // 14:00, Priya — later
    await prisma.appointment.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } });

    expect((await rebookSuggestion(prisma, businessId, mumId, TODAY))?.providerName).toBe('Dana');
  });

  it('returns nothing for a client who has never been in', async () => {
    expect(await rebookSuggestion(prisma, businessId, daughterId, TODAY)).toBeNull();
  });
});
