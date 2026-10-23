/**
 * W-010 — signatures and rotation (API PRD §8, §9.9), checked between the
 * SENDER's signer and the independent REFERENCE RECEIVER
 * (`scripts/webhook-receiver.ts`), over real HTTP on localhost.
 *
 * The first test is demo checkpoint 3 as an assertion: a desk booking, the
 * same sweep the inline carrier runs, and the receiver printing a verified
 * `appointment.booked`.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '@bookable/core/auth';
import { fromDate, instant, instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { bookAppointment } from '@bookable/db/booking';
import { resetDatabase } from '@bookable/db/testing';
import { TOLERANCE_SECONDS, startReceiver, verifySignature } from '../../../../scripts/webhook-receiver';
import { seedTwoSalons, type Salon } from './testing';
import { ROTATION_OVERLAP_MS, createWebhookEndpoint, rotateWebhookSecret } from './webhook-endpoints';
import { signatureHeader } from './webhook-signature';
import { sweepWebhooks } from './webhooks';

const prisma = new PrismaClient();
let clock = new Date();
const deps = () => ({ prisma, now: () => clock, allowPrivate: true });

let a: Salon;
let dana: string;
let cut: string;
let nth = 0;
const DAYS = ['10', '11', '12', '13', '16', '17'];

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  clock = new Date(); // the receiver checks ±300 s against its own clock, so the sender signs with real time here
  nth = 0;
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
  dana = (await prisma.provider.findFirstOrThrow({ where: { businessId: a.businessId, displayName: 'Dana' } })).id;
  cut = (await prisma.service.findFirstOrThrow({ where: { businessId: a.businessId, name: 'Cut' } })).id;
});

const deskBook = () =>
  bookAppointment(prisma, {
    businessId: a.businessId,
    providerId: dana,
    serviceIds: [cut],
    clientId: null,
    startAt: toDate(instantFromIso(`2099-06-${DAYS[nth++]}T15:00:00Z`)),
    now: toDate(instantFromIso('2099-06-01T15:00:00Z')),
    actor: staffActor(a.ownerId),
    audience: 'staff',
  });

async function receiver(secrets: string[]) {
  const lines: string[] = [];
  const events: Record<string, unknown>[] = [];
  const server = await startReceiver({ port: 0, secrets, log: (l) => lines.push(l), onEvent: (e) => events.push(e) });
  const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  return { url, lines, events, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('end to end with the reference receiver', () => {
  it('DEMO CHECKPOINT 3: a desk booking arrives verified as appointment.booked', async () => {
    const rx = await receiver([]);
    const ep = await createWebhookEndpoint(prisma, { businessId: a.businessId, url: rx.url, allowPrivate: true });
    await rx.close();
    const live = await receiver([ep.secret]);
    await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { url: live.url } });
    try {
      const appt = await deskBook();
      const started = Date.now();
      await sweepWebhooks(deps());
      expect(live.lines).toEqual([expect.stringMatching(new RegExp(`^VERIFIED #\\d+ appointment\\.booked appointment=${appt.id} `))]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({ status: 'succeeded', lastResponseStatus: 200 });
    } finally {
      await live.close();
    }
  });

  it('a wrong secret is refused by the receiver (401), and the sender records the failure', async () => {
    const rx = await receiver(['whsec_not-the-one']);
    try {
      await createWebhookEndpoint(prisma, { businessId: a.businessId, url: rx.url, allowPrivate: true });
      await deskBook();
      await sweepWebhooks(deps());
      expect(rx.lines).toEqual(['REJECTED no signature matches']);
      expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({ status: 'failed', lastResponseStatus: 401 });
    } finally {
      await rx.close();
    }
  });

  it('ROTATION: for 24 h both secrets sign, so a receiver holding either verifies; then only the new one', async () => {
    const oldRx = await receiver([]);
    const ep = await createWebhookEndpoint(prisma, { businessId: a.businessId, url: oldRx.url, allowPrivate: true });
    await oldRx.close();
    const { secret: fresh } = await rotateWebhookSecret(prisma, { businessId: a.businessId, endpointId: ep.id, now: clock });
    expect(fresh).not.toBe(ep.secret);

    for (const [secret, label] of [[ep.secret, 'old'], [fresh, 'new']] as const) {
      const rx = await receiver([secret]);
      try {
        await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { url: rx.url } });
        await deskBook();
        await sweepWebhooks(deps());
        expect(rx.lines, label).toEqual([expect.stringMatching(/^VERIFIED .*appointment\.booked/)]);
      } finally {
        await rx.close();
      }
    }

    // After the overlap the old secret no longer signs: the header carries one v1.
    const after = toDate(instant(fromDate(clock) + ROTATION_OVERLAP_MS + 1));
    const ep2 = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
    expect(ep2.previousSecretExpiresAt!.getTime()).toBe(clock.getTime() + ROTATION_OVERLAP_MS);
    const oldOnly = await receiver([ep.secret]);
    try {
      await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { url: oldOnly.url } });
      await deskBook();
      // Only the header's shape matters here (signed 24 h ahead, the receiver's clock would refuse it anyway).
      const sent: string[] = [];
      const spy = (async (u: string | URL | Request, init?: RequestInit) => {
        sent.push((init!.headers as Record<string, string>)['Bookable-Signature']!);
        return fetch(u, init);
      }) as typeof fetch;
      await sweepWebhooks({ prisma, now: () => after, allowPrivate: true, fetch: spy });
      expect(sent[0]!.match(/v1=/g)).toHaveLength(1);
    } finally {
      await oldOnly.close();
    }
  });

  it('a redelivery of the same event is a duplicate to the receiver, never processed twice', async () => {
    const rx0 = await receiver([]);
    const ep = await createWebhookEndpoint(prisma, { businessId: a.businessId, url: rx0.url, allowPrivate: true });
    await rx0.close();
    const rx = await receiver([ep.secret]);
    try {
      await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { url: rx.url } });
      await deskBook();
      await sweepWebhooks(deps());
      await prisma.webhookDelivery.updateMany({ data: { status: 'pending' } }); // as a stale reclaim would
      await sweepWebhooks(deps());
      expect(rx.events).toHaveLength(1);
      expect(rx.lines[1]).toMatch(/^duplicate .* \(attempt 2\)/);
    } finally {
      await rx.close();
    }
  });
});

describe('verifySignature (the receiver) against signatureHeader (the sender)', () => {
  const body = JSON.stringify({ id: 'ev_1', type: 'appointment.booked' });
  const t = 1_800_000_000;

  it('accepts a genuine signature', () => {
    expect(verifySignature(signatureHeader(['s1'], t, body), body, ['s1'], t)).toEqual({ ok: true, t });
  });

  it('refuses a tampered body, a wrong secret, a missing or malformed header', () => {
    const h = signatureHeader(['s1'], t, body);
    expect(verifySignature(h, body.replace('booked', 'cancelled'), ['s1'], t)).toEqual({ ok: false, why: 'no signature matches' });
    expect(verifySignature(h, body, ['s2'], t)).toEqual({ ok: false, why: 'no signature matches' });
    expect(verifySignature(null, body, ['s1'], t).ok).toBe(false);
    expect(verifySignature('v1=abc', body, ['s1'], t)).toEqual({ ok: false, why: 'malformed Bookable-Signature' });
  });

  it(`refuses a timestamp more than ${TOLERANCE_SECONDS} s old or ahead — a six-minute-old capture is a replay`, () => {
    const h = signatureHeader(['s1'], t, body);
    expect(verifySignature(h, body, ['s1'], t + 360).ok).toBe(false);
    expect(verifySignature(h, body, ['s1'], t - 360).ok).toBe(false);
    expect(verifySignature(h, body, ['s1'], t + TOLERANCE_SECONDS).ok).toBe(true);
  });

  it('the signed timestamp is inside the MAC: moving `t` to dodge the window breaks the signature', () => {
    const h = signatureHeader(['s1'], t, body).replace(`t=${t}`, `t=${t + 360}`);
    expect(verifySignature(h, body, ['s1'], t + 360)).toEqual({ ok: false, why: 'no signature matches' });
  });

  it('during rotation the header carries both signatures and either secret verifies', () => {
    const h = signatureHeader(['new', 'old'], t, body);
    expect(h.match(/v1=/g)).toHaveLength(2);
    expect(verifySignature(h, body, ['old'], t).ok).toBe(true);
    expect(verifySignature(h, body, ['new'], t).ok).toBe(true);
  });
});
