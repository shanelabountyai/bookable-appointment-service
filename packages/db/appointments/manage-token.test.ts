/**
 * A-013 — the manage token against a real database (TOKEN-01..03, D-5).
 *
 * The interesting assertions here are all NEGATIVE — revoked, expired,
 * foreign, superseded — because every one of them is a way a link keeps
 * working when it should not, and none of them is visible from the happy path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate } from '../../core/time';
import { MANAGE_TOKEN_GRACE_MS, hashManageToken } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { issueManageToken, repointManageTokens, revokeManageTokens, verifyManageToken } from './manage-token';

const prisma = new PrismaClient();

const at = (iso: string) => toDate(instantFromIso(iso));
/** Physical milliseconds after an instant, through the one conversion module. */
const after = (base: Date, ms: number) => toDate(instant(fromDate(base) + ms));
const NOW = at('2026-06-09T08:00:00-05:00');
const START = at('2026-06-09T10:00:00-05:00');
const END = at('2026-06-09T11:00:00-05:00');

let businessId: string;
let appointmentId: string;
let otherAppointmentId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({ data: { name: 'Shear Genius', timezone: 'America/Chicago' } });
  businessId = business.id;
  const provider = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });

  // Written directly: this file is about the token, and routing every fixture
  // through the booking write path would make a slot-engine change break it.
  const make = async (startAt: Date, endAt: Date) =>
    (
      await prisma.appointment.create({
        data: {
          businessId,
          providerId: provider.id,
          startAt,
          endAt,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: '2026-06-09',
          startWallTime: '10:00',
        },
        select: { id: true },
      })
    ).id;

  appointmentId = await make(START, END);
  otherAppointmentId = await make(at('2026-06-09T14:00:00-05:00'), at('2026-06-09T15:00:00-05:00'));
});

const issue = (id = appointmentId, endAt = END) =>
  issueManageToken(prisma, { businessId, appointmentId: id, endAt, now: NOW });

describe('issuing (TOKEN-01)', () => {
  it('stores only the hash — the raw token is never in the database', async () => {
    const { token } = await issue();
    const rows = await prisma.manageToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashManageToken(token));
    // The one assertion that a leaked dump is not a folder of live links.
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('expires at end + 24h', async () => {
    const { expiresAt } = await issue();
    expect(expiresAt.getTime() - END.getTime()).toBe(MANAGE_TOKEN_GRACE_MS);
  });

  it('is MULTI-USE — verifying does not consume it (D-5)', async () => {
    const { token } = await issue();
    // Confirm-then-later-cancel is the ordinary workflow. A single-use token
    // fails on step two of every appointment, which is why D-5 rejected it.
    for (let i = 0; i < 5; i++) {
      expect(await verifyManageToken(prisma, token, NOW)).not.toBeNull();
    }
  });
});

describe('scope (TOKEN-01)', () => {
  it('grants exactly one appointment', async () => {
    const grant = await verifyManageToken(prisma, (await issue()).token, NOW);
    expect(grant?.appointmentId).toBe(appointmentId);
  });

  it('does not reach the customer’s other appointment', async () => {
    const mine = await issue();
    const theirs = await issue(otherAppointmentId, at('2026-06-09T15:00:00-05:00'));

    expect((await verifyManageToken(prisma, mine.token, NOW))?.appointmentId).toBe(appointmentId);
    expect((await verifyManageToken(prisma, theirs.token, NOW))?.appointmentId).toBe(otherAppointmentId);
  });

  it('refuses a token that was never issued', async () => {
    expect(await verifyManageToken(prisma, 'not-a-real-token', NOW)).toBeNull();
  });
});

describe('revoke on reissue (D-5)', () => {
  it('kills the previous link when a new one is issued', async () => {
    const first = await issue();
    const second = await issue();

    // The whole point: a corrected phone number gets a new link, and the
    // message sent to the WRONG number stops working.
    expect(await verifyManageToken(prisma, first.token, NOW)).toBeNull();
    expect(await verifyManageToken(prisma, second.token, NOW)).not.toBeNull();
  });

  it('revokes only this appointment’s links', async () => {
    const other = await issue(otherAppointmentId, at('2026-06-09T15:00:00-05:00'));
    await issue();
    expect(await verifyManageToken(prisma, other.token, NOW)).not.toBeNull();
  });

  it('keeps the original revocation time when revoked twice', async () => {
    const { token } = await issue();
    const later = at('2026-06-09T09:00:00-05:00');
    await revokeManageTokens(prisma, appointmentId, NOW);
    await revokeManageTokens(prisma, appointmentId, later);

    const row = await prisma.manageToken.findUniqueOrThrow({ where: { tokenHash: hashManageToken(token) } });
    expect(row.revokedAt?.toISOString()).toBe(NOW.toISOString());
  });
});

describe('expiry (D-5)', () => {
  const justBefore = after(END, MANAGE_TOKEN_GRACE_MS - 1);
  const exactly = after(END, MANAGE_TOKEN_GRACE_MS);

  it('still works the morning after the appointment', async () => {
    const { token } = await issue();
    expect(await verifyManageToken(prisma, token, justBefore)).not.toBeNull();
  });

  it('is dead exactly ON the expiry, not a millisecond later', async () => {
    const { token } = await issue();
    expect(await verifyManageToken(prisma, token, exactly)).toBeNull();
  });
});

describe('re-pointing (TOKEN-02)', () => {
  it('moves the expiry with the appointment, keeping the SAME link alive', async () => {
    const { token } = await issue();
    const movedTo = at('2026-06-12T16:00:00-05:00');

    await repointManageTokens(prisma, appointmentId, movedTo);

    // The link in the customer's original message — the one she will open to
    // cancel — must survive the reschedule she just made with it.
    const stillGood = after(movedTo, MANAGE_TOKEN_GRACE_MS - 1);
    expect(await verifyManageToken(prisma, token, stillGood)).not.toBeNull();
    // And it now outlives the OLD expiry rather than dying at it.
    expect(await verifyManageToken(prisma, token, after(END, MANAGE_TOKEN_GRACE_MS))).not.toBeNull();
  });

  it('does not resurrect a revoked link', async () => {
    const { token } = await issue();
    await revokeManageTokens(prisma, appointmentId, NOW);
    await repointManageTokens(prisma, appointmentId, at('2026-06-12T16:00:00-05:00'));
    expect(await verifyManageToken(prisma, token, NOW)).toBeNull();
  });
});
